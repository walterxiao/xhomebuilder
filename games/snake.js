'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const COLS = 25, ROWS = 20;
const TICK_MS = 200;
const MAX_PLAYERS = 4;
const FOOD_PER_PLAYER = 1;
const INIT_LEN = 4;
const WIN_BONUS = 5;

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
  const s = { id: nextId++, players: [], obs: [], food: [], poops: [],
    cleaner: null, cleanerTickCount: 0, cleanerTimeout: null,
    started: false, gameOver: false, interval: null };
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
  sess.cleaner = null;
  sess.cleanerTickCount = 0;
  if (sess.cleanerTimeout) clearTimeout(sess.cleanerTimeout);
  sess.cleanerTimeout = null;

  sess.players.forEach((p, i) => {
    const sp = START[i % START.length];
    const [ddx, ddy] = DIRS[OPPOSITE[sp.dir]];
    p.dir = sp.dir;
    p.nextDir = sp.dir;
    p.alive = true;
    p.score = 0;
    p.dizzy = 0;
    p.frozen = 0;
    p.body = [];
    for (let k = 0; k < INIT_LEN; k++) p.body.push({ x: sp.x + ddx*k, y: sp.y + ddy*k });
  });

  spawnFood(sess);
  bcast(sess, {
    type: 'snake_start',
    cols: COLS, rows: ROWS,
    players: sess.players.map((p, i) => ({ name: p.name, color: p.color, idx: i })),
    snakes: sess.players.map(p => ({ body: p.body, alive: true, dizzy: 0, frozen: 0 })),
    food: sess.food,
    poops: [],
    cleaner: null,
  });

  if (sess.interval) clearInterval(sess.interval);
  sess.interval = setInterval(() => tick(sess), TICK_MS);
}

// ── Collision: shrink snake by 5; kill if length reaches 0 ───────────────────
function applyCollision(p) {
  if (p.dizzy > 0) return; // immune while dizzy/frozen
  const remove = Math.min(5, p.body.length);
  p.body.splice(p.body.length - remove, remove);
  p.dizzy  = 20; // immune for 4s (covers freeze + brief post-thaw)
  p.frozen = 15; // freeze for 3s (15 × 200ms)
  if (p.body.length === 0) p.alive = false;
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(sess) {
  // 1. Apply direction and compute new heads (frozen snakes don't move)
  const newHeads = [];
  for (const p of sess.players) {
    if (!p.alive || p.frozen > 0) continue;
    p.dir = p.nextDir;
    const [dx, dy] = DIRS[p.dir];
    newHeads.push({ x: p.body[0].x + dx, y: p.body[0].y + dy, p, skip: false });
  }

  // 2. Wall + poop + cleaner collisions → shrink, don't move
  const poopKeys = new Set(sess.poops.map(p => `${p.x},${p.y}`));
  for (const h of newHeads) {
    if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS ||
        poopKeys.has(`${h.x},${h.y}`) ||
        (sess.cleaner && !sess.cleaner.leaving && h.x === sess.cleaner.x && h.y === sess.cleaner.y)) {
      applyCollision(h.p);
      h.skip = true;
    }
  }

  // 3. Body collision — build occupied set accounting for which snakes aren't moving
  const foodKeys = new Set(sess.food.map(f => `${f.x},${f.y}`));
  const bodyOcc = new Set();
  for (const p of sess.players) {
    if (!p.alive) continue;
    const h = newHeads.find(hh => hh.p === p);
    if (!h || h.skip) {
      for (const seg of p.body) bodyOcc.add(`${seg.x},${seg.y}`);
    } else {
      const willEat = foodKeys.has(`${h.x},${h.y}`);
      const end = willEat ? p.body.length : p.body.length - 1;
      for (let i = 0; i < end; i++) bodyOcc.add(`${p.body[i].x},${p.body[i].y}`);
    }
  }
  for (const h of newHeads) {
    if (h.skip || !h.p.alive) continue;
    if (bodyOcc.has(`${h.x},${h.y}`)) { applyCollision(h.p); h.skip = true; }
  }

  // 4. Head-on-head collision
  const headMap = new Map();
  for (const h of newHeads) {
    if (h.skip || !h.p.alive) continue;
    const k = `${h.x},${h.y}`;
    if (headMap.has(k)) {
      applyCollision(h.p); h.skip = true;
      applyCollision(headMap.get(k).p); headMap.get(k).skip = true;
    } else headMap.set(k, h);
  }

  // 5. Move snakes that weren't blocked
  let autoPooped = false;
  for (const h of newHeads) {
    if (h.skip || !h.p.alive) continue;
    const p = h.p;
    const k = `${h.x},${h.y}`;
    p.body.unshift({ x: h.x, y: h.y });
    if (foodKeys.has(k)) {
      p.score++;
      sess.food = sess.food.filter(f => `${f.x},${f.y}` !== k);
      // Auto-poop every 5 food: snake doesn't grow, tail becomes poop
      if (p.score % 5 === 0 && p.body.length >= 2) {
        const tail = p.body.pop();
        const poopSet = new Set(sess.poops.map(pp => `${pp.x},${pp.y}`));
        if (!poopSet.has(`${tail.x},${tail.y}`)) {
          sess.poops.push({ x: tail.x, y: tail.y });
          autoPooped = true;
        }
      }
    } else {
      p.body.pop();
    }
  }

  // 6. Decrement dizzy / frozen counters
  for (const p of sess.players) {
    if (p.frozen > 0) p.frozen--;
    if (p.dizzy  > 0) p.dizzy--;
  }

  if (autoPooped) { mergePoop(sess); scheduleCleaner(sess); }

  spawnFood(sess);

  // Move cleaner every 2 ticks
  sess.cleanerTickCount++;
  if (sess.cleaner && sess.cleanerTickCount % 2 === 0) moveCleaner(sess);

  const alive = sess.players.filter(p => p.alive);
  const total = sess.players.length;
  const ended = total <= 1 ? alive.length === 0 : alive.length <= 1;

  bcast(sess, {
    type: 'snake_tick',
    snakes: sess.players.map(p => ({ body: p.body, alive: p.alive, dizzy: p.dizzy, frozen: p.frozen })),
    food: sess.food,
    poops: sess.poops,
    cleaner: sess.cleaner,
    aliveCount: alive.length,
  });

  if (ended) {
    clearInterval(sess.interval);
    sess.interval = null;
    sess.gameOver = true;
    sess.cleaner = null;
    if (sess.cleanerTimeout) { clearTimeout(sess.cleanerTimeout); sess.cleanerTimeout = null; }
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
      scores: sess.players.map(p => ({ name: p.name, color: p.color, score: p.score, length: p.body.length })),
    });
  }
}

