'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 800, H = 560;
const TANK_W = 34, TANK_H = 44;   // collision box half-widths
const TANK_SPEED   = 2.4;          // px/tick forward
const TANK_BACK    = 1.4;          // px/tick backward
const TANK_ROT     = 3.5;          // degrees/tick (keyboard)
const TANK_ROT_JOY = 8;            // degrees/tick (joystick — snappier)
const SHOT_CD      = 2000;         // cooldown after every shot (normal)
const RAPID_CD     = 1000;         // cooldown when rapid-fire powerup active
const BULLET_SPEED = 8;
const BULLET_R     = 5;
const BULLET_LIFE  = 140;          // ticks (~4.6 s at 33ms)
const BULLET_MAX_BOUNCES = 3;      // wall bounces before dying (normal bullets)
const HP_MAX       = 5;
const TICK_MS      = 33;           // ~30 fps
const MAX_PLAYERS  = 4;
const OBS_W        = 60;           // obstacle full width  (px)
const OBS_H        = 40;           // obstacle full height (px)
const OBS_HP       = 50;           // hits required to destroy

// Power-ups
const POWERUP_TYPES    = ['speed', 'shield', 'spread', 'rapid'];
const POWERUP_INTERVAL = 20000;    // ms between spawns
const POWERUP_DURATION = 8000;     // ms a powerup lasts
const POWERUP_PICKUP_R = 22;       // pickup collision radius
const POWERUP_MAX      = 3;        // max simultaneous powerups on map

// Amend (repair)
const AMEND_INTERVAL = 4000;      // ms to regenerate 1 HP while amending

// Spawn corners, facing inward (angle = degrees, 0 = up, clockwise)
const SPAWNS = [
  { x: 90,      y: 90,      angle: 135 },
  { x: W - 90,  y: 90,      angle: 225 },
  { x: 90,      y: H - 90,  angle: 45  },
  { x: W - 90,  y: H - 90,  angle: 315 },
];
const COLORS    = ['#4fc3f7', '#ef5350', '#66bb6a', '#ffa726'];
const BOT_NAMES = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta'];

