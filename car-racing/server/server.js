'use strict';

// HTTP + WebSocket entry point for the car-racing multiplayer backend.
//
//   GET /            -> simple health text
//   GET /matches     -> JSON list of active matches
//   WS  /ws/racing   -> client sockets (see racing.js for protocol)

const http   = require('http');
const racing = require('./racing');

const PORT = process.env.PORT || 9753;

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/' || urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('car-racing server ok\n');
    return;
  }

  if (urlPath === '/matches') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(racing.listMatches()));
    return;
  }

  res.writeHead(404);
  res.end('Not found\n');
});

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/racing') {
    racing.wss.handleUpgrade(req, socket, head, ws => {
      racing.wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log(`car-racing server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws/racing`);
});