// ── Cleaner ───────────────────────────────────────────────────────────────────
function spawnCleaner(sess) {
  if (!sess.started || sess.gameOver || sess.cleaner || sess.poops.length < 5) return;
  const snakeOcc = new Set();
  for (const p of sess.players) if (p.alive) for (const seg of p.body) snakeOcc.add(`${seg.x},${seg.y}`);
  const taken = new Set([...snakeOcc, ...sess.food.map(f=>`${f.x},${f.y}`), ...sess.poops.map(p=>`${p.x},${p.y}`)]);

  // Prefer edge cells (dramatic entry from border)
  const edges = [];
  for (let x = 0; x < COLS; x++) { edges.push({x,y:0}); edges.push({x,y:ROWS-1}); }
  for (let y = 1; y < ROWS-1; y++) { edges.push({x:0,y}); edges.push({x:COLS-1,y}); }
  for (let i = edges.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [edges[i],edges[j]]=[edges[j],edges[i]]; }
  for (const pos of edges) {
    if (!taken.has(`${pos.x},${pos.y}`)) { sess.cleaner = { x:pos.x, y:pos.y, leaving:false }; return; }
  }
}

// Schedule cleaner to spawn 5s after the first poop appears
function scheduleCleaner(sess) {
  if (sess.cleaner || sess.cleanerTimeout || sess.poops.length < 5 || !sess.started || sess.gameOver) return;
  sess.cleanerTimeout = setTimeout(() => {
    sess.cleanerTimeout = null;
    spawnCleaner(sess);
  }, 5000);
}