// Map layouts
const LAYOUTS = [
  { name: 'Random'   },
  { name: 'Open'     },
  { name: 'Cross'    },
  { name: 'Fortress' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const send  = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
function bcast(s, o) {
  const m = JSON.stringify(o);
  for (const p of s.players) if (p.ws && p.ws.readyState === 1) p.ws.send(m);
  for (const ob of s.obs)    if (ob.ws.readyState === 1) ob.ws.send(m);
}
const deg2rad = d => d * Math.PI / 180;

// ── Obstacle & layout generation ─────────────────────────────────────────────
function genObstaclesForLayout(layoutIdx) {
  if (layoutIdx === 1) return [];  // Open — no obstacles

  if (layoutIdx === 2) {           // Cross
    return [
      { x: 400, y: 280, w: 62, h: 42 },   // centre hub
      { x: 400, y: 158, w: 42, h: 62 },   // top arm
      { x: 400, y: 402, w: 42, h: 62 },   // bottom arm
      { x: 228, y: 280, w: 62, h: 42 },   // left arm
      { x: 572, y: 280, w: 62, h: 42 },   // right arm
    ].map((o, id) => ({ ...o, hp: OBS_HP, id }));
  }

  if (layoutIdx === 3) {           // Fortress — 6 pillars
    return [
      { x: 265, y: 188, w: OBS_W, h: OBS_H },
      { x: 535, y: 188, w: OBS_W, h: OBS_H },
      { x: 148, y: 280, w: OBS_H, h: OBS_W },
      { x: 652, y: 280, w: OBS_H, h: OBS_W },
      { x: 265, y: 372, w: OBS_W, h: OBS_H },
      { x: 535, y: 372, w: OBS_W, h: OBS_H },
    ].map((o, id) => ({ ...o, hp: OBS_HP, id }));
  }

  // Layout 0: Random (default)
  const sp = 28;
  const areas = [
    { cx: W * 0.50, cy: H * 0.50 },
    { cx: W * 0.72, cy: H * 0.25 },
    { cx: W * 0.72, cy: H * 0.75 },
    { cx: W * 0.28, cy: H * 0.25 },
    { cx: W * 0.28, cy: H * 0.75 },
  ];
  return areas.map((a, id) => ({
    id,
    x: a.cx + (Math.random() - 0.5) * sp,
    y: a.cy + (Math.random() - 0.5) * sp,
    w: OBS_W, h: OBS_H, hp: OBS_HP,
  }));
}

function randomPowerupPos(s) {
  const margin = 60;
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = margin + Math.random() * (W - margin * 2);
    const y = margin + Math.random() * (H - margin * 2);
    let clear = true;
    for (const obs of s.obstacles) {
      if (Math.abs(x - obs.x) < obs.w / 2 + 26 && Math.abs(y - obs.y) < obs.h / 2 + 26) {
        clear = false; break;
      }
    }
    if (clear) return { x, y };
  }
  return { x: W / 2 + (Math.random() - 0.5) * 60, y: H / 2 + (Math.random() - 0.5) * 40 };
}

// ── Session management ────────────────────────────────────────────────────────
let nextId = 1;
const sessions = new Map();
let openSess = null;

function mkSess() {
  const s = {
    id: nextId++,
    state: 'waiting',
    players: [], obs: [],
    bullets: [],
    obstacles: [],
    powerups: [],
    powerupTimer: 0,
    nextPowerupId: 0,
    layoutIdx: 0,
    firedThisTick: [],
    interval: null,
  };
  sessions.set(s.id, s);
  return s;
}

function lobbyData(s) {
  return {
    type: 'tank_lobby',
    players: s.players.map(p => ({ name: p.name, color: p.color, isAI: !!p.isAI })),
    obs: s.obs.length,
    state: s.state,
    sid: s.id,
    layoutIdx: s.layoutIdx,
    layoutName: LAYOUTS[s.layoutIdx].name,
  };
}

// ── Game start ────────────────────────────────────────────────────────────────
function startGame(s) {
  s.state = 'playing';
  s.bullets = [];
  s.obstacles = genObstaclesForLayout(s.layoutIdx);
  s.powerups = [];
  s.firedThisTick = [];
  s.powerupTimer = Date.now() + 10000;  // first powerup after 10 s
  s.nextPowerupId = 0;

  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const sp = SPAWNS[i];
    p.x           = sp.x;
    p.y           = sp.y;
    p.angle       = sp.angle;
    p.turretAngle = sp.angle;
    p.hp          = HP_MAX;
    p.alive       = true;
    p.input       = { up: false, down: false, left: false, right: false, fire: false,
                      joyAngle: null, joyMag: 0, fireJoyAngle: null };
    p.lastFire    = 0;
    p.overheatEnd = 0;
    p.vel         = 0;
    p.shield      = false;
    p.speedBoost  = 1;
    p.spreadShot  = false;
    p.rapidFire   = false;
    p.powerupType = null;
    p.powerupEnd  = 0;
    p.amending    = false;
    p.amendAcc    = 0;
  }

  bcast(s, {
    type: 'tank_start',
    players: s.players.map(p => ({
      name: p.name, color: p.color, isAI: !!p.isAI,
      x: p.x, y: p.y, angle: p.angle, turretAngle: p.turretAngle, hp: p.hp,
    })),
    obstacles: s.obstacles,
    powerups: [],
    layoutName: LAYOUTS[s.layoutIdx].name,
    W, H,
  });

  s.interval = setInterval(() => tick(s), TICK_MS);
}

