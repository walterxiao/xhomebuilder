const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const logger = require('./logger');

let tlsOpts = null;
try {
  const SSL_KEY  = process.env.SSL_KEY  || '/etc/letsencrypt/live/default/privkey.pem';
  const SSL_CERT = process.env.SSL_CERT || '/etc/letsencrypt/live/default/fullchain.pem';
  tlsOpts = { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) };
} catch (e) {
  console.warn(`TLS certs not loaded (${e.message}); starting in HTTP mode.`);
}

const connect5   = require('./games/connect5');
const airplane   = require('./games/airplane');
const battleship = require('./games/battleship');
const pictionary = require('./games/pictionary');
const presence   = require('./games/presence');
const chess      = require('./games/chess');
const pingpong   = require('./games/pingpong');
const blockstack = require('./games/blockstack');
const raiden     = require('./games/raiden');
const gofish     = require('./games/gofish');
const snake      = require('./games/snake');
const tank       = require('./games/tank');
const go         = require('./games/go');
const sudoku     = require('./games/sudoku');
const maze       = require('./games/maze');
const pacman     = require('./games/pacman');
const stats      = require('./stats');

// ── Play-count tracking ───────────────────────────────────────────────────────
// Each entry: [wss, startMessageTypes[]]
// A second 'connection' listener sniffs for these types and increments the counter.
const GAME_START_MSGS = [
  [snake,      'snake',      ['snake_create']],
  [connect5,   'connect5',   ['create']],
  [chess,      'chess',      ['chess_create']],
  [battleship, 'battleship', ['bs_create']],
  [airplane,   'airplane',   ['aj_create']],
  [pictionary, 'pictionary', ['pic_create']],
  [pingpong,   'pingpong',   ['start']],   // no explicit create msg
  [blockstack, 'blockstack', ['create']],
  [raiden,     'raiden',     ['create']],
  [gofish,     'gofish',     ['start']],   // no explicit create msg
  [tank,       'tank',       ['tank_create']],
  [go,         'go',         ['go_create']],
  [sudoku,     'sudoku',     ['start']],
  [maze,       'maze',       ['start']],
  [pacman,     'pacman',     ['start']],
];
for (const [mod, game, types] of GAME_START_MSGS) {
  mod.wss.on('connection', ws => {
    ws.on('message', raw => {
      try { if (types.includes(JSON.parse(raw).type)) stats.increment(game); } catch {}
    });
  });
}

// ── Join / create tracking ────────────────────────────────────────────────────
// Sniff the first 'join' message on every game WebSocket to distinguish
// new-session creation (no sessionId) from joining an existing one.
const GAME_JOIN_TRACK = [
  [connect5,   'connect5'],
  [airplane,   'airplane'],
  [battleship, 'battleship'],
  [pictionary, 'pictionary'],
  [chess,      'chess'],
  [pingpong,   'pingpong'],
  [blockstack, 'blockstack'],
  [raiden,     'raiden'],
  [gofish,     'gofish'],
  [snake,      'snake'],
  [tank,       'tank'],
  [sudoku,     'sudoku'],
  [maze,       'maze'],
  [pacman,     'pacman'],
];
for (const [mod, game] of GAME_JOIN_TRACK) {
  mod.wss.on('connection', ws => {
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'join') {
          logger.log(m.sessionId ? 'game_join' : 'game_create', { game });
        }
      } catch {}
    });
  });
}

const PORT = process.env.PORT || (tlsOpts ? 443 : 80);

const PAGES = {
  '/':           'index.html',
  '/snake':      'snake.html',
  '/connect5':   'connect5.html',
  '/airplane':   'airplane.html',
  '/battleship': 'battleship.html',
  '/pictionary': 'pictionary.html',
  '/chess':      'chess.html',
  '/pingpong':   'pingpong.html',
  '/blockstack': 'blockstack.html',
  '/raiden':     'raiden.html',
  '/gofish':     'gofish.html',
  '/tank':       'tank.html',
  '/go':         'go.html',
  '/sudoku':     'sudoku.html',
  '/maze':       'maze.html',
  '/pacman':     'pacman.html',
};



function requestHandler(req, res) {
  const urlPath = req.url.split('?')[0];
  const SESSION_APIS = {
    '/api/connect5/sessions':   () => connect5.getSessionList(),
    '/api/chess/sessions':      () => chess.getSessionList(),
    '/api/battleship/sessions': () => battleship.getSessionList(),
    '/api/airplane/sessions':   () => airplane.getSessionList(),
    '/api/pictionary/sessions': () => pictionary.getSessionList(),
    '/api/pingpong/sessions':   () => pingpong.getSessionList(),
    '/api/blockstack/sessions': () => blockstack.getSessionList(),
    '/api/raiden/sessions':     () => raiden.getSessionList(),
    '/api/gofish/sessions':     () => gofish.getSessionList(),
    '/api/snake/sessions':      () => snake.getSessionList(),
    '/api/tank/sessions':       () => tank.getSessionList(),
    '/api/go/sessions':         () => go.getSessionList(),
    '/api/sudoku/sessions':     () => sudoku.getSessionList(),
    '/api/maze/sessions':       () => maze.getSessionList(),
    '/api/pacman/sessions':     () => pacman.getSessionList(),
  };
  if (urlPath === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(stats.getAll()));
    return;
  }
  if (urlPath === '/api/hideandseek/click') {
    stats.increment('hideandseek');
    logger.log('game_create', { game: 'hideandseek' });
    res.writeHead(204);
    res.end();
    return;
  }
  if (SESSION_APIS[urlPath]) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(SESSION_APIS[urlPath]()));
    return;
  }
  const file = PAGES[urlPath];
  if (urlPath === '/favicon.svg') {
    fs.readFile(path.join(__dirname, 'favicon.svg'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400' });
      res.end(data);
    });
    return;
  }
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  const game = urlPath === '/' ? 'lobby' : urlPath.slice(1);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  logger.log('page_view', { game, ip });
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const httpsServer = tlsOpts
  ? https.createServer(tlsOpts, requestHandler)
  : http.createServer(requestHandler);

httpsServer.on('upgrade', (req, socket, head) => {
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
  } else if (req.url === '/ws/blockstack') {
    blockstack.wss.handleUpgrade(req, socket, head, ws => {
      blockstack.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/raiden') {
    raiden.wss.handleUpgrade(req, socket, head, ws => {
      raiden.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/gofish') {
    gofish.wss.handleUpgrade(req, socket, head, ws => {
      gofish.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/snake') {
    snake.wss.handleUpgrade(req, socket, head, ws => {
      snake.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/tank') {
    tank.wss.handleUpgrade(req, socket, head, ws => {
      tank.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/go') {
    go.wss.handleUpgrade(req, socket, head, ws => {
      go.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/sudoku') {
    sudoku.wss.handleUpgrade(req, socket, head, ws => {
      sudoku.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/maze') {
    maze.wss.handleUpgrade(req, socket, head, ws => {
      maze.wss.emit('connection', ws, req);
    });
  } else if (req.url === '/ws/pacman') {
    pacman.wss.handleUpgrade(req, socket, head, ws => {
      pacman.wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpsServer.listen(PORT, () => {
  console.log(`Game Hub running → ${tlsOpts ? 'https' : 'http'}://localhost:${PORT}`);
});

if (tlsOpts) {
  http.createServer((req, res) => {
    res.writeHead(301, { Location: 'https://' + req.headers.host + req.url });
    res.end();
  }).listen(80);
}
