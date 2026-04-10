'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const TICK_MS      = 50;       // 20 Hz physics
const MAX_PLAYERS  = 4;
const TRACK_LENGTH = 8000;     // pixels (world units)
const TERRAIN_SEG  = 40;       // world units per terrain segment
const NUM_SEGS     = Math.ceil(TRACK_LENGTH / TERRAIN_SEG) + 4;
const GRAVITY      = 0.6;
const FLIP_SPEED   = 18;       // speed threshold at which flip becomes possible
const FLIP_ANGLE   = 0.45;     // radians — slope steeper than this triggers flip check
const FLIP_RECOVER = 3000;     // ms to recover from flip
const POWERUP_TYPES = ['nitro', 'shield', 'oil', 'repair'];
const COLORS       = ['#e63946', '#2196f3', '#4caf50', '#ff9800'];
const NITRO_BOOST  = 6;
const NITRO_TICKS  = 60;       // 3 s at 20 Hz

// ── Helpers ───────────────────────────────────────────────────────────────────
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
function bcast(sess, o) {
  const m = JSON.stringify(o);
  for (const p of sess.players) if (p.ws.readyState === 1) p.ws.send(m);
  for (const ob of sess.obs)    if (ob.ws.readyState === 1) ob.ws.send(m);
}

// ── Terrain generation ────────────────────────────────────────────────────────
function genTerrain(seed) {
  // Simple seeded PRNG (xorshift)
  let s = seed >>> 0 || 1;
  function rand() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }

  const heights = [];
  // Start flat for first 5 segments so cars can get moving
  for (let i = 0; i < 5; i++) heights.push(0);

  let h = 0;
  let trend = 0;
  for (let i = 5; i < NUM_SEGS; i++) {
    trend += (rand() - 0.5) * 0.4;
    trend = Math.max(-0.8, Math.min(0.8, trend));
    h += trend * 15;
    h = Math.max(-300, Math.min(300, h));
    heights.push(h);
  }
  // Flatten finish area
  const flat = heights[NUM_SEGS - 1];
  for (let i = NUM_SEGS - 5; i < NUM_SEGS; i++) heights[i] = flat;

  return heights; // heights[i] = y offset at x = i * TERRAIN_SEG
}

function terrainY(heights, worldX) {
  const segF = worldX / TERRAIN_SEG;
  const seg  = Math.floor(segF);
  const t    = segF - seg;
  const i0   = Math.max(0, Math.min(NUM_SEGS - 1, seg));
  const i1   = Math.min(NUM_SEGS - 1, seg + 1);
  return heights[i0] * (1 - t) + heights[i1] * t;
}

function terrainAngle(heights, worldX) {
  const dx = 1;
  const dy = terrainY(heights, worldX + dx) - terrainY(heights, worldX - dx);
  return Math.atan2(dy, dx * 2);
}

// ── Power-up spawning ─────────────────────────────────────────────────────────
function spawnPowerups(heights) {
  const pups = [];
  // Place ~12 power-ups spread across track, not in first or last 10%
  const start = TRACK_LENGTH * 0.1;
  const end   = TRACK_LENGTH * 0.9;
  const spacing = (end - start) / 12;
  for (let i = 0; i < 12; i++) {
    const x = start + spacing * i + (Math.random() * spacing * 0.6 - spacing * 0.3);
    const y = terrainY(heights, x);
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    pups.push({ id: i, x, y, type, taken: false });
  }
  return pups;
}

// ── Oil slick spawning ────────────────────────────────────────────────────────
// Oil slicks are created when a player uses 'oil' power-up

// ── Session factory ───────────────────────────────────────────────────────────
let nextId = 1;
const sessions = new Map();

function mkSess() {
  const id = nextId++;
  const s = {
    id, players: [], obs: [],
    started: false, gameOver: false, interval: null,
    terrain: null, powerups: [], oilSlicks: [],
    seed: Math.floor(Math.random() * 0xffffffff),
    countdown: 0,
  };
  sessions.set(id, s);
  return s;
}

function getOrCreate() {
  for (const [, s] of sessions) {
    if (!s.started && !s.gameOver && s.players.length < MAX_PLAYERS) return s;
  }
  return mkSess();
}

