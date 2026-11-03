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
    send(old, { t: "kicked" });
    old.close();
  }
  online.set(uid, ws);
  ws.uid = uid;
  ws.username = user.username || "";
  send(ws, { t: "auth_ok", uid, name: user.name || "", username: ws.username });
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

async function handle(ws, m) {
  const t = m.t;
  if (t === "s" || t === "dmg") {
    const o = other(ws);
    if (o) send(o, m);
    return;
  }
  if (t === "ping") return;
  if (t === "auth") return doAuth(ws, m.gid, m.secret);
  if (t === "claim") return doClaim(ws, m.username);

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
  res.end("ok rooms=" + rooms.size + " db=" + (db ? "yes" : "NO"));
});

const wss = new WebSocketServer({ server, maxPayload: 8192 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.uid = "";
  ws.username = "";
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});
  ws.on("close", () => {
    leave(ws);
    if (ws.uid && online.get(ws.uid) === ws) online.delete(ws.uid);
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
