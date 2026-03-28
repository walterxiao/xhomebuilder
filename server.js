const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 15;
const WIN_COUNT = 5;
const DIRECTIONS = [[0,1],[1,0],[1,1],[1,-1]];

let queue = null;           // at most one waiting player: { ws, name }
let nextSessionId = 1;
const sessions = new Map(); // id -> { players, observers, board, currentPlayer, gameOver, rematchVotes, lastLoser }

// ---- HTTP: serve index.html ----
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.sessionId = null;
  ws.color = null;
  ws.playerName = null;
  ws.isObserver = false;
  ws.observingSessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join')         handleJoin(ws, msg.name);
    if (msg.type === 'move')         handleMove(ws, msg.row, msg.col);
    if (msg.type === 'rematch')      handleRematch(ws);
    if (msg.type === 'chat')         handleChat(ws, msg.text);
    if (msg.type === 'surrender')    handleSurrender(ws);
    if (msg.type === 'get_sessions') handleGetSessions(ws);
    if (msg.type === 'observe')      handleObserve(ws, msg.name, msg.sessionId);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Broadcast to both players and all observers
function broadcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
  session.observers.forEach(o => send(o.ws, obj));
}

function sessionSummary(id, session) {
  const black = session.players.find(p => p.color === 'black');
  const white = session.players.find(p => p.color === 'white');
  return {
    id,
    blackName: black ? black.name : '',
    whiteName: white ? white.name : '',
    observers: session.observers.length,
    gameOver: session.gameOver,
    moves: session.board.flat().filter(Boolean).length,
  };
}

function handleJoin(ws, name) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'error', message: 'Please enter a name.' });

  ws.playerName = cleanName;

  if (queue && queue.ws.readyState === 1) {
    const first = queue;
    queue = null;

    const sessionId = nextSessionId++;
    const session = {
      players: [
        { ws: first.ws, name: first.name, color: 'black' },
        { ws,           name: cleanName,  color: 'white' },
      ],
      observers: [],
      board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
      currentPlayer: 'black',
      gameOver: false,
      rematchVotes: new Set(),
      lastLoser: null,
    };
    sessions.set(sessionId, session);

    first.ws.sessionId = sessionId;
    first.ws.color = 'black';
    ws.sessionId = sessionId;
    ws.color = 'white';

    send(first.ws, { type: 'start', color: 'black', myName: first.name, opponentName: cleanName });
    send(ws,       { type: 'start', color: 'white', myName: cleanName,  opponentName: first.name });
  } else {
    queue = { ws, name: cleanName };
    send(ws, { type: 'waiting' });
  }
}

function handleGetSessions(ws) {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.players.length === 2) list.push(sessionSummary(id, session));
  }
  send(ws, { type: 'sessions_list', sessions: list });
}

function handleObserve(ws, name, sessionId) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'error', message: 'Please enter a name.' });

  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'observe_error', message: 'Game not found. It may have ended.' });

  ws.playerName = cleanName;
  ws.isObserver = true;
  ws.observingSessionId = sessionId;

  session.observers.push({ ws, name: cleanName });

  // Notify players that observer count changed
  broadcastPlayers(session, { type: 'observer_count', count: session.observers.length });

  const black = session.players.find(p => p.color === 'black');
  const white = session.players.find(p => p.color === 'white');

  send(ws, {
    type: 'observe_start',
    sessionId,
    board: session.board,
    currentPlayer: session.currentPlayer,
    blackName: black ? black.name : '',
    whiteName: white ? white.name : '',
    gameOver: session.gameOver,
  });
}

