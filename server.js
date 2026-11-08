const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 8080;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = ["admin", "administrator", "support", "moderator", "system", "official", "guest"];
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

// ---------- PARTY ----------
function partyOf(ws) {
  return ws.party ? parties.get(ws.party) : null;
}

function partyMsg(p) {
  const names = p.members.map((u) => { const w = online.get(u); return w ? w.username : ""; });
  const lw = online.get(p.leader);
  return { t: "pt_state", leader: lw ? lw.username : "", members: names };
}

function broadcastParty(p) {
  const msg = partyMsg(p);
  for (const u of p.members) send(online.get(u), msg);
}

function removeFromParty(ws, reason) {
  if (!ws.party) return;
  const p = parties.get(ws.party);
  ws.party = null;
  send(ws, reason ? { t: reason } : { t: "pt_state", leader: "", members: [] });
  if (!p) return;
  p.members = p.members.filter((u) => u !== ws.uid);
  if (p.members.length <= 1) {
    for (const u of p.members) {
      const w = online.get(u);
      if (w) { w.party = null; send(w, { t: "pt_state", leader: "", members: [] }); }
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
    p = { id: partySeq++, leader: lws.uid, members: [lws.uid] };
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
    user = { name: "Guest", username: "", secretHash: h, created: Date.now() };
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
  await loadFriends(ws);
  send(ws, { t: "auth_ok", uid, name: user.name || "", username: ws.username });
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

// ---------- MESSAGES ----------
async function handle(ws, m) {
  const t = m.t;
  if (t === "s" || t === "dmg" || t === "fx") {
    const o = other(ws);
    if (o) send(o, m);
    return;
  }
  if (t === "ping") return;
  if (t === "auth") return doAuth(ws, m.gid, m.secret);
  if (t === "claim") return doClaim(ws, m.username);

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
      return send(ws, p ? partyMsg(p) : { t: "pt_state", leader: "", members: [] });
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

const wss = new WebSocketServer({ server, maxPayload: 8192 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.uid = "";
  ws.username = "";
  ws.friends = null;
  ws.party = null;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});
  ws.on("close", () => {
    leave(ws);
    if (ws.uid && online.get(ws.uid) === ws) {
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


