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
const sessions = new Map(); // id -> { players: [{ws,name,color}], board, currentPlayer, gameOver, rematchVotes }

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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join')    handleJoin(ws, msg.name);
    if (msg.type === 'move')    handleMove(ws, msg.row, msg.col);
    if (msg.type === 'rematch') handleRematch(ws);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}

function handleJoin(ws, name) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'error', message: 'Please enter a name.' });

  ws.playerName = cleanName;

  if (queue && queue.ws.readyState === 1) {
    // Pair with the waiting player
    const first = queue;
    queue = null;

    const sessionId = nextSessionId++;
    const session = {
      players: [
        { ws: first.ws, name: first.name, color: 'black' },
        { ws,           name: cleanName,  color: 'white' },
      ],
      board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
      currentPlayer: 'black',
      gameOver: false,
      rematchVotes: new Set(),
    };
    sessions.set(sessionId, session);

    first.ws.sessionId = sessionId;
    first.ws.color = 'black';
    ws.sessionId = sessionId;
    ws.color = 'white';

    send(first.ws, { type: 'start', color: 'black', myName: first.name, opponentName: cleanName });
    send(ws,       { type: 'start', color: 'white', myName: cleanName,  opponentName: first.name });
  } else {
    // Join the queue and wait
    if (queue && queue.ws !== ws) {
      // Stale entry (shouldn't normally happen); replace it
    }
    queue = { ws, name: cleanName };
    send(ws, { type: 'waiting' });
  }
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
  broadcast(session, { type: 'move', row, col, color: ws.color, winLine: winLine || null });

  if (winLine) {
    session.gameOver = true;
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
  broadcast(session, { type: 'rematch_vote', votes: session.rematchVotes.size });

  if (session.rematchVotes.size >= 2) {
    session.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    session.currentPlayer = 'black';
    session.gameOver = false;
    session.rematchVotes.clear();
    broadcast(session, { type: 'rematch_start' });
  }
}

function handleDisconnect(ws) {
  // Remove from queue if waiting
  if (queue && queue.ws === ws) {
    queue = null;
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

  sessions.delete(ws.sessionId);
  ws.sessionId = null;
}

// ---- Win detection ----
function checkWin(board, r, c, player) {
  for (const [dr, dc] of DIRECTIONS) {
    const line = collectLine(board, r, c, dr, dc, player);
    if (line.length >= WIN_COUNT) return line;
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
