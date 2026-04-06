const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', ws => {
  let sid = null, role = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ses = sessions.get(sid);

    if (msg.type === 'create') {
      sid = String(nextId++).padStart(4, '0');
      sessions.set(sid, { host: ws, guest: null, started: false });
      role = 'host';
      send(ws, { type: 'created', sessionId: sid });

    } else if (msg.type === 'join') {
      const s2 = sessions.get(msg.sessionId);
      if (!s2 || s2.guest) { send(ws, { type: 'error', msg: 'Session not found or full' }); return; }
      s2.guest = ws; sid = msg.sessionId; role = 'guest';
      send(s2.host, { type: 'guest_joined' });
      send(ws, { type: 'joined', sessionId: sid });

    } else if (msg.type === 'start' && ses && role === 'host') {
      ses.started = true;
      send(ses.host, { type: 'start', playerIdx: 0 });
      if (ses.guest) send(ses.guest, { type: 'start', playerIdx: 1 });

    } else if (msg.type === 'state' && ses && role === 'host') {
      if (ses.guest) send(ses.guest, msg);

    } else if (msg.type === 'input' && ses && role === 'guest') {
      if (ses.host) send(ses.host, msg);

    } else if (msg.type === 'chat' && ses) {
      const other = role === 'host' ? ses.guest : ses.host;
      send(other, { type: 'chat', text: msg.text, from: role });
    }
  });

  ws.on('close', () => {
    if (!sid) return;
    const ses = sessions.get(sid);
    if (!ses) return;
    const other = role === 'host' ? ses.guest : ses.host;
    if (other) send(other, { type: 'disconnected' });
    sessions.delete(sid);
  });
});

function getSessionList() {
  return Array.from(sessions.entries())
    .filter(([,s]) => !s.started && !s.guest)
    .map(([id]) => ({ id }));
}

module.exports = { wss, getSessionList };
