const http = require('http');
const fs = require('fs');
const path = require('path');

const connect5 = require('./games/connect5');
const airplane = require('./games/airplane');
const battleship = require('./games/battleship');
const pictionary = require('./games/pictionary');
const presence = require('./games/presence');
const chess = require('./games/chess');
const pingpong = require('./games/pingpong');

const PORT = process.env.PORT || 9753;

const PAGES = {
  '/':           'index.html',
  '/connect5':   'connect5.html',
  '/airplane':   'airplane.html',
  '/battleship': 'battleship.html',
  '/pictionary': 'pictionary.html',
  '/chess':      'chess.html',
  '/pingpong':   'pingpong.html',
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const file = PAGES[urlPath];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/connect5') {
    connect5.wss.handleUpgrade(req, socket, head, ws => {
      connect5.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/airplane') {
    airplane.wss.handleUpgrade(req, socket, head, ws => {
      airplane.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/battleship') {
    battleship.wss.handleUpgrade(req, socket, head, ws => {
      battleship.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/pictionary') {
    pictionary.wss.handleUpgrade(req, socket, head, ws => {
      pictionary.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/presence') {
    presence.wss.handleUpgrade(req, socket, head, ws => {
      presence.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/chess') {
    chess.wss.handleUpgrade(req, socket, head, ws => {
      chess.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/pingpong') {
    pingpong.wss.handleUpgrade(req, socket, head, ws => {
      pingpong.wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log(`Game Hub running → http://localhost:${PORT}`);
});
