'use strict';
const { WebSocketServer } = require('ws');

let nextId = 1;
const sessions = new Map();
const wss = new WebSocketServer({ noServer: true });

// ── Puzzle generation ─────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function canPlace(board, r, c, n) {
  for (let i = 0; i < 9; i++) {
    if (board[r][i] === n || board[i][c] === n) return false;
  }
  const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (board[br + i][bc + j] === n) return false;
  return true;
}

function fillBoard(board) {
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9), c = i % 9;
    if (board[r][c] === 0) {
      for (const n of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
        if (canPlace(board, r, c, n)) {
          board[r][c] = n;
          if (fillBoard(board)) return true;
          board[r][c] = 0;
        }
      }
      return false;
    }
  }
  return true;
}

function makePuzzle(difficulty) {
  const solution = Array.from({ length: 9 }, () => new Array(9).fill(0));
  fillBoard(solution);
  const remove = { easy: 30, medium: 45, hard: 55 }[difficulty] || 45;
  const puzzle = solution.map(r => [...r]);
  const indices = shuffle([...Array(81).keys()]);
  for (let i = 0; i < remove; i++)
    puzzle[Math.floor(indices[i] / 9)][indices[i] % 9] = 0;
  return { puzzle, solution };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function bcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}
function pub(session) {
  return session.players.map(p => ({ idx: p.idx, name: p.name }));
}
function isComplete(session) {
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++) {
      if (session.puzzle[r][c] !== 0) continue;
      const e = session.entries[r * 9 + c];
      if (!e || !e.correct) return false;
    }
  return true;
}

// ── Connection handling ───────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.sid = null; ws.pidx = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join')  handleJoin(ws, m.name, m.sessionId);
    if (m.type === 'start') handleStart(ws, m.difficulty);
    if (m.type === 'move')  handleMove(ws, +m.row, +m.col, +m.value);
    if (m.type === 'chat')  handleChat(ws, m.text);
  });
  ws.on('close', () => handleDC(ws));
  ws.on('error', () => handleDC(ws));
});

function handleJoin(ws, name, sessionId) {
  if (!name || typeof name !== 'string') return;
  name = name.trim().slice(0, 24);
  if (!name) return;

  let sid, session;
  if (sessionId && sessions.has(+sessionId)) {
    sid = +sessionId;
    session = sessions.get(sid);
    if (session.started) return send(ws, { type: 'error', message: 'Game already started.' });
    if (session.players.length >= 2) return send(ws, { type: 'error', message: 'Session full (max 2 players).' });
  } else {
    sid = nextId++;
    session = { id: sid, players: [], started: false, gameOver: false,
                puzzle: null, solution: null, entries: null, startTime: null, difficulty: 'medium' };
    sessions.set(sid, session);
  }

  const idx = session.players.length;
  session.players.push({ ws, name, idx });
  ws.sid = sid; ws.pidx = idx;

  send(ws, { type: 'joined', sessionId: sid, yourIdx: idx, players: pub(session) });
  session.players.forEach((p, i) => {
    if (i !== idx) send(p.ws, { type: 'lobby_update', players: pub(session) });
  });
}

function handleStart(ws, difficulty) {
  const session = sessions.get(ws.sid);
  if (!session || ws.pidx !== 0 || session.started) return;

  const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  const { puzzle, solution } = makePuzzle(diff);
  session.started = true;
  session.puzzle = puzzle;
  session.solution = solution;
  session.entries = new Array(81).fill(null);
  session.startTime = Date.now();
  session.difficulty = diff;

  bcast(session, { type: 'start', puzzle, difficulty: diff, players: pub(session) });
}

function handleMove(ws, row, col, value) {
  const session = sessions.get(ws.sid);
  if (!session || !session.started || session.gameOver) return;
  if (row < 0 || row > 8 || col < 0 || col > 8) return;
  if (value < 0 || value > 9) return;
  if (session.puzzle[row][col] !== 0) return;

  const idx = row * 9 + col;
  let correct = null;
  if (value === 0) {
    session.entries[idx] = null;
  } else {
    correct = session.solution[row][col] === value;
    session.entries[idx] = { value, playerIdx: ws.pidx, correct };
  }

  bcast(session, { type: 'move', row, col, value, playerIdx: ws.pidx, correct });

  if (value !== 0 && isComplete(session)) {
    session.gameOver = true;
    const elapsed = Math.round((Date.now() - session.startTime) / 1000);
    bcast(session, { type: 'complete', elapsed });
  }
}

function handleChat(ws, text) {
  const session = sessions.get(ws.sid);
  if (!session) return;
  const p = session.players[ws.pidx];
  if (!p) return;
  bcast(session, { type: 'chat', name: p.name, playerIdx: ws.pidx, text: String(text).slice(0, 200) });
}

function handleDC(ws) {
  const session = sessions.get(ws.sid);
  if (!session) return;
  const p = session.players[ws.pidx];
  if (!p) return;
  if (!session.started) {
    session.players.splice(ws.pidx, 1);
    session.players.forEach((q, i) => { q.idx = i; if (q.ws) q.ws.pidx = i; });
    if (session.players.length === 0) { sessions.delete(session.id); return; }
    bcast(session, { type: 'lobby_update', players: pub(session) });
  } else {
    p.ws = null;
    bcast(session, { type: 'chat', name: '·', playerIdx: -1, text: `${p.name} disconnected.` });
  }
}

function getSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.gameOver) continue;
    const host = session.players[0];
    list.push({
      id,
      hostName: host ? host.name : '?',
      players: session.players.length,
      maxPlayers: 2,
      canJoin: !session.started && session.players.length < 2,
      status: session.started ? 'playing' : 'waiting',
      label: session.started ? `${session.difficulty} · in progress` : `${session.players.length}/2 players`
    });
  }
  return list;
}

module.exports = { wss, getSessionList };
