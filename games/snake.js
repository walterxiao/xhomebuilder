'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const COLS = 25, ROWS = 20;
const TICK_MS = 100;
const MOVE_EVERY = 3;   // snakes advance 1 cell every MOVE_EVERY ticks = 300ms
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
    elephant: null, elephantTimer: null, elephantCount: 0,
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
  const target = sess.players.filter(p => p.alive).length * FOOD_PER_PLAYER;
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
  if (sess.elephantTimer) clearInterval(sess.elephantTimer);
  sess.elephantTimer = setInterval(() => spawnElephant(sess), 30000);
  sess.elephant = null;
  sess.elephantCount = 0;
  sess.elephantPoopCols = null;
  sess.tickCount = 0;
  sess.countdownTicks = 50; // 5 s at TICK_MS=100ms

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
    elephant: null,
    countdown: Math.ceil(sess.countdownTicks * TICK_MS / 1000),
  });

  if (sess.interval) clearInterval(sess.interval);
  sess.interval = setInterval(() => tick(sess), TICK_MS);
}

// ── Collision: shrink snake by 5; kill if length reaches 0 ───────────────────
function applyCollision(p) {
  if (p.dizzy > 0) return; // immune while dizzy/frozen
  const remove = Math.min(3, p.body.length);
  p.body.splice(p.body.length - remove, remove);
  p.dizzy  = 20; // immune for 4s (covers freeze + brief post-thaw)
  p.frozen = 15; // freeze for 3s (15 × 200ms)
  if (p.body.length === 0) p.alive = false;
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(sess) {
  sess.tickCount++;

  // Countdown phase — snakes don't move, broadcast countdown seconds
  if (sess.countdownTicks > 0) {
    const prevSec = Math.ceil(sess.countdownTicks * TICK_MS / 1000);
    sess.countdownTicks--;
    const newSec = Math.ceil(sess.countdownTicks * TICK_MS / 1000);
    if (newSec !== prevSec || sess.countdownTicks === 0) {
      bcast(sess, { type: 'snake_countdown', seconds: newSec });
    }
    return;
  }

  const doMove = (sess.tickCount % MOVE_EVERY === 0);

  let autoPooped = false;

  if (doMove) {
    // 1. Apply direction and compute new heads (frozen snakes don't move)
    const newHeads = [];
    for (const p of sess.players) {
      if (!p.alive || p.frozen > 0) continue;
      p.dir = p.nextDir;
      const [dx, dy] = DIRS[p.dir];
      newHeads.push({ x: p.body[0].x + dx, y: p.body[0].y + dy, p, skip: false });
    }

    // 2. Wall + poop + cleaner + elephant collisions → shrink, don't move
    const poopKeys = new Set(sess.poops.map(p => `${p.x},${p.y}`));
    for (const h of newHeads) {
      const hitElephant = sess.elephant &&
        h.x >= sess.elephant.lx && h.x < sess.elephant.lx + sess.elephant.size &&
        h.y >= sess.elephant.ly && h.y < sess.elephant.ly + sess.elephant.size;
      if (h.x < 0 || h.x >= COLS || h.y < 0 || h.y >= ROWS ||
          poopKeys.has(`${h.x},${h.y}`) ||
          (sess.cleaner && !sess.cleaner.leaving && h.x === sess.cleaner.x && h.y === sess.cleaner.y) ||
          hitElephant) {
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
    for (const h of newHeads) {
      if (h.skip || !h.p.alive) continue;
      const p = h.p;
      const k = `${h.x},${h.y}`;
      p.body.unshift({ x: h.x, y: h.y });
      if (foodKeys.has(k)) {
        p.score++;
        sess.food = sess.food.filter(f => `${f.x},${f.y}` !== k);
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

    // 6. Decrement dizzy / frozen counters (counts in move-ticks, same real durations)
    for (const p of sess.players) {
      if (p.frozen > 0) p.frozen--;
      if (p.dizzy  > 0) p.dizzy--;
    }

    if (autoPooped) scheduleCleaner(sess);
    spawnFood(sess);

    // Move cleaner + elephant every 2 move-ticks (= 600ms)
    sess.cleanerTickCount++;
    if (sess.cleanerTickCount % 2 === 0) {
      if (sess.cleaner) moveCleaner(sess);
      if (sess.elephant) moveElephant(sess);
    }
  }

  const alive = sess.players.filter(p => p.alive);
  const total = sess.players.length;
  const ended = doMove && (total <= 1 ? alive.length === 0 : alive.length <= 1);

  bcast(sess, {
    type: 'snake_tick',
    moved: doMove,
    snakes: sess.players.map(p => ({ body: p.body, alive: p.alive, dizzy: p.dizzy, frozen: p.frozen })),
    food: sess.food,
    poops: sess.poops,
    cleaner: sess.cleaner,
    elephant: sess.elephant,
    aliveCount: alive.length,
  });

  if (ended) {
    clearInterval(sess.interval);
    sess.interval = null;
    sess.gameOver = true;
    sess.cleaner = null;
    sess.elephant = null;
    if (sess.cleanerTimeout) { clearTimeout(sess.cleanerTimeout); sess.cleanerTimeout = null; }
    if (sess.elephantTimer)  { clearInterval(sess.elephantTimer);  sess.elephantTimer = null;  }
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

// ── Elephant (pixel monster) ──────────────────────────────────────────────────
// Anchor = top-left cell (lx, ly); occupies lx..lx+size-1, ly..ly+size-1
// dir: 'right'|'left'|'down'|'up' — the direction it walks across
function spawnElephant(sess) {
  if (!sess.started || sess.gameOver || sess.elephant) return;
  sess.elephantCount++;
  const size = Math.min(5, sess.elephantCount);

  const dir = ['right', 'left', 'down', 'up'][Math.floor(Math.random() * 4)];
  let lx, ly;
  if      (dir === 'right') { lx = -size;  ly = Math.floor(Math.random() * (ROWS - size + 1)); }
  else if (dir === 'left')  { lx = COLS;   ly = Math.floor(Math.random() * (ROWS - size + 1)); }
  else if (dir === 'down')  { lx = Math.floor(Math.random() * (COLS - size + 1)); ly = -size;  }
  else                      { lx = Math.floor(Math.random() * (COLS - size + 1)); ly = ROWS;   }

  sess.elephant = { lx, ly, size, dir };

  // Pre-pick which positions along the travel axis will get a poop
  const target   = 10 + Math.floor(Math.random() * 11); // 10–20
  const axisLen  = (dir === 'right' || dir === 'left') ? COLS : ROWS;
  const all      = Array.from({ length: axisLen }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  sess.elephantPoopCols = new Set(all.slice(0, target));
}

function moveElephant(sess) {
  if (!sess.elephant) return;
  const { lx, ly, size, dir } = sess.elephant;

  // Identify the trailing edge coordinate (the row/col being vacated this step)
  let trailCoord, trailInBounds;
  if      (dir === 'right') { trailCoord = lx;           trailInBounds = lx >= 0 && lx < COLS; }
  else if (dir === 'left')  { trailCoord = lx + size - 1; trailInBounds = lx + size - 1 >= 0 && lx + size - 1 < COLS; }
  else if (dir === 'down')  { trailCoord = ly;           trailInBounds = ly >= 0 && ly < ROWS; }
  else                      { trailCoord = ly + size - 1; trailInBounds = ly + size - 1 >= 0 && ly + size - 1 < ROWS; }

  // Drop poop on the trailing edge if this position was pre-selected
  if (trailInBounds && sess.elephantPoopCols && sess.elephantPoopCols.has(trailCoord)) {
    const poopSet  = new Set(sess.poops.map(p => `${p.x},${p.y}`));
    const foodSet  = new Set(sess.food.map(f => `${f.x},${f.y}`));
    const snakeOcc = new Set();
    for (const p of sess.players) if (p.alive) for (const s of p.body) snakeOcc.add(`${s.x},${s.y}`);
    // Poop position: random perpendicular offset within the monster's width
    const px = (dir === 'right' || dir === 'left') ? trailCoord : lx + Math.floor(Math.random() * size);
    const py = (dir === 'down'  || dir === 'up')   ? trailCoord : ly + Math.floor(Math.random() * size);
    const pk = `${px},${py}`;
    if (!poopSet.has(pk) && !foodSet.has(pk) && !snakeOcc.has(pk)) {
      sess.poops.push({ x: px, y: py });
      scheduleCleaner(sess);
    }
  }

  // Advance one step in travel direction
  let newLX = lx, newLY = ly;
  if      (dir === 'right') newLX++;
  else if (dir === 'left')  newLX--;
  else if (dir === 'down')  newLY++;
  else                      newLY--;

  // Exit when fully off the far edge
  const exited = dir === 'right' ? newLX >= COLS
               : dir === 'left'  ? newLX + size <= 0
               : dir === 'down'  ? newLY >= ROWS
               :                   newLY + size <= 0;
  if (exited) { sess.elephant = null; sess.elephantPoopCols = null; return; }

  // Wander perpendicular to travel direction
  const perp = Math.random() < 0.25 ? -1 : Math.random() < 0.33 ? 1 : 0;
  if (dir === 'right' || dir === 'left') newLY = Math.max(0, Math.min(ROWS - size, newLY + perp));
  else                                   newLX = Math.max(0, Math.min(COLS - size, newLX + perp));

  sess.elephant = { lx: newLX, ly: newLY, size, dir };

  // Collide with snakes in new footprint
  const hit = new Set();
  for (const p of sess.players) {
    if (!p.alive) continue;
    for (const seg of p.body) {
      if (seg.x >= newLX && seg.x < newLX + size &&
          seg.y >= newLY && seg.y < newLY + size && !hit.has(p)) {
        hit.add(p); applyCollision(p); break;
      }
    }
  }
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
          if (sess.elephantTimer)  clearInterval(sess.elephantTimer);
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