// BFS from cleaner to nearest poop, avoiding snake bodies and food; returns next step or null
function cleanerNextStep(sess) {
  if (!sess.cleaner || !sess.poops.length) return null;
  const { x, y } = sess.cleaner;
  const start = `${x},${y}`;
  const snakeOcc = new Set();
  for (const p of sess.players) if (p.alive) for (const seg of p.body) snakeOcc.add(`${seg.x},${seg.y}`);
  const foodOcc = new Set(sess.food.map(f=>`${f.x},${f.y}`));
  const poopKeys = new Set(sess.poops.map(p=>`${p.x},${p.y}`));
  const ADJ = [[1,0],[-1,0],[0,1],[0,-1]];
  const parent = new Map([[start, null]]);
  const queue = [start];
  let found = null;
  bfs: while (queue.length) {
    const k = queue.shift();
    const [cx,cy] = k.split(',').map(Number);
    for (const [dx,dy] of ADJ) {
      const nx=cx+dx, ny=cy+dy;
      if (nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
      const nk=`${nx},${ny}`;
      if (parent.has(nk)) continue;
      if (snakeOcc.has(nk)||foodOcc.has(nk)) continue;  // blocked — cleaner stops
      parent.set(nk, k);
      if (poopKeys.has(nk)) { found=nk; break bfs; }
      queue.push(nk);
    }
  }
  if (!found) return null;
  // Trace back to find the first step from start
  let cur = found;
  while (parent.get(cur) !== start) { cur = parent.get(cur); if (!cur) return null; }
  const [fx,fy] = cur.split(',').map(Number);
  return { x:fx, y:fy };
}

function moveCleaner(sess) {
  if (!sess.cleaner) return;
  const { x, y, leaving } = sess.cleaner;

  if (leaving) {
    // Reached the border — exit
    if (x === 0 || x === COLS-1 || y === 0 || y === ROWS-1) { sess.cleaner = null; return; }

    // Move toward nearest edge, trying each direction in order of proximity
    const snakeOcc = new Set();
    for (const p of sess.players) if (p.alive) for (const seg of p.body) snakeOcc.add(`${seg.x},${seg.y}`);
    const foodOcc = new Set(sess.food.map(f=>`${f.x},${f.y}`));
    const opts = [
      { dx:-1, dy:0, d:x }, { dx:1, dy:0, d:COLS-1-x },
      { dx:0, dy:-1, d:y }, { dx:0, dy:1, d:ROWS-1-y },
    ].sort((a,b)=>a.d-b.d);
    for (const { dx, dy } of opts) {
      const nx=x+dx, ny=y+dy;
      if (!snakeOcc.has(`${nx},${ny}`) && !foodOcc.has(`${nx},${ny}`)) {
        sess.cleaner = { x:nx, y:ny, leaving:true };
        return;
      }
    }
    return; // all blocked — wait
  }

  // Normal mode: no poops left → start leaving
  if (!sess.poops.length) { sess.cleaner = { x, y, leaving:true }; return; }

  const next = cleanerNextStep(sess);
  if (!next) return; // blocked — wait
  sess.cleaner = { x:next.x, y:next.y, leaving:false };

  // Remove poop at new position
  const nk = `${next.x},${next.y}`;
  if (sess.poops.some(p=>`${p.x},${p.y}`===nk)) {
    sess.poops = sess.poops.filter(p=>`${p.x},${p.y}`!==nk);
    if (sess.poops.length === 0) sess.cleaner = { x:next.x, y:next.y, leaving:true };
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
      me = { ws, name, color: COLORS[0], dir: 'right', nextDir: 'right', body: [], alive: false, score: 0, dizzy: 0, frozen: 0 };
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
      me = { ws, name, color: COLORS[sess.players.length % COLORS.length], dir: 'right', nextDir: 'right', body: [], alive: false, score: 0, dizzy: 0, frozen: 0 };
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
      if (OPPOSITE[m.dir] !== me.dir) {
        me.nextDir = m.dir;
        if (me.frozen > 0) me.frozen = 0; // early thaw on direction input
      }

    } else if (m.type === 'snake_restart') {
      if (!sess || !me || sess.players[0] !== me || !sess.gameOver) return;
      startGame(sess);

    }
  });

  ws.on('close', () => {
    if (!sess) return;
    if (me) {
      me.alive = false;
      if (!sess.started || sess.gameOver) {
        sess.players = sess.players.filter(p => p !== me);
        if (sess.players.length === 0) {
          if (sess.cleanerTimeout) clearTimeout(sess.cleanerTimeout);
          sessions.delete(sess.id);
        } else bcast(sess, { type: 'snake_lobby', players: pubPlayers(sess) });
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
