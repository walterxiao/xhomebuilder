'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const COLS = 25, ROWS = 20;
const TICK_MS = 140;
const MAX_PLAYERS = 4;
const FOOD_PER_PLAYER = 2;
const INIT_LEN = 4;
const WIN_BONUS = 5;
const POOP_COOLDOWN_MS = 2500;

const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
const OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };
const COLORS = ['#44aaff','#ffaa22','#44ee88','#ff4488'];
const START = [
  { x:3,  y:3,        dir:'right' },
  { x:COLS-4, y:ROWS-4, dir:'left'  },
  { x:COLS-4, y:3,      dir:'down'  },
  { x:3,  y:ROWS-4,   dir:'up'    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function bcast(sess, o) {
  const m = JSON.stringify(o);
  for (const p of sess.players) if (p.ws.readyState === 1) p.ws.send(m);
  for (const ob of sess.obs)    if (ob.ws.readyState === 1) ob.ws.send(m);
}

function pubPlayers(sess) {
  return sess.players.map(p => ({ name: p.name, color: p.color }));
}

// ── Session factory ───────────────────────────────────────────────────────────
let nextId = 1;
const sessions = new Map();

function mkSess() {
  const s = { id: nextId++, players: [], obs: [], food: [], poops: [], started: false, gameOver: false, interval: null };
  sessions.set(s.id, s);
  return s;
}

// ── Food ─────────────────────────────────────────────────────────────────────
function occupiedSet(sess) {
  const s = new Set();
  for (const p of sess.players) if (p.alive) for (const c of p.body) s.add(`${c.x},${c.y}`);
  for (const f of sess.food)  s.add(`${f.x},${f.y}`);
  for (const p of sess.poops) s.add(`${p.x},${p.y}`);
  return s;
}

function spawnFood(sess) {
  const target = Math.max(2, sess.players.filter(p => p.alive).length * FOOD_PER_PLAYER);
  const occ = occupiedSet(sess);
  let attempts = 0;
  while (sess.food.length < target && attempts++ < 2000) {
    const x = Math.floor(Math.random() * COLS);
    const y = Math.floor(Math.random() * ROWS);
    const k = `${x},${y}`;
    if (!occ.has(k)) { sess.food.push({ x, y }); occ.add(k); }
  }
}

// ── Game start ────────────────────────────────────────────────────────────────
function startGame(sess) {
  sess.started = true;
  sess.gameOver = false;
  sess.food = [];
  sess.poops = [];

  sess.players.forEach((p, i) => {
    const sp = START[i % START.length];
    const [ddx, ddy] = DIRS[OPPOSITE[sp.dir]];
    p.dir = sp.dir;
    p.nextDir = sp.dir;
    p.alive = true;
    p.score = 0;
    p.body = [];
    for (let k = 0; k < INIT_LEN; k++) p.body.push({ x: sp.x + ddx*k, y: sp.y + ddy*k });
  });

  spawnFood(sess);
  bcast(sess, {
    type: 'snake_start',
    cols: COLS, rows: ROWS,
    players: sess.players.map((p, i) => ({ name: p.name, color: p.color, idx: i })),
    snakes: sess.players.map(p => ({ body: p.body, alive: true })),
    food: sess.food,
    poops: [],
    scores: sess.players.map(() => 0),
  });

  if (sess.interval) clearInterval(sess.interval);
  sess.interval = setInterval(() => tick(sess), TICK_MS);
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(sess) {
  // 1. Apply direction and compute new heads
  const newHeads = [];
  for (const p of sess.players) {
    if (!p.alive) continue;
    p.dir = p.nextDir;
    const [dx, dy] = DIRS[p.dir];
    newHeads.push({ x: p.body[0].x + dx, y: p.body[0].y + dy, p });
  }

  // 2. Wall + poop collisions
  const poopKeys = new Set(sess.poops.map(p => `${p.x},${p.y}`));
  for (const h of newHeads) {
    if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS) h.p.alive = false;
    else if (poopKeys.has(`${h.x},${h.y}`)) h.p.alive = false;
  }

  // 3. Body collision (against current bodies excluding tail — tail will move away unless food eaten)
  const foodKeys = new Set(sess.food.map(f => `${f.x},${f.y}`));
  const bodyOcc = new Set();
  for (const p of sess.players) {
    if (!p.alive) continue;
    const ate = foodKeys.has(`${p.body[0].x + DIRS[p.dir][0]},${p.body[0].y + DIRS[p.dir][1]}`);
    const end = ate ? p.body.length : p.body.length - 1;
    for (let i = 0; i < end; i++) bodyOcc.add(`${p.body[i].x},${p.body[i].y}`);
  }
  for (const h of newHeads) {
    if (!h.p.alive) continue;
    if (bodyOcc.has(`${h.x},${h.y}`)) h.p.alive = false;
  }

  // 4. Head-on-head collision
  const headMap = new Map();
  for (const h of newHeads) {
    if (!h.p.alive) continue;
    const k = `${h.x},${h.y}`;
    if (headMap.has(k)) { h.p.alive = false; headMap.get(k).p.alive = false; }
    else headMap.set(k, h);
  }

  // 5. Move snakes
  for (const h of newHeads) {
    const p = h.p;
    if (!p.alive) continue;
    const k = `${h.x},${h.y}`;
    p.body.unshift({ x: h.x, y: h.y });
    if (foodKeys.has(k)) {
      p.score++;
      sess.food = sess.food.filter(f => `${f.x},${f.y}` !== k);
    } else {
      p.body.pop();
    }
  }

  spawnFood(sess);

  const alive = sess.players.filter(p => p.alive);
  const total = sess.players.length;
  const ended = total <= 1 ? alive.length === 0 : alive.length <= 1;

  bcast(sess, {
    type: 'snake_tick',
    snakes: sess.players.map(p => ({ body: p.body, alive: p.alive })),
    food: sess.food,
    poops: sess.poops,
    scores: sess.players.map(p => p.score),
    aliveCount: alive.length,
  });

  if (ended) {
    clearInterval(sess.interval);
    sess.interval = null;
    sess.gameOver = true;
    let winner = null;
    if (alive.length === 1) { alive[0].score += WIN_BONUS; winner = alive[0].name; }
    else {
      const best = Math.max(...sess.players.map(p => p.score));
      const tops = sess.players.filter(p => p.score === best);
      if (tops.length === 1) winner = tops[0].name;
    }
    bcast(sess, {
      type: 'snake_over',
      winner,
      scores: sess.players.map(p => ({ name: p.name, color: p.color, score: p.score })),
    });
  }
}

// ── Poop merging ──────────────────────────────────────────────────────────────
// If a connected poop group fills > 2/3 of its bounding rectangle, expand to
// fill the entire rectangle. Repeat until stable.
function mergePoop(sess) {
  const ADJ = [[1,0],[-1,0],[0,1],[0,-1]];
  let changed = true;
  while (changed) {
    changed = false;
    const poopSet = new Set(sess.poops.map(p => `${p.x},${p.y}`));
    const visited = new Set();

    for (const start of sess.poops) {
      const sk = `${start.x},${start.y}`;
      if (visited.has(sk)) continue;

      // BFS to find connected component
      const comp = [];
      const q = [start];
      visited.add(sk);
      while (q.length) {
        const c = q.shift();
        comp.push(c);
        for (const [dx, dy] of ADJ) {
          const nk = `${c.x+dx},${c.y+dy}`;
          if (poopSet.has(nk) && !visited.has(nk)) { visited.add(nk); q.push({x:c.x+dx, y:c.y+dy}); }
        }
      }

      const minX = Math.min(...comp.map(p => p.x));
      const maxX = Math.max(...comp.map(p => p.x));
      const minY = Math.min(...comp.map(p => p.y));
      const maxY = Math.max(...comp.map(p => p.y));
      const area = (maxX - minX + 1) * (maxY - minY + 1);

      // Fill if count > 2/3 of bounding rect
      if (comp.length * 3 > area * 2) {
        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
            const k = `${x},${y}`;
            if (!poopSet.has(k)) { sess.poops.push({x, y}); poopSet.add(k); changed = true; }
          }
        }
      }
    }
  }

  // Remove food covered by (possibly expanded) poops
  const finalSet = new Set(sess.poops.map(p => `${p.x},${p.y}`));
  sess.food = sess.food.filter(f => !finalSet.has(`${f.x},${f.y}`));
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let sess = null, me = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'snake_create') {
      if (sess) return;
      const name = String(m.name || '').trim().slice(0, 24);
      if (!name) return;
      sess = mkSess();
      me = { ws, name, color: COLORS[0], dir: 'right', nextDir: 'right', body: [], alive: false, score: 0, lastPoop: 0 };
      sess.players.push(me);
      send(ws, { type: 'snake_waiting', sessionId: sess.id, players: pubPlayers(sess) });

    } else if (m.type === 'snake_join') {
      if (sess) return;
      const name = String(m.name || '').trim().slice(0, 24);
      if (!name) return;
      const target = sessions.get(+m.sessionId);
      if (!target) return send(ws, { type: 'snake_err', message: 'Session not found.' });
      if (target.started) return send(ws, { type: 'snake_err', message: 'Game already started.' });
      if (target.players.length >= MAX_PLAYERS) return send(ws, { type: 'snake_err', message: 'Session is full.' });
      sess = target;
      me = { ws, name, color: COLORS[sess.players.length % COLORS.length], dir: 'right', nextDir: 'right', body: [], alive: false, score: 0, lastPoop: 0 };
      sess.players.push(me);
      bcast(sess, { type: 'snake_lobby', players: pubPlayers(sess) });
      send(ws, { type: 'snake_waiting', sessionId: sess.id, players: pubPlayers(sess) });

    } else if (m.type === 'snake_observe') {
      if (sess) return;
      const name = String(m.name || '').trim().slice(0, 24);
      const sid = +m.sessionId;
      const target = sessions.get(sid) || [...sessions.values()].find(s => !s.gameOver);
      if (!target) return send(ws, { type: 'snake_err', message: 'No active sessions.' });
      sess = target;
      sess.obs.push({ ws, name });
      send(ws, { type: 'snake_observing', sessionId: sess.id });

    } else if (m.type === 'snake_start') {
      if (!sess || !me || sess.players[0] !== me || sess.started) return;
      startGame(sess);

    } else if (m.type === 'direction') {
      if (!me || !me.alive || !DIRS[m.dir]) return;
      if (OPPOSITE[m.dir] !== me.dir) me.nextDir = m.dir;

    } else if (m.type === 'snake_restart') {
      if (!sess || !me || sess.players[0] !== me || !sess.gameOver) return;
      startGame(sess);

    } else if (m.type === 'poop') {
      if (!me || !me.alive || !sess.started || sess.gameOver) return;
      if (me.body.length < 2) return;  // need at least head + 1 segment
      const now = Date.now();
      if (now - me.lastPoop < POOP_COOLDOWN_MS) return;

      // Shorten snake by removing tail, poop at that position
      const tail = me.body.pop();
      const pos = { x: tail.x, y: tail.y };

      // Skip if a poop already exists there
      const existing = new Set(sess.poops.map(p => `${p.x},${p.y}`));
      if (existing.has(`${pos.x},${pos.y}`)) { me.body.push(tail); return; }

      me.lastPoop = now;
      sess.poops.push(pos);
      mergePoop(sess);

      bcast(sess, { type: 'snake_tick',
        snakes: sess.players.map(p => ({ body: p.body, alive: p.alive })),
        food: sess.food,
        poops: sess.poops,
        scores: sess.players.map(p => p.score),
        aliveCount: sess.players.filter(p => p.alive).length,
      });
    }
  });

  ws.on('close', () => {
    if (!sess) return;
    if (me) {
      me.alive = false;
      if (!sess.started || sess.gameOver) {
        sess.players = sess.players.filter(p => p !== me);
        if (sess.players.length === 0) { sessions.delete(sess.id); }
        else bcast(sess, { type: 'snake_lobby', players: pubPlayers(sess) });
      }
    } else {
      sess.obs = sess.obs.filter(o => o.ws !== ws);
    }
  });

  ws.on('error', () => {});
});

// ── Session list API ──────────────────────────────────────────────────────────
function getSessionList() {
  return [...sessions.values()].filter(s => !s.gameOver).map(s => ({
    id: s.id,
    hostName: s.players[0] ? s.players[0].name : '?',
    players: s.players.length,
    maxPlayers: MAX_PLAYERS,
    observers: s.obs.length,
    canJoin: !s.started && s.players.length < MAX_PLAYERS,
    canObserve: true,
    status: s.started ? 'playing' : 'waiting',
    label: s.started
      ? `${s.players.filter(p => p.alive).length} alive / ${s.players.length} total`
      : `${s.players.length}/${MAX_PLAYERS} players`,
  }));
}

module.exports = { wss, getSessionList };
