'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// Classic Pac-Man-style map, 21×21
// 1=wall, 0=dot, 2=power pellet, 3=empty(no dot), 4=ghost house
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

// Spawn positions for up to 4 pacmen
const PAC_SPAWNS = [
  { r: 16, c: 10 },
  { r: 14, c: 10 },
  { r: 16, c:  8 },
  { r: 16, c: 12 },
];

const GHOST_SPAWN = { r: 9, c: 10 };

// Directions
const DR4 = [-1, 0, 1, 0];
const DC4 = [0, 1, 0, -1];

function countDots(map) {
  return map.reduce((acc, row) => acc + row.filter(c => c === 0 || c === 2).length, 0);
}

function makeMap() {
  return MAP_TEMPLATE.map(row => [...row]);
}

let nextId = 2000;
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

function canMove(map, r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS && map[r][c] !== 1 && map[r][c] !== 4;
}

// Ghost AI: simple chase/scatter
function ghostAI(ghost, players, map, tick) {
  // Scatter every 20 ticks, chase otherwise (simplified)
  const scatter = (Math.floor(tick / 20) % 3 === 2);
  let tr, tc;

  if (ghost.frightened) {
    // random valid direction
    const dirs = [0,1,2,3].filter(d => {
      const nr = ghost.r + DR4[d], nc = ghost.c + DC4[d];
      return d !== ghost.lastDir && canMove(map, nr, nc);
    });
    if (!dirs.length) return;
    const d = dirs[Math.floor(Math.random() * dirs.length)];
    ghost.lastDir = d;
    ghost.r += DR4[d]; ghost.c += DC4[d];
    return;
  }

  if (scatter) {
    // scatter to corners
    const corners = [{ r:0,c:0},{ r:0,c:COLS-1},{ r:ROWS-1,c:0},{ r:ROWS-1,c:COLS-1}];
    const corner = corners[ghost.idx % 4];
    tr = corner.r; tc = corner.c;
  } else {
    // chase nearest player
    let best = Infinity, bp = null;
    for (const p of players) {
      if (p.dead) continue;
      const d = Math.abs(p.r - ghost.r) + Math.abs(p.c - ghost.c);
      if (d < best) { best = d; bp = p; }
    }
    if (!bp) return;
    tr = bp.r; tc = bp.c;
  }

  // Pick direction minimizing distance to target (no reverse)
  const opposite = [2, 3, 0, 1];
  let bestDist = Infinity, bestDir = -1;
  for (let d = 0; d < 4; d++) {
    if (d === opposite[ghost.lastDir] && ghost.lastDir !== -1) continue;
    const nr = ghost.r + DR4[d], nc = ghost.c + DC4[d];
    if (!canMove(map, nr, nc)) continue;
    const dist = Math.abs(nr - tr) + Math.abs(nc - tc);
    if (dist < bestDist) { bestDist = dist; bestDir = d; }
  }
  if (bestDir === -1) return;
  ghost.lastDir = bestDir;
  ghost.r += DR4[bestDir]; ghost.c += DC4[bestDir];
}