// ── AI ────────────────────────────────────────────────────────────────────────
function computeAIInput(s, p, now) {
  if (!p.ai) p.ai = { jitter: 0, jitterTime: 0,
                      lastX: p.x, lastY: p.y, lastMoveCheck: now,
                      avoidUntil: 0, avoidDir: 0 };
  const ai = p.ai;

  // Randomise aim jitter every ~3 s — holds wrong angle longer
  if (now - ai.jitterTime > 3000) {
    ai.jitter     = (Math.random() - 0.5) * 70; // ±35°
    ai.jitterTime = now;
  }

  // Stuck detection: sample every 1.5 s; if tried-to-move but barely advanced, dodge sideways
  if (now - ai.lastMoveCheck > 1500) {
    const moved = Math.hypot(p.x - ai.lastX, p.y - ai.lastY);
    if (moved < 12 && (p.input.up || p.input.down)) {
      ai.avoidDir   = Math.random() < 0.5 ? -1 : 1;
      ai.avoidUntil = now + 700 + Math.random() * 600;
    }
    ai.lastX = p.x; ai.lastY = p.y;
    ai.lastMoveCheck = now;
  }

  // Find nearest alive enemy
  let target = null, minDist = Infinity;
  for (const other of s.players) {
    if (other === p || !other.alive) continue;
    const d = Math.hypot(other.x - p.x, other.y - p.y);
    if (d < minDist) { minDist = d; target = other; }
  }

  if (!target) {
    p.input = { up: false, down: false, left: false, right: false, fire: false };
    return;
  }

  const dx = target.x - p.x, dy = target.y - p.y;
  const dist = Math.hypot(dx, dy);
  const targetAngle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const aimAngle    = (targetAngle + ai.jitter + 360) % 360;

  let diff = aimAngle - p.angle;
  while (diff >  180) diff -= 360;
  while (diff < -180) diff += 360;

  // ── Wall avoidance ───────────────────────────────────────────────────────
  const margin = 65;
  const nearWall = p.x < margin || p.x > W - margin || p.y < margin || p.y > H - margin;
  if (nearWall) {
    const cx = (Math.atan2(W / 2 - p.x, -(H / 2 - p.y)) * 180 / Math.PI + 360) % 360;
    let cd = cx - p.angle;
    while (cd >  180) cd -= 360;
    while (cd < -180) cd += 360;
    p.input.left  = cd < -2;
    p.input.right = cd > 2;
    p.input.up    = true;
    p.input.down  = false;
    p.input.fire  = false;
    return;
  }

  // ── Stuck escape maneuver ────────────────────────────────────────────────
  if (now < ai.avoidUntil) {
    const sideAngle = (p.angle + ai.avoidDir * 90 + 360) % 360;
    let sd = sideAngle - p.angle;
    while (sd >  180) sd -= 360;
    while (sd < -180) sd += 360;
    p.input.left  = sd < -2;
    p.input.right = sd > 2;
    p.input.up    = true;
    p.input.down  = false;
    p.input.fire  = false;
    return;
  }

  // ── Obstacle avoidance: find nearest blocker on path to target ───────────
  if (dist > 40 && s.obstacles.length > 0) {
    const nx = dx / dist, ny = dy / dist; // unit vector toward target
    let blockObs = null, blockPerp = 0, blockProj = Infinity;

    for (const obs of s.obstacles) {
      const ox = obs.x - p.x, oy = obs.y - p.y;
      const proj = ox * nx + oy * ny;          // along-path distance to obstacle centre
      if (proj <= 0 || proj > dist + 10) continue;
      const perp = ox * ny - oy * nx;          // signed perpendicular offset
      const clearance = Math.max(obs.w, obs.h) / 2 + TANK_W / 2 + 10;
      if (Math.abs(perp) < clearance && proj < blockProj) {
        blockObs = obs; blockPerp = perp; blockProj = proj;
      }
    }

    if (blockObs) {
      // Compute bypass waypoint: a point beside the obstacle, perpendicular to path.
      // In screen coords (y-down), perp > 0 means obstacle is "above" path (north) →
      // steer south (bSign = +1 uses the southward perpendicular (-ny, nx)).
      const cl     = Math.max(blockObs.w, blockObs.h) / 2 + TANK_W / 2 + 24;
      const bSign  = blockPerp >= 0 ? 1 : -1;
      const bpx    = blockObs.x + (-ny) * bSign * cl;
      const bpy    = blockObs.y +   nx  * bSign * cl;

      const bypassAngle = (Math.atan2(bpx - p.x, -(bpy - p.y)) * 180 / Math.PI + 360) % 360;
      let bd = bypassAngle - p.angle;
      while (bd >  180) bd -= 360;
      while (bd < -180) bd += 360;
      p.input.left  = bd < -2;
      p.input.right = bd > 2;
      p.input.up    = true;
      p.input.down  = false;
      p.input.fire  = false;
      return;
    }
  }

  // ── Normal: rotate toward aim, advance / retreat, fire ──────────────────
  // Rotate toward jittered aim angle
  p.input.left  = diff < -2;
  p.input.right = diff > 2;

  // Advance only when quite far, hold position at mid-range, back up when close
  p.input.up   = minDist > 220;
  p.input.down = minDist < 110;

  // Fire only when well on-target (ignore jitter for firing check)
  let aimDiff = targetAngle - p.angle;
  while (aimDiff >  180) aimDiff -= 360;
  while (aimDiff < -180) aimDiff += 360;
  p.input.fire = Math.abs(aimDiff) < 10;
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(s) {
  if (s.state !== 'playing') return;
  const now = Date.now();
  s.firedThisTick = [];

  // Expire powerups
  for (const p of s.players) {
    if (p.powerupType && now >= p.powerupEnd) {
      p.speedBoost  = 1;
      p.spreadShot  = false;
      p.rapidFire   = false;
      p.powerupType = null;
      p.powerupEnd  = 0;
    }
  }

  // Spawn powerup
  if (now >= s.powerupTimer && s.powerups.length < POWERUP_MAX) {
    s.powerupTimer = now + POWERUP_INTERVAL;
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    const pos  = randomPowerupPos(s);
    s.powerups.push({ id: s.nextPowerupId++, x: pos.x, y: pos.y, type });
  }

  // AI input (must run before the movement pass)
  for (const p of s.players) {
    if (p.isAI && p.alive) computeAIInput(s, p, now);
  }

  // Move tanks
  for (const p of s.players) {
    if (!p.alive) continue;
    const spMult = (p.speedBoost > 1 && p.powerupType) ? p.speedBoost : 1;

    // Amend: block movement; heal on timer; cancel if player tries to translate
    if (p.amending) {
      const wantsToMove = p.input.up || p.input.down
        || (typeof p.input.joyAngle === 'number' && p.input.joyMag > 0.15);
      if (wantsToMove) {
        p.amending = false;
        p.amendAcc = 0;
        bcast(s, { type: 'tank_amend_cancel', name: p.name });
      } else {
        p.amendAcc += TICK_MS;
        if (p.amendAcc >= AMEND_INTERVAL && p.hp < HP_MAX) {
          p.hp++;
          p.amendAcc -= AMEND_INTERVAL;
          bcast(s, { type: 'tank_amend_heal', name: p.name, hp: p.hp });
        }
      }
    }

    if (!p.amending) {
      if (typeof p.input.joyAngle === 'number') {
      // Left joystick: steer body toward absolute map direction, then advance
      let diff = p.input.joyAngle - p.angle;
      while (diff >  180) diff -= 360;
      while (diff < -180) diff += 360;
      p.angle = Math.abs(diff) <= TANK_ROT_JOY
        ? p.input.joyAngle
        : (p.angle + (diff > 0 ? TANK_ROT_JOY : -TANK_ROT_JOY) + 360) % 360;
      if (p.input.joyMag > 0.15) {
        const rad = deg2rad(p.angle);
        p.x = Math.max(TANK_W / 2 + 2, Math.min(W - TANK_W / 2 - 2,
              p.x + Math.sin(rad) * TANK_SPEED * spMult * p.input.joyMag));
        p.y = Math.max(TANK_H / 2 + 2, Math.min(H - TANK_H / 2 - 2,
              p.y - Math.cos(rad) * TANK_SPEED * spMult * p.input.joyMag));
      }
    } else {
      // Keyboard: relative turn + forward/backward
      if (p.input.left)  p.angle = (p.angle - TANK_ROT + 360) % 360;
      if (p.input.right) p.angle = (p.angle + TANK_ROT) % 360;
      let spd = 0;
      if (p.input.up)   spd =  TANK_SPEED * spMult;
      if (p.input.down) spd = -TANK_BACK;
      if (spd !== 0) {
        const rad = deg2rad(p.angle);
        p.x = Math.max(TANK_W / 2 + 2, Math.min(W - TANK_W / 2 - 2,
              p.x + Math.sin(rad) * spd));
        p.y = Math.max(TANK_H / 2 + 2, Math.min(H - TANK_H / 2 - 2,
              p.y - Math.cos(rad) * spd));
      }
    }
    } // end !p.amending movement block

    // Turret: follows right joystick if active, otherwise follows body
    if (typeof p.input.fireJoyAngle === 'number') {
      p.turretAngle = p.input.fireJoyAngle;
    } else {
      p.turretAngle = p.angle;
    }

    // Keyboard / AI fire — gated by per-shot cooldown (overheatEnd)
    if (p.input.fire && now >= p.overheatEnd) {
      tryFire(s, p, now);
    }

    // Push tank out of obstacles
    for (const obs of s.obstacles) {
      const hw = obs.w / 2 + TANK_W / 2;
      const hh = obs.h / 2 + TANK_H / 2;
      const dx = p.x - obs.x;
      const dy = p.y - obs.y;
      if (Math.abs(dx) < hw && Math.abs(dy) < hh) {
        const ox = hw - Math.abs(dx);
        const oy = hh - Math.abs(dy);
        if (ox < oy) {
          p.x += dx >= 0 ? ox : -ox;
        } else {
          p.y += dy >= 0 ? oy : -oy;
        }
      }
    }

    // Powerup pickup
    for (let pi = s.powerups.length - 1; pi >= 0; pi--) {
      const pu = s.powerups[pi];
      if (Math.hypot(p.x - pu.x, p.y - pu.y) < POWERUP_PICKUP_R) {
        s.powerups.splice(pi, 1);
        applyPowerup(s, p, pu.type, now);
      }
    }
  }

  // Move bullets & check collisions
  const dead = new Set();
  for (let i = 0; i < s.bullets.length; i++) {
    const b = s.bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    if (b.life <= 0) { dead.add(i); continue; }

    // Wall bounces
    let wall = false;
    if (b.x - BULLET_R < 0)    { b.x = BULLET_R;      b.vx =  Math.abs(b.vx); wall = true; }
    if (b.x + BULLET_R > W)    { b.x = W - BULLET_R;  b.vx = -Math.abs(b.vx); wall = true; }
    if (b.y - BULLET_R < 0)    { b.y = BULLET_R;      b.vy =  Math.abs(b.vy); wall = true; }
    if (b.y + BULLET_R > H)    { b.y = H - BULLET_R;  b.vy = -Math.abs(b.vy); wall = true; }
    if (wall) {
      if (b.bounces >= b.bounceLimit) { dead.add(i); continue; }
      b.bounces++;
    }

    // Bullet hits obstacle
    let hitObs = false;
    for (let oi = s.obstacles.length - 1; oi >= 0; oi--) {
      const obs = s.obstacles[oi];
      const hw = obs.w / 2, hh = obs.h / 2;
      if (b.x + BULLET_R > obs.x - hw && b.x - BULLET_R < obs.x + hw &&
          b.y + BULLET_R > obs.y - hh && b.y - BULLET_R < obs.y + hh) {
        dead.add(i);
        hitObs = true;
        obs.hp--;
        if (obs.hp <= 0) {
          s.obstacles.splice(oi, 1);
          bcast(s, { type: 'tank_obs_destroyed', id: obs.id });
        } else {
          bcast(s, { type: 'tank_obs_hit', id: obs.id, hp: obs.hp });
        }
        break;
      }
    }
    if (hitObs) continue;

    // Bullet hits tank (axis-aligned box check)
    for (const p of s.players) {
      if (!p.alive || p.name === b.owner) continue;
      if (Math.abs(b.x - p.x) < TANK_W / 2 + BULLET_R &&
          Math.abs(b.y - p.y) < TANK_H / 2 + BULLET_R) {
        dead.add(i);
        if (p.shield) {
          p.shield = false;
          bcast(s, { type: 'tank_hit', name: p.name, hp: p.hp, shielded: true });
        } else {
          p.hp--;
          bcast(s, { type: 'tank_hit', name: p.name, hp: p.hp });
          if (p.hp <= 0) {
            p.alive = false;
            bcast(s, { type: 'tank_destroyed', name: p.name });
          }
        }
        break;
      }
    }
  }
  s.bullets = s.bullets.filter((_, i) => !dead.has(i));

  // Win check
  const alive = s.players.filter(p => p.alive);
  if (alive.length <= 1) {
    endGame(s, alive[0] || null);
    return;
  }

  // Broadcast frame
  bcast(s, {
    type: 'tank_g',
    tanks: s.players.map(p => ({
      name: p.name,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      angle: Math.round(p.angle * 10) / 10,
      turretAngle: Math.round(p.turretAngle * 10) / 10,
      hp: p.hp,
      alive: p.alive,
      cooldownEnd: p.overheatEnd,
      overheated: now < p.overheatEnd,
      rapidFire: !!p.rapidFire,
      shield: p.shield,
      powerupType: p.powerupType || null,
      powerupEnd: p.powerupEnd,
      amending: !!p.amending,
      amendProgress: p.amending ? Math.min(1, (p.amendAcc || 0) / AMEND_INTERVAL) : 0,
    })),
    bullets: s.bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) })),
    powerups: s.powerups,
    fired: s.firedThisTick,
  });
  s.firedThisTick = [];
}

