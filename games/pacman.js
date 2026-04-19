'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// 22×21 classic-style map
// 1=wall, 0=dot, 2=power pellet, 3=empty, 4=ghost house interior
const MAP_TEMPLATE = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,2,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,2,1],
  [1,0,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,1,0,1,1,1,1,1,1,1,0,1,0,1,1,0,1],
  [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  [1,1,1,1,0,1,1,1,3,1,1,1,3,1,1,1,0,1,1,1,1],
  [1,1,1,1,0,1,3,3,3,3,3,3,3,3,3,1,0,1,1,1,1],
  [1,1,1,1,0,1,3,1,1,4,4,4,1,1,3,1,0,1,1,1,1],
  [3,3,3,3,0,3,3,1,4,4,4,4,4,1,3,3,0,3,3,3,3],
  [1,1,1,1,0,1,3,1,1,1,1,1,1,1,3,1,0,1,1,1,1],
  [1,1,1,1,0,1,3,3,3,3,3,3,3,3,3,1,0,1,1,1,1],
  [1,1,1,1,0,1,3,1,1,1,1,1,1,1,3,1,0,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,0,1],
  [1,2,0,1,0,0,0,0,0,0,3,0,0,0,0,0,0,1,0,2,1],
  [1,1,0,1,0,1,0,1,1,1,1,1,1,1,0,1,0,1,0,1,1],
  [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  [1,0,1,1,1,1,1,1,0,1,1,1,0,1,1,1,1,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];
const ROWS = MAP_TEMPLATE.length;
const COLS = MAP_TEMPLATE[0].length;

const GHOST_COLORS = ['#FF0000', '#FFB8FF', '#00FFFF', '#FFB852'];
const GHOST_NAMES  = ['Blinky', 'Pinky', 'Inky', 'Clyde'];

const PAC_SPAWNS = [
  { r: 16, c: 10 },
  { r: 14, c: 10 },
  { r: 16, c:  8 },
  { r: 16, c: 12 },
];
const GHOST_SPAWN = { r: 9, c: 10 };

const DR4 = [-1, 0, 1, 0]; // N E S W
const DC4 = [0, 1, 0, -1];
const OPP4 = [2, 3, 0, 1];

const WALL = 1, DOT = 0, POWER = 2, EMPTY = 3, GHOST_HOUSE = 4;
const CHASE_DIST = 9; // Manhattan distance to switch ghost to chase mode

function makeMap() { return MAP_TEMPLATE.map(row => [...row]); }

function countDots(map) {
  return map.reduce((acc, row) => acc + row.filter(c => c === DOT || c === POWER).length, 0);
}

function canMove(map, r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS &&
         map[r][c] !== WALL && map[r][c] !== GHOST_HOUSE;
}

// Ghost movement helpers
function chaseTarget(ghost, tr, tc, map) {
  const opp = OPP4[ghost.lastDir];
  let bestDist = Infinity, bestDir = -1;
  for (let d = 0; d < 4; d++) {
    if (d === opp && ghost.lastDir !== -1) continue;
    const nr = ghost.r + DR4[d], nc = ghost.c + DC4[d];
    if (!canMove(map, nr, nc)) continue;
    const dist = Math.abs(nr - tr) + Math.abs(nc - tc);
    if (dist < bestDist) { bestDist = dist; bestDir = d; }
  }
  if (bestDir !== -1) { ghost.lastDir = bestDir; ghost.r += DR4[bestDir]; ghost.c += DC4[bestDir]; }
}

function randomMove(ghost, map) {
  const opp = OPP4[ghost.lastDir];
  const dirs = [0, 1, 2, 3].filter(d => {
    if (d === opp && ghost.lastDir !== -1) return false;
    return canMove(map, ghost.r + DR4[d], ghost.c + DC4[d]);
  });
  // If no non-reversing option, allow reversal
  const choices = dirs.length ? dirs : [0, 1, 2, 3].filter(d =>
    canMove(map, ghost.r + DR4[d], ghost.c + DC4[d])
  );
  if (!choices.length) return;
  const d = choices[Math.floor(Math.random() * choices.length)];
  ghost.lastDir = d;
  ghost.r += DR4[d]; ghost.c += DC4[d];
}

function ghostAI(ghost, players, map) {
  if (ghost.frightened) {
    randomMove(ghost, map);
    return;
  }
  // Find nearest living player
  let nearestDist = Infinity, nearest = null;
  for (const p of players) {
    if (p.dead) continue;
    const d = Math.abs(p.r - ghost.r) + Math.abs(p.c - ghost.c);
    if (d < nearestDist) { nearestDist = d; nearest = p; }
  }
  if (nearest && nearestDist <= CHASE_DIST) {
    chaseTarget(ghost, nearest.r, nearest.c, map);
  } else {
    randomMove(ghost, map);
  }
}

let nextId = 2000;
const sessions = new Map();

function getSessionList() {
  return [...sessions.values()]
    .filter(s => s.state === 'waiting' && s.players.length < 4)
    .map(s => ({
      id: s.id, hostName: s.players[0]?.name || '?',
      players: s.players.length, canJoin: true, status: `${s.players.length}/4`,
    }));
}

function bcast(session, msg) {
  const data = JSON.stringify(msg);
  for (const p of session.players) if (p.ws.readyState === 1) p.ws.send(data);
}

function startGameLoop(session) {
  let tick = 0;
  session.interval = setInterval(() => {
    if (session.state !== 'playing') { clearInterval(session.interval); return; }
    tick++;

    const { map, ghosts, players } = session;
    const playerUpdates = [];
    const powerEvents   = [];

    // ── Move players ──────────────────────────────────────────────────────────
    for (const p of players) {
      if (p.dead) continue;

      // Try nextDir first (corner-turning), then current dir
      let moved = false;
      for (const tryDir of [p.nextDir, p.dir]) {
        if (tryDir < 0) continue;
        const nr = p.r + DR4[tryDir], nc = p.c + DC4[tryDir];
        if (canMove(map, nr, nc)) {
          p.dir = tryDir;
          p.r = nr; p.c = nc;
          moved = true;
          break;
        }
      }

      // Eat dot / power pellet at new position
      let scoreGain = 0;
      const cell = map[p.r][p.c];
      if (cell === DOT) {
        map[p.r][p.c] = EMPTY;
        session.dotsLeft--;
        scoreGain = 10;
        p.score += 10;
      } else if (cell === POWER) {
        map[p.r][p.c] = EMPTY;
        session.dotsLeft--;
        scoreGain = 50;
        p.score += 50;
        for (const g of ghosts) { g.frightened = true; g.frightenedTicks = 30; }
        powerEvents.push({ type: 'power', playerIdx: p.idx });
      }

      playerUpdates.push({
        idx: p.idx, r: p.r, c: p.c,
        score: p.score, scoreGain,
        ate: (cell === DOT || cell === POWER) ? { r: p.r, c: p.c, was: cell } : null,
      });
    }

    // ── Move ghosts every 4 ticks (~1.7 moves/sec vs player's 6.7) ────────────
    if (tick % 4 === 0) {
      for (const g of ghosts) {
        if (g.frightened && --g.frightenedTicks <= 0) g.frightened = false;
        ghostAI(g, players, map);
      }
    }

    // ── Check collisions ──────────────────────────────────────────────────────
    const deathEvents = [];
    for (const p of players) {
      if (p.dead) continue;
      for (const g of ghosts) {
        if (g.r !== p.r || g.c !== p.c) continue;
        if (g.frightened) {
          g.r = GHOST_SPAWN.r; g.c = GHOST_SPAWN.c; g.frightened = false;
          p.score += 200;
          bcast(session, { type: 'ghost_eaten', ghostIdx: g.idx, playerIdx: p.idx, score: p.score });
        } else {
          p.dead = true; p.lives--;
          deathEvents.push({ type: 'player_died', playerIdx: p.idx, lives: p.lives });
        }
      }
    }

    // ── Broadcast ─────────────────────────────────────────────────────────────
    for (const ev of powerEvents) bcast(session, ev);
    bcast(session, {
      type: 'tick',
      players: playerUpdates,
      ghosts: ghosts.map(g => ({ idx: g.idx, r: g.r, c: g.c, frightened: g.frightened })),
      dotsLeft: session.dotsLeft,
    });
    for (const ev of deathEvents) bcast(session, ev);

    // ── End conditions ────────────────────────────────────────────────────────
    if (session.dotsLeft === 0) {
      session.state = 'done'; sessions.delete(session.id);
      bcast(session, { type: 'game_over', win: true, scores: players.map(p => ({ idx: p.idx, name: p.name, score: p.score })) });
      clearInterval(session.interval);
    } else if (players.every(p => p.lives <= 0)) {
      session.state = 'done'; sessions.delete(session.id);
      bcast(session, { type: 'game_over', win: false, scores: players.map(p => ({ idx: p.idx, name: p.name, score: p.score })) });
      clearInterval(session.interval);
    }
  }, 150); // ~6.7 moves/sec
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
        session = { id: nextId++, state: 'waiting', players: [] };
        sessions.set(session.id, session);
      }
      player = { ws, name, idx: session.players.length, r: 0, c: 0, dead: false, lives: 3, score: 0, dir: -1, nextDir: -1 };
      session.players.push(player);
      ws.send(JSON.stringify({
        type: 'joined', sessionId: session.id, yourIdx: player.idx,
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      }));
      bcast(session, { type: 'lobby_update', players: session.players.map(p => ({ idx: p.idx, name: p.name })) });
      return;
    }

    if (msg.type === 'start') {
      if (!session || player?.idx !== 0 || session.state !== 'waiting') return;
      const map = makeMap();
      session.map = map;
      session.dotsLeft = countDots(map);
      session.state = 'playing';
      for (let i = 0; i < session.players.length; i++) {
        const p = session.players[i], sp = PAC_SPAWNS[i];
        p.r = sp.r; p.c = sp.c; p.dead = false; p.lives = 3; p.score = 0; p.dir = -1; p.nextDir = -1;
      }
      session.ghosts = GHOST_NAMES.map((name, i) => ({
        idx: i, name, color: GHOST_COLORS[i],
        r: GHOST_SPAWN.r + (i < 2 ? 0 : 1),
        c: GHOST_SPAWN.c + (i % 2 === 0 ? 0 : 1),
        frightened: false, frightenedTicks: 0, lastDir: -1,
      }));
      bcast(session, {
        type: 'start',
        map: map.map(r => [...r]),
        dotsLeft: session.dotsLeft,
        players: session.players.map(p => ({ idx: p.idx, name: p.name, r: p.r, c: p.c, lives: p.lives, score: p.score })),
        ghosts: session.ghosts.map(g => ({ idx: g.idx, name: g.name, color: g.color, r: g.r, c: g.c })),
      });
      startGameLoop(session);
      return;
    }

    // Player sends desired direction — server applies it on next tick
    if (msg.type === 'dir') {
      if (!session || !player || session.state !== 'playing' || player.dead) return;
      const d = +msg.dir;
      if (d >= 0 && d <= 3) player.nextDir = d;
      return;
    }

    if (msg.type === 'respawn') {
      if (!session || !player || session.state !== 'playing') return;
      if (!player.dead || player.lives <= 0) return;
      const sp = PAC_SPAWNS[player.idx];
      player.r = sp.r; player.c = sp.c; player.dead = false; player.dir = -1; player.nextDir = -1;
      bcast(session, { type: 'respawn', playerIdx: player.idx, r: player.r, c: player.c, lives: player.lives });
      return;
    }
  });

  ws.on('close', () => {
    if (!session || !player) return;
    session.players = session.players.filter(p => p !== player);
    if (!session.players.length) {
      if (session.interval) clearInterval(session.interval);
      sessions.delete(session.id);
      return;
    }
    bcast(session, { type: 'player_left', playerIdx: player.idx, name: player.name });
  });
});

module.exports = { wss, getSessionList };