function startGameLoop(session) {
  let tick = 0;
  session.tick = tick;

  session.interval = setInterval(() => {
    if (session.state !== 'playing') { clearInterval(session.interval); return; }
    tick++;
    session.tick = tick;

    const { map, ghosts, players } = session;

    // Move ghosts every 2 ticks (slower than players)
    if (tick % 2 === 0) {
      for (const g of ghosts) {
        if (g.frightened && --g.frightenedTicks <= 0) g.frightened = false;
        ghostAI(g, players, map, tick);
      }
    }

    // Check ghost-player collisions
    const updates = [];
    for (const p of players) {
      if (p.dead) continue;
      for (const g of ghosts) {
        if (g.r === p.r && g.c === p.c) {
          if (g.frightened) {
            // eat ghost
            g.r = GHOST_SPAWN.r; g.c = GHOST_SPAWN.c;
            g.frightened = false;
            p.score += 200;
            bcast(session, { type: 'ghost_eaten', ghostIdx: g.idx, playerIdx: p.idx, score: p.score });
          } else {
            // player dies
            p.dead = true;
            p.lives--;
            updates.push({ type: 'player_died', playerIdx: p.idx, lives: p.lives });
          }
        }
      }
    }
    for (const u of updates) bcast(session, u);

    // Check win/lose
    if (session.dotsLeft === 0) {
      session.state = 'done';
      sessions.delete(session.id);
      bcast(session, { type: 'game_over', win: true, scores: players.map(p => ({ idx: p.idx, name: p.name, score: p.score })) });
      clearInterval(session.interval);
      return;
    }
    if (players.every(p => p.lives <= 0)) {
      session.state = 'done';
      sessions.delete(session.id);
      bcast(session, { type: 'game_over', win: false, scores: players.map(p => ({ idx: p.idx, name: p.name, score: p.score })) });
      clearInterval(session.interval);
      return;
    }

    // Send ghost positions every tick
    bcast(session, {
      type: 'tick',
      tick,
      ghosts: ghosts.map(g => ({ idx: g.idx, r: g.r, c: g.c, frightened: g.frightened })),
    });
  }, 200); // 5 ticks/sec for ghosts
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
      bcast(session, {
        type: 'lobby_update',
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      });
      return;
    }

    if (msg.type === 'start') {
      if (!session || player?.idx !== 0 || session.state !== 'waiting') return;
      const map = makeMap();
      const dotsLeft = countDots(map);
      session.map = map;
      session.dotsLeft = dotsLeft;
      session.state = 'playing';

      const numPlayers = session.players.length;
      for (let i = 0; i < numPlayers; i++) {
        const sp = PAC_SPAWNS[i];
        session.players[i].r = sp.r;
        session.players[i].c = sp.c;
        session.players[i].dead = false;
        session.players[i].lives = 3;
        session.players[i].score = 0;
        session.players[i].dir = -1;
        session.players[i].nextDir = -1;
      }

      // Create 4 ghosts
      session.ghosts = GHOST_NAMES.map((name, i) => ({
        idx: i, name, color: GHOST_COLORS[i],
        r: GHOST_SPAWN.r + (i < 2 ? 0 : 1),
        c: GHOST_SPAWN.c + (i % 2 === 0 ? 0 : 1),
        frightened: false, frightenedTicks: 0, lastDir: -1,
      }));

      bcast(session, {
        type: 'start',
        map: map.map(r => [...r]),
        dotsLeft,
        players: session.players.map(p => ({ idx: p.idx, name: p.name, r: p.r, c: p.c, lives: p.lives, score: p.score })),
        ghosts: session.ghosts.map(g => ({ idx: g.idx, name: g.name, color: g.color, r: g.r, c: g.c })),
      });

      startGameLoop(session);
      return;
    }

    if (msg.type === 'dir') {
      if (!session || !player || session.state !== 'playing' || player.dead) return;
      const d = +msg.dir;
      if (d < 0 || d > 3) return;
      player.nextDir = d;

      // Try to move immediately
      const { map } = session;
      // Try nextDir first, then current dir
      let moved = false;
      for (const tryDir of [player.nextDir, player.dir]) {
        if (tryDir < 0) continue;
        const nr = player.r + DR4[tryDir], nc = player.c + DC4[tryDir];
        if (canMove(map, nr, nc)) {
          player.dir = tryDir;
          player.r = nr; player.c = nc;
          moved = true;
          break;
        }
      }

      if (!moved) return;

      // Eat dot/pellet
      let scoreGain = 0;
      const cell = map[player.r][player.c];
      if (cell === 0) {
        map[player.r][player.c] = 3;
        session.dotsLeft--;
        scoreGain = 10;
        player.score += 10;
      } else if (cell === 2) {
        map[player.r][player.c] = 3;
        session.dotsLeft--;
        scoreGain = 50;
        player.score += 50;
        // Frighten ghosts
        for (const g of session.ghosts) {
          g.frightened = true;
          g.frightenedTicks = 25; // 5 seconds at 5tps
        }
        bcast(session, { type: 'power', playerIdx: player.idx });
      }

      bcast(session, {
        type: 'move',
        playerIdx: player.idx,
        r: player.r, c: player.c,
        score: player.score,
        scoreGain,
        dotsLeft: session.dotsLeft,
        cell,
      });

      // Check ghost collision after move
      for (const g of session.ghosts) {
        if (g.r === player.r && g.c === player.c) {
          if (g.frightened) {
            g.r = GHOST_SPAWN.r; g.c = GHOST_SPAWN.c;
            g.frightened = false;
            player.score += 200;
            bcast(session, { type: 'ghost_eaten', ghostIdx: g.idx, playerIdx: player.idx, score: player.score });
          } else if (!player.dead) {
            player.dead = true;
            player.lives--;
            bcast(session, { type: 'player_died', playerIdx: player.idx, lives: player.lives });
          }
        }
      }
      return;
    }

    if (msg.type === 'respawn') {
      if (!session || !player || session.state !== 'playing') return;
      if (!player.dead || player.lives <= 0) return;
      const sp = PAC_SPAWNS[player.idx];
      player.r = sp.r; player.c = sp.c;
      player.dead = false;
      player.dir = -1; player.nextDir = -1;
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