// ── Fire helpers ──────────────────────────────────────────────────────────────
function spawnBullet(s, p, angle, isRapid) {
  const rad = deg2rad(angle);
  const spd = isRapid ? BULLET_SPEED * 0.5 : BULLET_SPEED;
  s.bullets.push({
    x: p.x + Math.sin(rad) * (TANK_H / 2 + BULLET_R + 2),
    y: p.y - Math.cos(rad) * (TANK_H / 2 + BULLET_R + 2),
    vx: Math.sin(rad) * spd,
    vy: -Math.cos(rad) * spd,
    owner: p.name,
    life: BULLET_LIFE,
    bounces: 0,
    bounceLimit: isRapid ? 0 : BULLET_MAX_BOUNCES,
  });
}

function tryFire(s, p, now) {
  const cd       = p.rapidFire ? RAPID_CD : SHOT_CD;
  const slowBullet = p.rapidFire || p.spreadShot;  // spread & rapid → slow, no-bounce
  p.lastFire    = now;
  p.overheatEnd = now + cd;
  (s.firedThisTick = s.firedThisTick || []).push(p.name);
  if (p.spreadShot) {
    spawnBullet(s, p, p.turretAngle - 15, slowBullet);
    spawnBullet(s, p, p.turretAngle,       slowBullet);
    spawnBullet(s, p, p.turretAngle + 15,  slowBullet);
  } else {
    spawnBullet(s, p, p.turretAngle, slowBullet);
  }
  bcast(s, { type: 'tank_overheat', name: p.name, duration: cd });
}