// ── Car physics tick ──────────────────────────────────────────────────────────
function tickCar(p, sess) {
  if (p.finished || p.flipped) {
    if (p.flipped) {
      p.flipTimer -= TICK_MS;
      if (p.flipTimer <= 0) {
        p.flipped = false;
        p.speed = 0;
        p.vy = 0;
      }
    }
    return;
  }

  const { heights } = sess;
  const angle = terrainAngle(heights, p.x);
  const sinA  = Math.sin(angle);
  const cosA  = Math.cos(angle);

  // Gravity component along slope
  const gravSlope = GRAVITY * sinA;

  // Throttle / brake input
  let accel = 0;
  if (p.throttle)  accel = 0.4 * cosA;
  if (p.brake)     accel = -0.35;

  // Nitro boost
  let nitroBoost = 0;
  if (p.nitroCooldown > 0) {
    p.nitroCooldown--;
    nitroBoost = NITRO_BOOST;
  }

  // Apply forces
  p.speed += accel - gravSlope + nitroBoost * (p.throttle ? 1 : 0);

  // Friction
  const friction = 0.97;
  p.speed *= friction;

  // Speed limits
  const maxSpeed = 22 + (p.nitroCooldown > 0 ? NITRO_BOOST : 0);
  const minSpeed = -8;
  p.speed = Math.max(minSpeed, Math.min(maxSpeed, p.speed));

  // Move car
  p.x += p.speed * cosA;

  // Check oil slicks
  for (const oil of sess.oilSlicks) {
    if (!oil.active) continue;
    if (Math.abs(p.x - oil.x) < 60) {
      p.speed *= 0.6;
      if (Math.abs(p.speed) > 8) triggerFlip(p);
    }
  }

  // Clamp to track
  if (p.x < 0) { p.x = 0; p.speed = 0; }

  // Check finish
  if (p.x >= TRACK_LENGTH) {
    p.x = TRACK_LENGTH;
    p.finished = true;
    p.finishTime = Date.now() - sess.raceStart;
    return;
  }

  // Terrain follow
  p.y = terrainY(heights, p.x);
  p.angle = angle;

  // Flip check: going fast over steep slope
  const slopeAbs = Math.abs(angle);
  if (slopeAbs > FLIP_ANGLE && Math.abs(p.speed) > FLIP_SPEED && !p.shield) {
    // Probability increases with speed and angle
    const prob = (Math.abs(p.speed) - FLIP_SPEED) * 0.04 * (slopeAbs - FLIP_ANGLE) * 8;
    if (Math.random() < prob) triggerFlip(p);
  }

  // Collect power-ups
  for (const pu of sess.powerups) {
    if (pu.taken) continue;
    if (Math.abs(p.x - pu.x) < 40) {
      pu.taken = true;
      applyPowerup(p, pu.type, sess);
    }
  }
}

function triggerFlip(p) {
  if (p.shield) { p.shield = false; return; }
  p.flipped   = true;
  p.flipTimer = FLIP_RECOVER;
  p.speed     = 0;
}

