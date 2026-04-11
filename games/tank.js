'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 800, H = 560;
const TANK_W = 34, TANK_H = 44;   // collision box half-widths
const TANK_SPEED   = 2.4;          // px/tick forward
const TANK_BACK    = 1.4;          // px/tick backward
const TANK_ROT     = 3.5;          // degrees/tick
const BULLET_SPEED = 8;
const BULLET_R     = 5;
const BULLET_LIFE  = 140;          // ticks (~4.6 s at 33ms)
const FIRE_CD      = 700;          // ms between shots
const HP_MAX       = 3;
const TICK_MS      = 33;           // ~30 fps
const MAX_PLAYERS  = 4;

// Spawn corners, facing inward (angle = degrees, 0 = up, clockwise)
const SPAWNS = [
  { x: 90,      y: 90,      angle: 135 },
  { x: W - 90,  y: 90,      angle: 225 },
  { x: 90,      y: H - 90,  angle: 45  },
  { x: W - 90,  y: H - 90,  angle: 315 },
];
const COLORS    = ['#4fc3f7', '#ef5350', '#66bb6a', '#ffa726'];
const BOT_NAMES = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const send  = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
function bcast(s, o) {
  const m = JSON.stringify(o);
  for (const p of s.players) if (p.ws && p.ws.readyState === 1) p.ws.send(m);
  for (const ob of s.obs)    if (ob.ws.readyState === 1) ob.ws.send(m);
}
const deg2rad = d => d * Math.PI / 180;

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
  };
}

// ── Game start ────────────────────────────────────────────────────────────────
function startGame(s) {
  s.state = 'playing';
  s.bullets = [];

  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const sp = SPAWNS[i];
    p.x     = sp.x;
    p.y     = sp.y;
    p.angle = sp.angle;
    p.hp    = HP_MAX;
    p.alive = true;
    p.input = { up: false, down: false, left: false, right: false, fire: false };
    p.lastFire = 0;
    p.vel   = 0;
  }

  bcast(s, {
    type: 'tank_start',
    players: s.players.map(p => ({
      name: p.name, color: p.color, isAI: !!p.isAI,
      x: p.x, y: p.y, angle: p.angle, hp: p.hp,
    })),
    W, H,
  });

  s.interval = setInterval(() => tick(s), TICK_MS);
}

// ── AI ────────────────────────────────────────────────────────────────────────
function computeAIInput(s, p, now) {
  if (!p.ai) p.ai = { jitter: 0, jitterTime: 0 };
  const ai = p.ai;

  // Randomise aim jitter every ~1.8 s to avoid perfect accuracy
  if (now - ai.jitterTime > 1800) {
    ai.jitter = (Math.random() - 0.5) * 40; // ±20°
    ai.jitterTime = now;
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
  const targetAngle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const aimAngle    = (targetAngle + ai.jitter + 360) % 360;

  let diff = aimAngle - p.angle;
  while (diff >  180) diff -= 360;
  while (diff < -180) diff += 360;

  // Wall avoidance — steer toward arena centre when near a wall
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

  // Rotate toward jittered aim angle
  p.input.left  = diff < -2;
  p.input.right = diff > 2;

  // Advance when far away, back up when too close
  p.input.up   = minDist > 130;
  p.input.down = minDist < 75;

  // Fire only when barrel is truly on-target (ignore jitter for firing check)
  let aimDiff = targetAngle - p.angle;
  while (aimDiff >  180) aimDiff -= 360;
  while (aimDiff < -180) aimDiff += 360;
  p.input.fire = Math.abs(aimDiff) < 18;
}

// ── Game tick ─────────────────────────────────────────────────────────────────
function tick(s) {
  if (s.state !== 'playing') return;
  const now = Date.now();

  // AI input (must run before the movement pass)
  for (const p of s.players) {
    if (p.isAI && p.alive) computeAIInput(s, p, now);
  }

  // Move tanks
  for (const p of s.players) {
    if (!p.alive) continue;

    if (p.input.left)  p.angle = (p.angle - TANK_ROT + 360) % 360;
    if (p.input.right) p.angle = (p.angle + TANK_ROT) % 360;

    let spd = 0;
    if (p.input.up)   spd =  TANK_SPEED;
    if (p.input.down) spd = -TANK_BACK;

    if (spd !== 0) {
      const rad = deg2rad(p.angle);
      p.x = Math.max(TANK_W / 2 + 2, Math.min(W - TANK_W / 2 - 2,
            p.x + Math.sin(rad) * spd));
      p.y = Math.max(TANK_H / 2 + 2, Math.min(H - TANK_H / 2 - 2,
            p.y - Math.cos(rad) * spd));
    }

    // Fire
    if (p.input.fire && now - p.lastFire >= FIRE_CD) {
      p.lastFire = now;
      const rad = deg2rad(p.angle);
      const bx = p.x + Math.sin(rad) * (TANK_H / 2 + BULLET_R + 2);
      const by = p.y - Math.cos(rad) * (TANK_H / 2 + BULLET_R + 2);
      s.bullets.push({
        x: bx, y: by,
        vx: Math.sin(rad) * BULLET_SPEED,
        vy: -Math.cos(rad) * BULLET_SPEED,
        owner: p.name,
        life: BULLET_LIFE,
        bounced: false,
      });
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

    // Wall bounces (one bounce allowed)
    let wall = false;
    if (b.x - BULLET_R < 0)    { b.x = BULLET_R;      b.vx =  Math.abs(b.vx); wall = true; }
    if (b.x + BULLET_R > W)    { b.x = W - BULLET_R;  b.vx = -Math.abs(b.vx); wall = true; }
    if (b.y - BULLET_R < 0)    { b.y = BULLET_R;      b.vy =  Math.abs(b.vy); wall = true; }
    if (b.y + BULLET_R > H)    { b.y = H - BULLET_R;  b.vy = -Math.abs(b.vy); wall = true; }
    if (wall) {
      if (b.bounced) { dead.add(i); continue; }
      b.bounced = true;
    }

    // Bullet hits tank (axis-aligned box check)
    for (const p of s.players) {
      if (!p.alive || p.name === b.owner) continue;
      if (Math.abs(b.x - p.x) < TANK_W / 2 + BULLET_R &&
          Math.abs(b.y - p.y) < TANK_H / 2 + BULLET_R) {
        p.hp--;
        dead.add(i);
        bcast(s, { type: 'tank_hit', name: p.name, hp: p.hp });
        if (p.hp <= 0) {
          p.alive = false;
          bcast(s, { type: 'tank_destroyed', name: p.name });
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
      hp: p.hp,
      alive: p.alive,
    })),
    bullets: s.bullets.map(b => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
    })),
  });
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

    // ── rematch ───────────────────────────────────────────────────────────
    } else if (msg.type === 'tank_rematch') {
      if (!sess || !me || sess.state !== 'game_over') return;
      if (sess.interval) { clearInterval(sess.interval); sess.interval = null; }
      sess.state = 'waiting';
      sess.bullets = [];
      for (const p of sess.players) {
        p.input = { up: false, down: false, left: false, right: false, fire: false };
        p.vel = 0;
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
    lastFire: 0, vel: 0,
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