// ── Power-ups ─────────────────────────────────────────────────────────────────
function applyPowerup(s, p, type, now) {
  // Clear any previous timed powerup before applying new one
  p.speedBoost  = 1;
  p.spreadShot  = false;
  p.rapidFire   = false;

  p.powerupType = type;
  p.powerupEnd  = now + POWERUP_DURATION;
  if (type === 'speed')  { p.speedBoost = 1.7; }
  if (type === 'shield') { p.shield = true; p.powerupEnd = now + 1; } // shield is instant, no timer
  if (type === 'spread') { p.spreadShot = true; }
  if (type === 'rapid')  { p.rapidFire = true; p.overheatEnd = 0; } // clear any existing cooldown

  bcast(s, { type: 'tank_powerup', name: p.name, puType: type,
             duration: type === 'shield' ? 0 : POWERUP_DURATION });
}

// ── End game ──────────────────────────────────────────────────────────────────
function endGame(s, winner) {
  s.state = 'game_over';
  clearInterval(s.interval);
  s.interval = null;
  bcast(s, { type: 'tank_over', winner: winner ? winner.name : null });
}

// ── WebSocket connections ──────────────────────────────────────────────────────
wss.on('connection', ws => {
  let sess = null, me = null, isObs = false;

  send(ws, openSess
    ? lobbyData(openSess)
    : { type: 'tank_lobby', players: [], obs: 0, state: 'waiting', sid: null });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── create new session ────────────────────────────────────────────────
    if (msg.type === 'tank_create') {
      if (sess) return;
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return;
      const s = mkSess();
      sess = s;
      openSess = s;
      me = mkPlayer(ws, name, 0);
      sess.players.push(me);
      send(ws, { type: 'tank_joined', color: me.color, W, H, isHost: true, canStart: false });
      bcast(sess, lobbyData(sess));

    // ── join existing session ─────────────────────────────────────────────
    } else if (msg.type === 'tank_join') {
      if (sess) return;
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return;

      if (!openSess || openSess.state !== 'waiting' || openSess.players.length >= MAX_PLAYERS) {
        // Try observe
        const target = openSess || [...sessions.values()].find(s => s.state === 'playing');
        if (!target) { send(ws, { type: 'tank_error', text: 'No session available' }); return; }
        sess = target;
        isObs = true;
        sess.obs.push({ ws, name });
        send(ws, { type: 'tank_obs_joined', W, H,
          players: sess.players.map(p => ({ name: p.name, color: p.color, x: p.x, y: p.y, angle: p.angle, hp: p.hp, alive: p.alive })),
          obstacles: sess.obstacles || [],
          powerups: sess.powerups || [],
          state: sess.state,
        });
        bcast(sess, lobbyData(sess));
        return;
      }
      sess = openSess;
      me = mkPlayer(ws, name, sess.players.length);
      sess.players.push(me);
      if (sess.players.length >= MAX_PLAYERS) openSess = null;
      send(ws, {
        type: 'tank_joined', color: me.color, W, H, isHost: false,
        canStart: sess.players.length >= 2,
      });
      bcast(sess, lobbyData(sess));

    // ── add AI bot ────────────────────────────────────────────────────────
    } else if (msg.type === 'tank_add_ai') {
      if (!sess || !me || sess.state !== 'waiting') return;
      if (sess.players[0] !== me) return; // host only
      if (sess.players.length >= MAX_PLAYERS) return;
      const botCount = sess.players.filter(p => p.isAI).length;
      const botName  = BOT_NAMES[botCount] || `Bot ${botCount + 1}`;
      const bot = mkPlayer(null, botName, sess.players.length);
      bot.isAI = true;
      bot.ai   = { jitter: 0, jitterTime: 0 };
      sess.players.push(bot);
      if (sess.players.length >= MAX_PLAYERS) openSess = null;
      bcast(sess, lobbyData(sess));

    // ── start game ────────────────────────────────────────────────────────
    } else if (msg.type === 'tank_start') {
      if (!sess || !me || sess.state !== 'waiting') return;
      if (sess.players[0] !== me) return; // host only
      if (sess.players.length < 2) return;
      openSess = null;
      startGame(sess);

    // ── player input ──────────────────────────────────────────────────────
    } else if (msg.type === 'tank_in') {
      if (!me || sess.state !== 'playing' || !me.alive) return;
      me.input.up    = !!msg.up;
      me.input.down  = !!msg.down;
      me.input.left  = !!msg.left;
      me.input.right = !!msg.right;
      me.input.fire  = !!msg.fire;
      // Joystick: absolute map angle (0=north, 90=east) + magnitude 0..1
      me.input.joyAngle     = (typeof msg.joyAngle     === 'number') ? msg.joyAngle : null;
      me.input.joyMag       = (typeof msg.joyMag       === 'number') ? Math.max(0, Math.min(1, msg.joyMag)) : 0;
      me.input.fireJoyAngle = (typeof msg.fireJoyAngle === 'number') ? msg.fireJoyAngle : null;

    // ── tap fire (right joystick) ─────────────────────────────────────────
    } else if (msg.type === 'tank_fire') {
      if (!me || sess.state !== 'playing' || !me.alive) return;
      const fNow = Date.now();
      if (fNow < me.overheatEnd) return; // still in per-shot cooldown
      if (typeof msg.angle === 'number') {
        me.input.fireJoyAngle = msg.angle;
        me.turretAngle = msg.angle;
      }
      tryFire(sess, me, fNow);

    // ── toggle amend (repair) ─────────────────────────────────────────────
    } else if (msg.type === 'tank_amend') {
      if (!me || sess.state !== 'playing' || !me.alive) return;
      me.amending = !me.amending;
      if (!me.amending) me.amendAcc = 0;

    // ── set map layout ────────────────────────────────────────────────────
    } else if (msg.type === 'tank_set_layout') {
      if (!sess || !me || sess.state !== 'waiting') return;
      if (sess.players[0] !== me) return; // host only
      sess.layoutIdx = ((sess.layoutIdx || 0) + 1) % LAYOUTS.length;
      bcast(sess, lobbyData(sess));

    // ── rematch ───────────────────────────────────────────────────────────
    } else if (msg.type === 'tank_rematch') {
      if (!sess || !me || sess.state !== 'game_over') return;
      if (sess.interval) { clearInterval(sess.interval); sess.interval = null; }
      sess.state = 'waiting';
      sess.bullets = [];
      sess.powerups = [];
      sess.firedThisTick = [];
      for (const p of sess.players) {
        p.input = { up: false, down: false, left: false, right: false, fire: false,
                    joyAngle: null, joyMag: 0, fireJoyAngle: null };
        p.vel = 0; p.overheatEnd = 0;
        p.shield = false; p.speedBoost = 1; p.spreadShot = false;
        p.rapidFire = false; p.powerupType = null; p.powerupEnd = 0;
        p.amending = false; p.amendAcc = 0;
        if (p.isAI && p.ai) p.ai.jitterTime = 0;
      }
      if (!openSess) openSess = sess;
      bcast(sess, { type: 'tank_rematch' });
      bcast(sess, lobbyData(sess));
    }
  });

  ws.on('close', () => {
    if (!sess) return;
    if (isObs) {
      sess.obs = sess.obs.filter(o => o.ws !== ws);
      bcast(sess, lobbyData(sess));
      return;
    }
    if (me) {
      // Remove this human player and any AI bots if no humans remain
      sess.players = sess.players.filter(p => p !== me);
      if (sess.interval) { clearInterval(sess.interval); sess.interval = null; }
      sess.bullets = [];

      const humanPlayers = sess.players.filter(p => !p.isAI);
      if (!humanPlayers.length && !sess.obs.length) {
        // No humans left — tear down completely
        sessions.delete(sess.id);
        if (openSess === sess) openSess = null;
        return;
      }
      // Also drop all AI bots if no humans remain in session (e.g. all quit)
      if (!humanPlayers.length) sess.players = [];

      if (sess.state === 'playing') {
        sess.state = 'waiting';
        bcast(sess, { type: 'tank_left', name: me.name });
      }
      if (!openSess && sess.players.length < MAX_PLAYERS && sess.state === 'waiting') openSess = sess;
      bcast(sess, lobbyData(sess));
    }
  });
});

