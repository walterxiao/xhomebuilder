const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ noServer: true });
const clients = new Map(); // ws → { name, page }

wss.on('connection', (ws) => {
  clients.set(ws, { name: null, page: 'lobby' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'presence_join') {
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 24) : null;
      const page = typeof msg.page === 'string' ? msg.page.slice(0, 20) : 'lobby';
      if (!name) return;
      clients.set(ws, { name, page });
      broadcast();
    }
  });

  ws.on('close', () => { clients.delete(ws); broadcast(); });
  ws.on('error', () => { clients.delete(ws); broadcast(); });
});

function broadcast() {
  const users = [];
  for (const [, info] of clients) {
    if (info.name) users.push({ name: info.name, page: info.page });
  }
  const msg = JSON.stringify({ type: 'presence_update', users });
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Periodic refresh so clients stay in sync even if a push was missed
setInterval(broadcast, 5000);

module.exports = { wss };
