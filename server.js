const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();

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

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok rooms=" + rooms.size);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});
  ws.on("close", () => leave(ws));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const t = m.t;

    if (t === "s" || t === "dmg") {
      const o = other(ws);
      if (o) send(o, m);
      return;
    }
    if (t === "create") {
      leave(ws);
      const code = genCode();
      if (!code) return send(ws, { t: "err", m: "bad" });
      rooms.set(code, {
        code, host: ws, guest: null, started: false,
        hostName: String(m.name || "Player").slice(0, 16),
        guestName: "", map: Number(m.map) || 0, created: Date.now(),
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
      room.guestName = String(m.name || "Player").slice(0, 16);
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
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log("duel server on " + PORT));