function handleMove(ws, row, col) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.gameOver) return;
  if (session.currentPlayer !== ws.color) return;
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
  if (session.board[row][col]) return;

  session.board[row][col] = ws.color;

  const winLine = checkWin(session.board, row, col, ws.color);
  const threat = winLine ? null : checkThreat(session.board, row, col, ws.color);
  broadcast(session, { type: 'move', row, col, color: ws.color, winLine: winLine || null, threat: threat || null });

  if (winLine) {
    session.gameOver = true;
    session.lastLoser = ws.color === 'black' ? 'white' : 'black';
    session.rematchVotes.clear();
  } else {
    session.currentPlayer = ws.color === 'black' ? 'white' : 'black';
  }
}

function handleRematch(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || !session.gameOver) return;

  session.rematchVotes.add(ws.color);
  broadcastPlayers(session, { type: 'rematch_vote', votes: session.rematchVotes.size });

  if (session.rematchVotes.size >= 2) {
    const firstPlayer = session.lastLoser || 'black';
    session.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    session.currentPlayer = firstPlayer;
    session.gameOver = false;
    session.rematchVotes.clear();
    broadcast(session, { type: 'rematch_start', firstPlayer });
  }
}

function handleChat(ws, text) {
  if (!ws.playerName) return;
  if (typeof text !== 'string') return;
  const clean = text.trim().slice(0, 200);
  if (!clean) return;

  if (ws.isObserver) {
    const session = sessions.get(ws.observingSessionId);
    if (!session) return;
    broadcast(session, { type: 'chat', name: ws.playerName, text: clean, observer: true });
  } else {
    if (!ws.sessionId) return;
    const session = sessions.get(ws.sessionId);
    if (!session) return;
    broadcast(session, { type: 'chat', name: ws.playerName, text: clean, observer: false });
  }
}

function handleSurrender(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.gameOver) return;

  const winnerColor = ws.color === 'black' ? 'white' : 'black';
  const winnerPlayer = session.players.find(p => p.color === winnerColor);

  session.gameOver = true;
  session.lastLoser = ws.color;
  session.rematchVotes.clear();

  broadcast(session, {
    type: 'surrendered',
    loserColor: ws.color,
    loserName: ws.playerName,
    winnerColor,
    winnerName: winnerPlayer ? winnerPlayer.name : '',
  });
}

function handleDisconnect(ws) {
  if (queue && queue.ws === ws) queue = null;

  // Observer disconnecting
  if (ws.isObserver) {
    const session = sessions.get(ws.observingSessionId);
    if (session) {
      session.observers = session.observers.filter(o => o.ws !== ws);
      broadcastPlayers(session, { type: 'observer_count', count: session.observers.length });
    }
    return;
  }

  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session) return;

  // Notify the other player
  session.players.forEach(p => {
    if (p.ws !== ws && p.ws.readyState === 1) {
      send(p.ws, { type: 'opponent_disconnected' });
    }
  });

  // Notify observers that the game ended
  session.observers.forEach(o => send(o.ws, { type: 'game_ended', message: 'A player disconnected. The game has ended.' }));

  sessions.delete(ws.sessionId);
  ws.sessionId = null;
}

// Send only to players (not observers) — used for rematch voting
function broadcastPlayers(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}

// ---- Win / threat detection ----
function checkWin(board, r, c, player) {
  for (const [dr, dc] of DIRECTIONS) {
    const line = collectLine(board, r, c, dr, dc, player);
    if (line.length >= WIN_COUNT) return line;
  }
  return null;
}

function checkThreat(board, r, c, player) {
  for (const [dr, dc] of DIRECTIONS) {
    const line = collectLine(board, r, c, dr, dc, player);
    if (line.length === WIN_COUNT - 1) return line;
  }
  return null;
}

function collectLine(board, r, c, dr, dc, player) {
  const cells = [[r, c]];
  for (const sign of [1, -1]) {
    let nr = r + dr * sign, nc = c + dc * sign;
    while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === player) {
      cells.push([nr, nc]);
      nr += dr * sign; nc += dc * sign;
    }
  }
  return cells;
}

httpServer.listen(PORT, () => {
  console.log(`Connect-5 running → http://localhost:${PORT}`);
});
