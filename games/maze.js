'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

const SIZE = 31; // 31×31 cells — winding DFS maze, ~3-5 min to solve
const DR = [-1, 0, 1, 0]; // N E S W
const DC = [0, 1, 0, -1];
const OPP = [2, 3, 0, 1];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateMaze(size) {
  // passages[r*size+c] bitmask: bit d = direction d is an open passage
  const passages = new Uint8Array(size * size);
  const visited  = new Uint8Array(size * size);
  const stack    = [];
  const sr = Math.floor(size / 2), sc = Math.floor(size / 2);
  visited[sr * size + sc] = 1;
  stack.push(sr * size + sc);

  while (stack.length) {
    const idx = stack[stack.length - 1];
    const r = Math.floor(idx / size), c = idx % size;
    const dirs = shuffle([0, 1, 2, 3]).filter(d => {
      const nr = r + DR[d], nc = c + DC[d];
      return nr >= 0 && nr < size && nc >= 0 && nc < size && !visited[nr * size + nc];
    });
    if (!dirs.length) { stack.pop(); continue; }
    const d = dirs[0];
    const nr = r + DR[d], nc = c + DC[d];
    const nidx = nr * size + nc;
    passages[idx]  |= 1 << d;
    passages[nidx] |= 1 << OPP[d];
    visited[nidx] = 1;
    stack.push(nidx);
  }

  // Place exit on perimeter, >3 cells away from spawn row/col
  const half = Math.floor(size / 2);
  const cands = [];
  for (let i = 0; i < size; i++) {
    if (Math.abs(i - half) > 3) {
      cands.push({ r: 0,      c: i,      d: 0 }); // top
      cands.push({ r: size-1, c: i,      d: 2 }); // bottom
      cands.push({ r: i,      c: 0,      d: 3 }); // left
      cands.push({ r: i,      c: size-1, d: 1 }); // right
    }
  }
  const exit = cands[Math.floor(Math.random() * cands.length)];
  passages[exit.r * size + exit.c] |= 1 << exit.d;

  return { passages: Array.from(passages), exit, size };
}

let nextId = 1000;
const sessions = new Map();

function getSessionList() {
  return [...sessions.values()]
    .filter(s => s.state === 'waiting' && s.players.length < 4)
    .map(s => ({
      id: s.id,
      hostName: s.players[0]?.name || '?',
      players: s.players.length,
      canJoin: true,
      status: `${s.players.length}/4`,
    }));
}

function bcast(session, msg) {
  const data = JSON.stringify(msg);
  for (const p of session.players) if (p.ws.readyState === 1) p.ws.send(data);
}

wss.on('connection', ws => {
  let session = null, player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Player').slice(0, 24);
      if (msg.sessionId) {
        session = sessions.get(+msg.sessionId);
        if (!session || session.state !== 'waiting' || session.players.length >= 4) {
          ws.send(JSON.stringify({ type: 'error', message: 'Game not available.' }));
          return;
        }
      } else {
        session = { id: nextId++, state: 'waiting', players: [], finishCount: 0 };
        sessions.set(session.id, session);
      }
      player = { ws, name, idx: session.players.length, r: 0, c: 0, finished: false };
      session.players.push(player);
      ws.send(JSON.stringify({
        type: 'joined', sessionId: session.id, yourIdx: player.idx,
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      }));
      bcast(session, {
        type: 'lobby_update',
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      });
      return;
    }

    if (msg.type === 'start') {
      if (!session || player?.idx !== 0 || session.state !== 'waiting') return;
      const maze = generateMaze(SIZE);
      session.maze = maze;
      session.state = 'playing';
      session.startTime = Date.now();
      session.finishCount = 0;
      const spawnR = Math.floor(SIZE / 2), spawnC = Math.floor(SIZE / 2);
      for (const p of session.players) {
        p.r = spawnR; p.c = spawnC; p.finished = false; p.rank = 0;
      }
      bcast(session, {
        type: 'start',
        maze: { passages: maze.passages, exit: maze.exit, size: maze.size },
        spawn: { r: spawnR, c: spawnC },
        players: session.players.map(p => ({ idx: p.idx, name: p.name, r: p.r, c: p.c })),
      });
      return;
    }

    if (msg.type === 'move') {
      if (!session || !player || session.state !== 'playing' || player.finished) return;
      const d = +msg.dir;
      if (d < 0 || d > 3) return;
      const { passages, exit, size } = session.maze;
      if (!(passages[player.r * size + player.c] & (1 << d))) return;

      const doFinish = (path) => {
        player.finished = true;
        player.rank = ++session.finishCount;
        const elapsed = Math.round((Date.now() - session.startTime) / 1000);
        if (path.length) bcast(session, { type: 'player_path', playerIdx: player.idx, path });
        bcast(session, { type: 'finish', playerIdx: player.idx, name: player.name, rank: player.rank, elapsed });
        if (session.players.every(p => p.finished)) { session.state = 'done'; sessions.delete(session.id); }
      };

      // First step is the exit?
      if (player.r === exit.r && player.c === exit.c && d === exit.d) {
        doFinish([]);
        return;
      }

      // Take first step
      let r = player.r + DR[d], c = player.c + DC[d];
      let fromDir = OPP[d];
      const path = [{ r, c }];

      // Auto-advance through corridors — stop at branch (2+ choices) or dead end (0 choices)
      for (let steps = 0; steps < 500; steps++) {
        const avail = [0, 1, 2, 3].filter(d2 => d2 !== fromDir && (passages[r * size + c] & (1 << d2)));
        if (avail.length !== 1) break;
        const nextD = avail[0];
        // Would auto-advance step exit the maze?
        if (r === exit.r && c === exit.c && nextD === exit.d) {
          player.r = r; player.c = c;
          doFinish(path);
          return;
        }
        r += DR[nextD]; c += DC[nextD];
        fromDir = OPP[nextD];
        path.push({ r, c });
      }

      player.r = r; player.c = c;
      bcast(session, { type: 'player_path', playerIdx: player.idx, path });
      return;
    }
  });

  ws.on('close', () => {
    if (!session || !player) return;
    session.players = session.players.filter(p => p !== player);
    if (!session.players.length) { sessions.delete(session.id); return; }
    bcast(session, { type: 'player_left', playerIdx: player.idx, name: player.name });
  });
});

module.exports = { wss, getSessionList };
