const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 8080;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = ["admin", "administrator", "support", "moderator", "system", "official", "guest"];
const TIERS = [["BRONZE", 0], ["SILVER", 100], ["GOLD", 250], ["PLATINUM", 450], ["DIAMOND", 700], ["HEROIC", 1000], ["GRANDMASTER", 1400]];
const rooms = new Map();
const online = new Map();
const parties = new Map();
const invites = new Map();
let partySeq = 1;

let db = null;
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  db = admin.database();
} catch (e) {
  console.log("FIREBASE SETUP ERROR:", e.message);
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function genCode() {
  for (let k = 0; k < 50; k++) {
    let c = "";
    for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function other(ws) {
  const room = rooms.get(ws.room);
  if (!room) return null;
  return ws === room.host ? room.guest : room.host;
}

function leave(ws) {
  const room = rooms.get(ws.room);
  ws.room = null;
  if (!room) return;
  if (ws === room.host) {
    send(room.guest, { t: "left" });
    rooms.delete(room.code);
  } else if (ws === room.guest) {
    if (room.started) {
      send(room.host, { t: "left" });
      rooms.delete(room.code);
    } else {
      room.guest = null;
      room.guestName = "";
      send(room.host, { t: "guest_left" });
    }
  }
}

// ---------- PROFILE / REWARDS ----------
function levelOf(xp) {
  return 1 + Math.floor(Math.sqrt(Math.max(xp, 0) / 60));
}

function tierOf(rp) {
  let name = TIERS[0][0];
  for (const t of TIERS) if (rp >= t[1]) name = t[0];
  return name;
}

function profileOf(u) {
  return {
    coins: u.coins || 0, gems: u.gems || 0, xp: u.xp || 0, rp: u.rp || 0,
    matches: u.matches || 0, wins: u.wins || 0, kills: u.kills || 0, best: u.best || 0,
    skin: u.skin || "default",
  };
}

async function doMatchEnd(ws, m) {
  if (!db || !ws.uid || !ws.username) return;
  const mid = String(m.mid || "").slice(0, 24);
  const rank = Math.max(1, Math.min(40, Math.floor(Number(m.rank)) || 40));
  const kills = Math.max(0, Math.min(40, Math.floor(Number(m.kills)) || 0));
  const win = rank === 1 && !!m.win;
  const dur = Math.max(0, Math.min(3600, Math.floor(Number(m.dur)) || 0));
  const ref = db.ref("users/" + ws.uid);
  const u = (await ref.once("value")).val() || {};
  const old = profileOf(u);
  if (!mid || u.lastMid === mid) return send(ws, { t: "reward", dup: true, profile: old });
  if (dur < 20) {
    await ref.update({ lastMid: mid });
    return send(ws, { t: "reward", coins: 0, xp: 0, rp: 0, level_up: false, tier_up: false, profile: old });
  }
  const coins = 20 + kills * 10 + (win ? 100 : 0) + Math.max(0, 20 - rank) * 2;
  const xp = 30 + kills * 20 + (win ? 150 : 0) + Math.floor(dur / 60) * 10;
  let rpGain = kills * 2;
  if (rank === 1) rpGain += 40;
  else if (rank <= 5) rpGain += 25;
  else if (rank <= 10) rpGain += 15;
  else if (rank <= 20) rpGain += 5;
  else if (rank > 30) rpGain -= 8;
  const newRp = Math.max(0, old.rp + rpGain);
  const levelUp = levelOf(old.xp + xp) > levelOf(old.xp);
  const gemBonus = levelUp ? 10 : 0;
  const upd = {
    coins: old.coins + coins, gems: old.gems + gemBonus, xp: old.xp + xp, rp: newRp,
    matches: old.matches + 1, wins: old.wins + (win ? 1 : 0), kills: old.kills + kills,
    best: old.best ? Math.min(old.best, rank) : rank, lastMid: mid,
  };
  await ref.update(upd);
  await addMissionProgress(ws.uid, { matches: 1, kills, wins: win ? 1 : 0, top10: rank <= 10 ? 1 : 0, minutes: Math.floor(dur / 60) });
  send(ws, {
    t: "reward", coins, xp, rp: rpGain, level_up: levelUp, tier_up: tierOf(newRp) !== tierOf(old.rp),
    profile: profileOf({ ...u, ...upd }),
  });
}

// ---------- PARTY ----------
function partyOf(ws) {
  return ws.party ? parties.get(ws.party) : null;
}

function partyMsg(p) {
  const names = p.members.map((u) => { const w = online.get(u); return w ? w.username : ""; });
  const skins = p.members.map((u) => { const w = online.get(u); return w && w.skin ? w.skin : "default"; });
  const lw = online.get(p.leader);
  return { t: "pt_state", leader: lw ? lw.username : "", members: names, skins };
}

function broadcastParty(p) {
  const msg = partyMsg(p);
  for (const u of p.members) send(online.get(u), msg);
}

function removeFromParty(ws, reason) {
  if (!ws.party) return;
  const p = parties.get(ws.party);
  ws.party = null;
  send(ws, reason ? { t: reason } : { t: "pt_state", leader: "", members: [], skins: [] });
  if (!p) return;
  p.members = p.members.filter((u) => u !== ws.uid);
  if (p.members.length <= 1) {
    for (const u of p.members) {
      const w = online.get(u);
      if (w) { w.party = null; send(w, { t: "pt_state", leader: "", members: [], skins: [] }); }
    }
    parties.delete(p.id);
    return;
  }
  if (p.leader === ws.uid) p.leader = p.members[0];
  broadcastParty(p);
}

function findFriendUid(ws, uname) {
  const l = String(uname || "").toLowerCase();
  if (!ws.friends) return null;
  for (const [fuid, fname] of ws.friends) {
    if (String(fname).toLowerCase() === l) return fuid;
  }
  return null;
}

function ptInvite(ws, uname) {
  const reply = (ok, m) => send(ws, { t: "pt_result", a: "invite", ok, m, username: String(uname || "") });
  const fuid = findFriendUid(ws, uname);
  if (!fuid) return reply(false, "not_friend");
  const tws = online.get(fuid);
  if (!tws) return reply(false, "offline");
  const p = partyOf(ws);
  if (p && p.leader !== ws.uid) return reply(false, "not_leader");
  if (p && p.members.length >= 4) return reply(false, "full");
  if (p && p.members.includes(fuid)) return reply(false, "already_in");
  invites.set(fuid, { from: ws.uid, time: Date.now() });
  send(tws, { t: "pt_invite", from: ws.username });
  reply(true, "sent");
}

function ptAccept(ws) {
  const inv = invites.get(ws.uid);
  invites.delete(ws.uid);
  const fail = (m) => send(ws, { t: "pt_result", a: "accept", ok: false, m, username: "" });
  if (!inv || Date.now() - inv.time > 60000) return fail("expired");
  const lws = online.get(inv.from);
  if (!lws) return fail("offline");
  if (ws.party) removeFromParty(ws);
  let p = partyOf(lws);
  if (!p) {
    p = { id: partySeq++, leader: lws.uid, members: [lws.uid], matchStart: 0 };
    parties.set(p.id, p);
    lws.party = p.id;
  }
  if (p.members.length >= 4) return fail("full");
  p.members.push(ws.uid);
  ws.party = p.id;
  broadcastParty(p);
  send(lws, { t: "pt_result", a: "joined", ok: true, m: "joined", username: ws.username });
}

function ptDecline(ws) {
  const inv = invites.get(ws.uid);
  invites.delete(ws.uid);
  if (!inv) return;
  send(online.get(inv.from), { t: "pt_result", a: "declined", ok: true, m: "declined", username: ws.username });
}

function ptKick(ws, uname) {
  const p = partyOf(ws);
  if (!p || p.leader !== ws.uid) return;
  const l = String(uname || "").toLowerCase();
  for (const u of p.members) {
    const w = online.get(u);
    if (w && u !== ws.uid && w.username.toLowerCase() === l) {
      removeFromParty(w, "pt_kicked");
      return;
    }
  }
}

function ptEmote(ws, clip) {
  const p = partyOf(ws);
  if (!p) return;
  const msg = { t: "p_emote", username: ws.username, clip: String(clip || "").slice(0, 32) };
  for (const u of p.members) {
    if (u !== ws.uid) send(online.get(u), msg);
  }
}

// ---------- SQUAD MATCH ----------
function sqStart(ws, m) {
  const p = partyOf(ws);
  if (!p || p.leader !== ws.uid || p.members.length < 2) {
    return send(ws, { t: "pt_result", a: "squad", ok: false, m: "not_leader", username: "" });
  }
  if (Date.now() - (p.matchStart || 0) < 15000) return;
  p.matchStart = Date.now();
  const names = p.members.map((u) => { const w = online.get(u); return w ? w.username : ""; });
  const lw = online.get(p.leader);
  const seed = Math.floor(Math.random() * 1000000000);
  const msg = { t: "sq_start", map: Number(m.map) || 0, seed, members: names, leader: lw ? lw.username : "" };
  for (const u of p.members) send(online.get(u), msg);
}

function relayToParty(ws, m) {
  const p = partyOf(ws);
  if (!p) return;
  const out = { ...m, t: "q", u: ws.username };
  const to = m.to ? String(m.to) : "";
  for (const uid of p.members) {
    if (uid === ws.uid) continue;
    const w = online.get(uid);
    if (!w) continue;
    if (to && w.username !== to) continue;
    send(w, out);
  }
}

// ---------- ACCOUNT ----------
async function loadFriends(ws) {
  ws.friends = new Map();
  const snap = await db.ref("friends/" + ws.uid).once("value");
  const v = snap.val() || {};
  for (const fuid of Object.keys(v)) ws.friends.set(fuid, v[fuid]);
}

function notifyPresence(ws, isOnline) {
  if (!ws.friends) return;
  for (const [fuid] of ws.friends) {
    const f = online.get(fuid);
    if (f) send(f, { t: "fr_presence", username: ws.username, online: isOnline });
  }
}

async function doAuth(ws, gid, secret) {
  if (!db) return send(ws, { t: "auth_err", m: "server_config" });
  gid = String(gid || "");
  secret = String(secret || "");
  if (!/^[a-f0-9]{16}$/.test(gid) || !/^[a-f0-9]{32}$/.test(secret)) {
    return send(ws, { t: "auth_err", m: "bad_creds" });
  }
  const uid = "g_" + gid;
  const ref = db.ref("users/" + uid);
  const snap = await ref.once("value");
  let user = snap.val();
  const h = sha(secret);
  if (!user) {
    user = { name: "Guest", username: "", secretHash: h, created: Date.now(), coins: 0, gems: 0, xp: 0, rp: 0 };
    await ref.set(user);
  } else if (user.secretHash !== h) {
    return send(ws, { t: "auth_err", m: "bad_secret" });
  }
  await ref.update({ lastSeen: Date.now() });
  const old = online.get(uid);
  if (old && old !== ws) {
    removeFromParty(old);
    send(old, { t: "kicked" });
    old.close();
  }
  online.set(uid, ws);
  ws.uid = uid;
  ws.username = user.username || "";
  ws.skin = user.skin || "default";
  await loadFriends(ws);
  send(ws, { t: "auth_ok", uid, name: user.name || "", username: ws.username, profile: profileOf(user) });
  if (ws.username) notifyPresence(ws, true);
}

async function doClaim(ws, name) {
  if (!db || !ws.uid) return send(ws, { t: "claim_err", m: "auth" });
  if (ws.username) return send(ws, { t: "claim_err", m: "already" });
  name = String(name || "").trim();
  if (!USER_RE.test(name)) return send(ws, { t: "claim_err", m: "invalid" });
  const lower = name.toLowerCase();
  if (RESERVED.includes(lower)) return send(ws, { t: "claim_err", m: "taken" });
  const res = await db.ref("usernames/" + lower).transaction((cur) => (cur === null ? ws.uid : undefined));
  if (!res.committed && res.snapshot.val() !== ws.uid) return send(ws, { t: "claim_err", m: "taken" });
  await db.ref("users/" + ws.uid).update({ username: name, usernameLower: lower });
  ws.username = name;
  send(ws, { t: "claim_ok", username: name });
}

// ---------- FRIENDS ----------
async function frList(ws) {
  const fsnap = await db.ref("friends/" + ws.uid).once("value");
  const rsnap = await db.ref("requests/" + ws.uid).once("value");
  const f = fsnap.val() || {};
  const r = rsnap.val() || {};
  const friends = Object.keys(f).map((fuid) => ({ username: f[fuid], online: online.has(fuid) }));
  const requests = Object.keys(r).map((ruid) => r[ruid]);
  send(ws, { t: "fr_data", friends, requests });
}

async function makeFriends(ws, ouid, oname) {
  const upd = {};
  upd["friends/" + ws.uid + "/" + ouid] = oname;
  upd["friends/" + ouid + "/" + ws.uid] = ws.username;
  upd["requests/" + ws.uid + "/" + ouid] = null;
  upd["requests/" + ouid + "/" + ws.uid] = null;
  await db.ref().update(upd);
  if (ws.friends) ws.friends.set(ouid, oname);
  const ows = online.get(ouid);
  if (ows) {
    if (ows.friends) ows.friends.set(ws.uid, ws.username);
    send(ows, { t: "fr_accepted", username: ws.username });
    send(ows, { t: "fr_presence", username: ws.username, online: true });
    send(ws, { t: "fr_presence", username: oname, online: true });
  }
}

async function frSend(ws, uname) {
  uname = String(uname || "").trim();
  const reply = (ok, m) => send(ws, { t: "fr_result", a: "send", ok, m, username: uname });
  if (!USER_RE.test(uname)) return reply(false, "invalid");
  const tuid = (await db.ref("usernames/" + uname.toLowerCase()).once("value")).val();
  if (!tuid) return reply(false, "not_found");
  if (tuid === ws.uid) return reply(false, "self");
  const already = await db.ref("friends/" + ws.uid + "/" + tuid).once("value");
  if (already.exists()) return reply(false, "already_friends");
  const tname = (await db.ref("users/" + tuid + "/username").once("value")).val() || uname;
  const rev = await db.ref("requests/" + ws.uid + "/" + tuid).once("value");
  if (rev.exists()) {
    await makeFriends(ws, tuid, tname);
    return reply(true, "became_friends");
  }
  const dup = await db.ref("requests/" + tuid + "/" + ws.uid).once("value");
  if (dup.exists()) return reply(false, "already_sent");
  await db.ref("requests/" + tuid + "/" + ws.uid).set(ws.username);
  const tws = online.get(tuid);
  if (tws) send(tws, { t: "fr_new_request", username: ws.username });
  reply(true, "sent");
}

async function frAccept(ws, uname) {
  uname = String(uname || "").trim();
  const reply = (ok, m) => send(ws, { t: "fr_result", a: "accept", ok, m, username: uname });
  if (!USER_RE.test(uname)) return reply(false, "invalid");
  const tuid = (await db.ref("usernames/" + uname.toLowerCase()).once("value")).val();
  if (!tuid) return reply(false, "not_found");
  const rq = await db.ref("requests/" + ws.uid + "/" + tuid).once("value");
  if (!rq.exists()) return reply(false, "no_request");
  await makeFriends(ws, tuid, String(rq.val()));
  reply(true, "ok");
}

async function frDecline(ws, uname) {
  uname = String(uname || "").trim();
  const reply = (ok, m) => send(ws, { t: "fr_result", a: "decline", ok, m, username: uname });
  if (!USER_RE.test(uname)) return reply(false, "invalid");
  const tuid = (await db.ref("usernames/" + uname.toLowerCase()).once("value")).val();
  if (!tuid) return reply(false, "not_found");
  await db.ref("requests/" + ws.uid + "/" + tuid).remove();
  reply(true, "declined");
}

async function frRemove(ws, uname) {
  uname = String(uname || "").trim();
  const reply = (ok, m) => send(ws, { t: "fr_result", a: "remove", ok, m, username: uname });
  if (!USER_RE.test(uname)) return reply(false, "invalid");
  const tuid = (await db.ref("usernames/" + uname.toLowerCase()).once("value")).val();
  if (!tuid) return reply(false, "not_found");
  const upd = {};
  upd["friends/" + ws.uid + "/" + tuid] = null;
  upd["friends/" + tuid + "/" + ws.uid] = null;
  await db.ref().update(upd);
  if (ws.friends) ws.friends.delete(tuid);
  const ows = online.get(tuid);
  if (ows && ows.friends) ows.friends.delete(ws.uid);
  reply(true, "removed");
}

// ---------- LEADERBOARD ----------
async function doLeaderboard(ws) {
  if (!db || !ws.uid) return;
  const snap = await db.ref("users").orderByChild("rp").limitToLast(30).once("value");
  const rows = [];
  snap.forEach((c) => {
    const u = c.val() || {};
    if (u.username) rows.push({ u: u.username, rp: u.rp || 0, xp: u.xp || 0, w: u.wins || 0, k: u.kills || 0 });
  });
  rows.sort((a, b) => b.rp - a.rp);
  const top = rows.slice(0, 20).map((r) => ({ u: r.u, rp: r.rp, lv: levelOf(r.xp), tier: tierOf(r.rp), w: r.w, k: r.k }));
  const me = (await db.ref("users/" + ws.uid).once("value")).val() || {};
  const myrp = me.rp || 0;
  const above = await db.ref("users").orderByChild("rp").startAt(myrp + 1).once("value");
  send(ws, { t: "lb_data", top, my_rank: above.numChildren() + 1, my_rp: myrp });
}

// ---------- MISSIONS / LOGIN / STORE ----------
const MISSION_POOL = [
  { id: "play", title: "3 match khelo", stat: "matches", target: 3, coins: 60, gems: 0 },
  { id: "kills5", title: "5 dushman maaro", stat: "kills", target: 5, coins: 80, gems: 0 },
  { id: "kills10", title: "10 dushman maaro", stat: "kills", target: 10, coins: 130, gems: 0 },
  { id: "win", title: "1 match jeeto", stat: "wins", target: 1, coins: 150, gems: 5 },
  { id: "top10", title: "2 baar Top 10 me aao", stat: "top10", target: 2, coins: 70, gems: 0 },
  { id: "survive", title: "Kul 10 minute zinda raho", stat: "minutes", target: 10, coins: 60, gems: 0 },
];
const LOGIN_REWARDS = [
  { coins: 50, gems: 0 }, { coins: 75, gems: 0 }, { coins: 100, gems: 5 }, { coins: 150, gems: 0 },
  { coins: 200, gems: 10 }, { coins: 300, gems: 0 }, { coins: 500, gems: 30 },
];
const SKINS = {
  default: { name: "DEFAULT", price: 0, cur: "coins" },
  crimson: { name: "CRIMSON", price: 500, cur: "coins" },
  ocean: { name: "OCEAN", price: 500, cur: "coins" },
  forest: { name: "FOREST", price: 700, cur: "coins" },
  shadow: { name: "SHADOW", price: 1200, cur: "coins" },
  gold: { name: "GOLDEN", price: 50, cur: "gems" },
  neon: { name: "NEON", price: 80, cur: "gems" },
};

function istNow() {
  return Date.now() + 19800000;
}

function istDay(offsetDays) {
  return new Date(istNow() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}

function secsToReset() {
  const now = istNow();
  const next = (Math.floor(now / 86400000) + 1) * 86400000;
  return Math.max(0, Math.floor((next - now) / 1000));
}

function dayMissions(day) {
  let h = 7;
  for (const c of day) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  const pool = MISSION_POOL.slice();
  const out = [];
  while (out.length < 3 && pool.length) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    out.push(pool.splice((h >>> 8) % pool.length, 1)[0]);
  }
  return out;
}

async function getMissionState(uid) {
  const ref = db.ref("users/" + uid + "/missions");
  let st = (await ref.once("value")).val();
  const day = istDay(0);
  if (!st || st.day !== day) {
    st = { day };
    await ref.set(st);
  }
  st.prog = st.prog || {};
  st.claimed = st.claimed || {};
  return st;
}

function missionPayload(st) {
  const items = dayMissions(st.day).map((m) => ({
    id: m.id, title: m.title, target: m.target,
    prog: Math.min(st.prog[m.stat] || 0, m.target),
    coins: m.coins, gems: m.gems, claimed: !!st.claimed[m.id],
  }));
  return { t: "ms_data", items, reset: secsToReset() };
}

async function addMissionProgress(uid, add) {
  const st = await getMissionState(uid);
  for (const k of Object.keys(add)) st.prog[k] = (st.prog[k] || 0) + add[k];
  await db.ref("users/" + uid + "/missions/prog").set(st.prog);
}

async function addCurrency(uid, coins, gems) {
  const ref = db.ref("users/" + uid);
  if (coins) await ref.child("coins").transaction((c) => (c || 0) + coins);
  if (gems) await ref.child("gems").transaction((g) => (g || 0) + gems);
  return profileOf((await ref.once("value")).val() || {});
}

async function msClaim(ws, id) {
  id = String(id || "");
  const st = await getMissionState(ws.uid);
  const m = dayMissions(st.day).find((x) => x.id === id);
  if (!m || st.claimed[id] || (st.prog[m.stat] || 0) < m.target) {
    return send(ws, { t: "ms_result", ok: false, id });
  }
  const res = await db.ref("users/" + ws.uid + "/missions/claimed/" + id).transaction((cur) => (cur ? undefined : true));
  if (!res.committed) return send(ws, { t: "ms_result", ok: false, id });
  st.claimed[id] = true;
  const profile = await addCurrency(ws.uid, m.coins, m.gems);
  send(ws, { t: "ms_result", ok: true, id, coins: m.coins, gems: m.gems, profile });
  send(ws, missionPayload(st));
}

async function getLogin(uid) {
  const v = (await db.ref("users/" + uid + "/login").once("value")).val() || {};
  const today = istDay(0);
  const yest = istDay(-1);
  const last = v.last || "";
  const streak = v.streak || 0;
  let shown = 0;
  let next = 1;
  const claimedToday = last === today;
  if (claimedToday) {
    shown = streak;
    next = streak + 1;
  } else if (last === yest && streak < 7) {
    shown = streak;
    next = streak + 1;
  }
  return { shown, next, claimedToday, today };
}

function loginPayload(l) {
  return { t: "lg_data", shown: l.shown, claimed_today: l.claimedToday, next: l.next, rewards: LOGIN_REWARDS };
}

async function lgClaim(ws) {
  const l = await getLogin(ws.uid);
  if (l.claimedToday || l.next < 1 || l.next > 7) return send(ws, { t: "lg_result", ok: false, m: "already" });
  const res = await db.ref("users/" + ws.uid + "/login").transaction((cur) => {
    cur = cur || {};
    if (cur.last === l.today) return undefined;
    return { streak: l.next, last: l.today };
  });
  if (!res.committed) return send(ws, { t: "lg_result", ok: false, m: "already" });
  const r = LOGIN_REWARDS[l.next - 1];
  const profile = await addCurrency(ws.uid, r.coins, r.gems);
  send(ws, { t: "lg_result", ok: true, day: l.next, coins: r.coins, gems: r.gems, profile });
  send(ws, loginPayload(await getLogin(ws.uid)));
}

async function stData(ws) {
  const u = (await db.ref("users/" + ws.uid).once("value")).val() || {};
  const owned = u.skins || {};
  const skins = Object.keys(SKINS).map((id) => ({
    id, name: SKINS[id].name, price: SKINS[id].price, cur: SKINS[id].cur, owned: id === "default" || !!owned[id],
  }));
  send(ws, { t: "st_data", skins, equipped: u.skin || "default", profile: profileOf(u) });
}

async function stBuy(ws, id) {
  id = String(id || "");
  const sk = SKINS[id];
  const fail = (m) => send(ws, { t: "st_result", a: "buy", ok: false, m, id });
  if (!sk || id === "default") return fail("bad");
  const own = await db.ref("users/" + ws.uid + "/skins/" + id).transaction((cur) => (cur ? undefined : true));
  if (!own.committed) return fail("owned");
  const res = await db.ref("users/" + ws.uid + "/" + sk.cur).transaction((c) => ((c || 0) >= sk.price ? (c || 0) - sk.price : undefined));
  if (!res.committed) {
    await db.ref("users/" + ws.uid + "/skins/" + id).remove();
    return fail("poor");
  }
  send(ws, { t: "st_result", a: "buy", ok: true, m: "ok", id });
  await stData(ws);
}

async function stEquip(ws, id) {
  id = String(id || "");
  const fail = (m) => send(ws, { t: "st_result", a: "equip", ok: false, m, id });
  if (!SKINS[id]) return fail("bad");
  if (id !== "default" && !(await db.ref("users/" + ws.uid + "/skins/" + id).once("value")).val()) return fail("not_owned");
  await db.ref("users/" + ws.uid + "/skin").set(id);
  ws.skin = id;
  send(ws, { t: "st_result", a: "equip", ok: true, m: "ok", id });
  await stData(ws);
  const p = partyOf(ws);
  if (p) broadcastParty(p);
}

// ---------- MESSAGES ----------
async function handle(ws, m) {
  const t = m.t;
  if (t === "s" || t === "dmg" || t === "fx") {
    const o = other(ws);
    if (o) send(o, m);
    return;
  }
  if (t === "q") return relayToParty(ws, m);
  if (t === "ping") return;
  if (t === "auth") return doAuth(ws, m.gid, m.secret);
  if (t === "claim") return doClaim(ws, m.username);
  if (t === "match_end") return doMatchEnd(ws, m);
  if (t === "sq_start") return sqStart(ws, m);
  if (t === "lb_get") return doLeaderboard(ws);

  if (t === "ms_get" || t === "ms_claim" || t === "lg_get" || t === "lg_claim" || t === "st_get" || t === "st_buy" || t === "st_equip") {
    if (!db || !ws.uid || !ws.username) return;
    if (t === "ms_get") return send(ws, missionPayload(await getMissionState(ws.uid)));
    if (t === "ms_claim") return msClaim(ws, m.id);
    if (t === "lg_get") return send(ws, loginPayload(await getLogin(ws.uid)));
    if (t === "lg_claim") return lgClaim(ws);
    if (t === "st_get") return stData(ws);
    if (t === "st_buy") return stBuy(ws, m.id);
    if (t === "st_equip") return stEquip(ws, m.id);
  }

  if (t === "fr_list" || t === "fr_send" || t === "fr_accept" || t === "fr_decline" || t === "fr_remove") {
    if (!db || !ws.uid || !ws.username) {
      return send(ws, { t: "fr_result", a: "any", ok: false, m: "auth", username: "" });
    }
    if (t === "fr_list") return frList(ws);
    if (t === "fr_send") return frSend(ws, m.username);
    if (t === "fr_accept") return frAccept(ws, m.username);
    if (t === "fr_decline") return frDecline(ws, m.username);
    if (t === "fr_remove") return frRemove(ws, m.username);
  }

  if (t === "pt_get" || t === "pt_invite" || t === "pt_accept" || t === "pt_decline" || t === "pt_kick" || t === "pt_leave" || t === "p_emote") {
    if (!ws.uid || !ws.username) return;
    if (t === "pt_get") {
      const p = partyOf(ws);
      return send(ws, p ? partyMsg(p) : { t: "pt_state", leader: "", members: [], skins: [] });
    }
    if (t === "pt_invite") return ptInvite(ws, m.username);
    if (t === "pt_accept") return ptAccept(ws);
    if (t === "pt_decline") return ptDecline(ws);
    if (t === "pt_kick") return ptKick(ws, m.username);
    if (t === "pt_leave") return removeFromParty(ws);
    if (t === "p_emote") return ptEmote(ws, m.clip);
  }

  if (t === "create" || t === "join") {
    if (!ws.uid || !ws.username) return send(ws, { t: "err", m: "auth" });
  }
  if (t === "create") {
    leave(ws);
    const code = genCode();
    if (!code) return send(ws, { t: "err", m: "bad" });
    rooms.set(code, {
      code, host: ws, guest: null, started: false,
      hostName: ws.username, guestName: "", map: Number(m.map) || 0, created: Date.now(),
    });
    ws.room = code;
    send(ws, { t: "created", code });
    return;
  }
  if (t === "join") {
    leave(ws);
    const code = String(m.code || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, { t: "err", m: "not_found" });
    if (room.started) return send(ws, { t: "err", m: "started" });
    if (room.guest) return send(ws, { t: "err", m: "full" });
    room.guest = ws;
    room.guestName = ws.username;
    ws.room = code;
    send(ws, { t: "joined", host_name: room.hostName, map: room.map });
    send(room.host, { t: "guest", name: room.guestName });
    return;
  }
  if (t === "map") {
    const room = rooms.get(ws.room);
    if (!room || ws !== room.host) return;
    room.map = Number(m.map) || 0;
    send(room.guest, { t: "map", map: room.map });
    return;
  }
  if (t === "start") {
    const room = rooms.get(ws.room);
    if (!room || ws !== room.host) return;
    if (!room.guest) return send(ws, { t: "err", m: "noguest" });
    room.started = true;
    const msg = { t: "start", map: room.map, host_name: room.hostName, guest_name: room.guestName };
    send(room.host, msg);
    send(room.guest, msg);
    return;
  }
  if (t === "leave") {
    leave(ws);
    return;
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok rooms=" + rooms.size + " online=" + online.size + " parties=" + parties.size + " db=" + (db ? "yes" : "NO"));
});

const wss = new WebSocketServer({ server, maxPayload: 16384 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.uid = "";
  ws.username = "";
  ws.skin = "default";
  ws.friends = null;
  ws.party = null;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});
  ws.on("close", () => {
    leave(ws);
    if (ws.uid && online.get(ws.uid) === ws) {
      relayToParty(ws, { k: "left" });
      removeFromParty(ws);
      online.delete(ws.uid);
      if (ws.username) notifyPresence(ws, false);
    }
  });
  ws.on("message", async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    try { await handle(ws, m); } catch (e) { console.log("handler error:", e.message); }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log("server on " + PORT));