function applyPowerup(p, type, sess) {
  if (type === 'nitro') {
    p.nitroCooldown = NITRO_TICKS;
  } else if (type === 'shield') {
    p.shield = true;
  } else if (type === 'repair') {
    if (p.flipped) { p.flipped = false; p.flipTimer = 0; p.speed = 0; }
  } else if (type === 'oil') {
    // Drop oil slick behind car
    sess.oilSlicks.push({ x: p.x - 30, active: true, id: sess.oilSlicks.length });
    // Auto-expire after 20 s
    setTimeout(() => {
      const oil = sess.oilSlicks.find(o => o.x === p.x - 30);
      if (oil) oil.active = false;
    }, 20000);
  }
  send(p.ws, { type: 'powerup_got', ptype: type });
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(sess) {
  if (sess.countdown > 0) {
    sess.countdown -= TICK_MS;
    if (sess.countdown <= 0) {
      sess.countdown = 0;
      sess.raceStart = Date.now();
      bcast(sess, { type: 'race_go' });
    } else {
      bcast(sess, { type: 'race_countdown', ms: sess.countdown });
      return;
    }
  }

  for (const p of sess.players) tickCar(p, sess);

  // Check end condition: all finished or all flipped with no progress
  const finished = sess.players.filter(p => p.finished);
  const allDone  = finished.length === sess.players.length ||
    (finished.length > 0 && finished.length >= sess.players.length - 1 &&
      sess.players.every(p => p.finished || (p.flipped && p.flipTimer <= 500)));

  const state = buildState(sess);
  bcast(sess, { type: 'race_tick', ...state });

  if (allDone && !sess.gameOver) {
    sess.gameOver = true;
    clearInterval(sess.interval);
    sess.interval = null;
    const results = [...sess.players]
      .sort((a, b) => {
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.x - a.x;
      })
      .map((p, rank) => ({ name: p.name, color: p.color, rank: rank + 1,
        finishTime: p.finished ? p.finishTime : null, x: p.x }));
    setTimeout(() => bcast(sess, { type: 'race_end', results }), 200);
  }
}

function buildState(sess) {
  return {
    cars: sess.players.map(p => ({
      idx: p.idx, x: p.x, y: p.y, angle: p.angle,
      speed: p.speed, flipped: p.flipped, flipTimer: p.flipTimer,
      finished: p.finished, finishTime: p.finishTime || null,
      nitroCooldown: p.nitroCooldown, shield: p.shield,
    })),
    powerups: sess.powerups.map(pu => ({ id: pu.id, taken: pu.taken })),
    oilSlicks: sess.oilSlicks.filter(o => o.active).map(o => ({ x: o.x })),
  };
}

// ── Start race ────────────────────────────────────────────────────────────────
function startRace(sess) {
  sess.started  = true;
  sess.gameOver = false;
  sess.terrain  = { heights: genTerrain(sess.seed) };
  sess.powerups = spawnPowerups(sess.terrain.heights);
  sess.oilSlicks = [];

  sess.players.forEach((p, i) => {
    const startX = 80 + i * 120;
    p.idx           = i;
    p.x             = startX;
    p.y             = terrainY(sess.terrain.heights, startX);
    p.angle         = 0;
    p.speed         = 0;
    p.vy            = 0;
    p.flipped       = false;
    p.flipTimer     = 0;
    p.finished      = false;
    p.finishTime    = null;
    p.throttle      = false;
    p.brake         = false;
    p.nitroCooldown = 0;
    p.shield        = false;
  });

  // 3-second countdown
  sess.countdown = 3000;
  sess.raceStart = null;

  bcast(sess, {
    type: 'race_start',
    seed: sess.seed,
    trackLength: TRACK_LENGTH,
    terrainSeg: TERRAIN_SEG,
    heights: sess.terrain.heights,
    powerups: sess.powerups.map(pu => ({ id: pu.id, x: pu.x, y: pu.y, type: pu.type, taken: false })),
    players: sess.players.map((p, i) => ({ idx: i, name: p.name, color: p.color, x: p.x, y: p.y })),
  });

  if (sess.interval) clearInterval(sess.interval);
  sess.interval = setInterval(() => tick(sess), TICK_MS);
}

// ── Session list (lobby) ──────────────────────────────────────────────────────
function getSessionList() {
  const list = [];
  for (const [, s] of sessions) {
    if (s.gameOver) continue;
    list.push({
      id: s.id,
      players: s.players.map(p => p.name),
      started: s.started,
      maxPlayers: MAX_PLAYERS,
    });
  }
  return list;
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let sess = null;
  let player = null;
  let isObs = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Player').slice(0, 24);
      const sessId = msg.sessId ? Number(msg.sessId) : null;
      if (sessId && sessions.has(sessId)) {
        sess = sessions.get(sessId);
      } else {
        sess = getOrCreate();
      }

      if (sess.started || sess.players.length >= MAX_PLAYERS) {
        // Join as observer
        isObs = true;
        sess.obs.push({ ws, name });
        send(ws, { type: 'joined_obs', sessId: sess.id,
          players: sess.players.map(p => ({ name: p.name, color: p.color })),
          started: sess.started });
        if (sess.started) {
          // Send current state
          send(ws, {
            type: 'race_start',
            seed: sess.seed,
            trackLength: TRACK_LENGTH,
            terrainSeg: TERRAIN_SEG,
            heights: sess.terrain.heights,
            powerups: sess.powerups.map(pu => ({ id: pu.id, x: pu.x, y: pu.y, type: pu.type, taken: pu.taken })),
            players: sess.players.map((p, i) => ({ idx: i, name: p.name, color: p.color, x: p.x, y: p.y })),
          });
        }
        return;
      }

      const color = COLORS[sess.players.length];
      player = { ws, name, color, idx: sess.players.length,
        x: 0, y: 0, angle: 0, speed: 0, vy: 0,
        flipped: false, flipTimer: 0, finished: false, finishTime: null,
        throttle: false, brake: false, nitroCooldown: 0, shield: false };
      sess.players.push(player);

      send(ws, { type: 'joined', sessId: sess.id, idx: player.idx, color,
        players: sess.players.map(p => ({ name: p.name, color: p.color })) });
      // Notify others
      bcast(sess, { type: 'player_joined',
        players: sess.players.map(p => ({ name: p.name, color: p.color })) });
      return;
    }

    if (!sess) return;

    if (msg.type === 'start') {
      if (!isObs && player && sess.players[0] === player && !sess.started) {
        if (sess.players.length >= 1) startRace(sess);
      }
      return;
    }

    if (msg.type === 'input') {
      if (player && !isObs && sess.started && !sess.gameOver) {
        player.throttle = !!msg.throttle;
        player.brake    = !!msg.brake;
      }
      return;
    }

    if (msg.type === 'rematch') {
      if (!isObs && sess.gameOver) {
        // Reset session
        sess.gameOver = false;
        sess.started  = false;
        sess.seed     = Math.floor(Math.random() * 0xffffffff);
        bcast(sess, { type: 'rematch_ready',
          players: sess.players.map(p => ({ name: p.name, color: p.color })) });
      }
      return;
    }

    if (msg.type === 'start_rematch') {
      if (!isObs && player && sess.players[0] === player && !sess.started) {
        startRace(sess);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!sess) return;
    if (isObs) {
      sess.obs = sess.obs.filter(o => o.ws !== ws);
    } else if (player) {
      // Mark disconnected but keep in race
      player.ws = { readyState: 3, send: () => {} };
    }
  });
});

module.exports = { wss, getSessionList };