function mkPlayer(ws, name, idx) {
  return {
    ws, name,
    color: COLORS[idx % COLORS.length],
    x: 0, y: 0, angle: 0,
    hp: HP_MAX, alive: false,
    input: { up: false, down: false, left: false, right: false, fire: false },
    lastFire: 0, overheatEnd: 0, vel: 0,
    shield: false, speedBoost: 1,
    spreadShot: false, rapidFire: false,
    powerupType: null, powerupEnd: 0,
    amending: false, amendAcc: 0,
  };
}

// ── Session list API ──────────────────────────────────────────────────────────
function getSessionList() {
  const list = [];
  for (const [, sess] of sessions) {
    const cur     = sess.players.length;
    const humans  = sess.players.filter(p => !p.isAI).length;
    const bots    = cur - humans;
    const host    = sess.players.find(p => !p.isAI);
    const label   = bots > 0
      ? `${humans} human${humans !== 1 ? 's' : ''} + ${bots} AI`
      : `${cur}/${MAX_PLAYERS} players`;
    list.push({
      id: sess.id,
      hostName: host ? host.name : '?',
      players: cur,
      maxPlayers: MAX_PLAYERS,
      observers: sess.obs.length,
      canJoin: cur < MAX_PLAYERS && sess.state === 'waiting',
      canObserve: sess.state === 'playing',
      status: sess.state,
      label,
    });
  }
  return list.filter(s => s.status !== 'game_over');
}

module.exports = { wss, getSessionList };
