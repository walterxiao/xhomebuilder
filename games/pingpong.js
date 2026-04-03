'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Constants ────────────────────────────────────────────────────────────────
const W = 600, H = 800;
const BALL_R = 12;
const PAD_H = 15;
const TEAM0_Y = H - 60;   // blue team paddle top-y (bottom of table)
const TEAM1_Y = 45;        // red team paddle top-y  (top of table)
const PAD_SPEED = 8;
const PAD_W_SOLO = 160;
const PAD_W_DUO  = 100;
const INIT_SPEED = 6;
const MAX_SPEED  = 13;
const SPIN_FACTOR = 0.12;
const SPIN_DECAY  = 0.97;
const SPIN_CURVE  = 0.25;
const WIN   = 11;
const TICK  = 16;          // ~60 fps

// ── Helpers ──────────────────────────────────────────────────────────────────
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function bcast(s, o) {
  const m = JSON.stringify(o);
  for (const p of s.players) if (p.ws.readyState === 1) p.ws.send(m);
  for (const ob of s.obs)    if (ob.ws.readyState === 1) ob.ws.send(m);
}

// ── Session management ───────────────────────────────────────────────────────
let nextId = 1;
const sessions = new Map();
let openSess = null;

function mkSess() {
  const s = {
    id: nextId++, state: 'waiting',
    players: [], obs: [],
    score: [0, 0], serving: 0,
    ball: null, interval: null, paused: false,
  };
  sessions.set(s.id, s);
  return s;
}

const byTeam = (s, t) => s.players.filter(p => p.team === t);

// Assign paddle positions and zone constraints for all current players
function initPads(s) {
  for (const t of [0, 1]) {
    const tp = byTeam(s, t);
    for (const p of tp) {
      const duo = tp.length === 2;
      p.pw = duo ? PAD_W_DUO : PAD_W_SOLO;
      p.py = t === 0 ? TEAM0_Y : TEAM1_Y;
      if (duo) {
        // slot 0 = "left from THIS player's view"
        // Team 0 view = absolute coords → slot 0 = left half (low x)
        // Team 1 view is rotated 180° → slot 0 "left" = right half in absolute (high x)
        const leftInAbs = t === 0 ? p.slot === 0 : p.slot === 1;
        if (leftInAbs) {
          p.px = W / 4 - p.pw / 2;
          p.minX = 0;
          p.maxX = W / 2 - p.pw;
        } else {
          p.px = 3 * W / 4 - p.pw / 2;
          p.minX = W / 2;
          p.maxX = W - p.pw;
        }
      } else {
        p.px = W / 2 - p.pw / 2;
        p.minX = 0;
        p.maxX = W - p.pw;
      }
      p.vel = 0;
    }
  }
}

// ── Ball ─────────────────────────────────────────────────────────────────────
function serveBall(s) {
  s.paused = false;
  const spd = INIT_SPEED;
  // Serving team shoots toward opponent:
  // Team 0 (bottom, high y) serves upward → negative vy
  // Team 1 (top,    low y)  serves downward → positive vy
  const vy = s.serving === 0 ? -spd : spd;
  const jitter = (Math.random() - 0.5) * 1.5;
  s.ball = { x: W / 2, y: H / 2, vx: jitter, vy, spin: 0, spd };
  bcast(s, { type: 'serve', serving: s.serving });
}

function startGame(s) {
  s.state = 'playing';
  s.score = [0, 0];
  s.serving = 0;
  for (const p of s.players) { p.input = { l: false, r: false }; p.vel = 0; }
  initPads(s);
  bcast(s, {
    type: 'start',
    players: s.players.map(p => ({ id: p.id, name: p.name, team: p.team, slot: p.slot })),
    W, H,
  });
  s.paused = true;
  setTimeout(() => { if (s.state === 'playing') serveBall(s); }, 2500);
  s.interval = setInterval(() => tick(s), TICK);
}

// ── Game tick ────────────────────────────────────────────────────────────────
function tick(s) {
  if (s.state !== 'playing' || s.paused || !s.ball) return;
  const b = s.ball;

  // Move paddles based on held inputs
  for (const p of s.players) {
    let dx = 0;
    if (p.input.l) dx -= PAD_SPEED;
    if (p.input.r) dx += PAD_SPEED;
    // Team 1 sees the table rotated 180°, so their left/right are inverted in absolute coords
    if (p.team === 1) dx = -dx;
    p.vel = dx;
    p.px = Math.max(p.minX, Math.min(p.maxX, p.px + dx));
  }

  // Spin curves the ball
  b.vx += b.spin * SPIN_CURVE;
  b.spin *= SPIN_DECAY;
  b.spin = Math.max(-2.5, Math.min(2.5, b.spin));

  b.x += b.vx;
  b.y += b.vy;

  // Side wall bounces
  if (b.x - BALL_R < 0) {
    b.x = BALL_R;
    b.vx = Math.abs(b.vx);
    b.spin *= -0.5;
  }
  if (b.x + BALL_R > W) {
    b.x = W - BALL_R;
    b.vx = -Math.abs(b.vx);
    b.spin *= -0.5;
  }

  // Paddle collisions
  for (const p of s.players) collidePaddle(b, p);

  // Keep total speed in bounds
  const cs = Math.hypot(b.vx, b.vy);
  if (cs > MAX_SPEED) { b.vx *= MAX_SPEED / cs; b.vy *= MAX_SPEED / cs; }

  // Scoring
  if (b.y + BALL_R > H) { pointScored(s, 1); return; } // past blue (team 0) → red scores
  if (b.y - BALL_R < 0) { pointScored(s, 0); return; } // past red  (team 1) → blue scores

  bcast(s, {
    type: 'g',
    b: { x: b.x, y: b.y },
    p: s.players.map(p => ({ x: p.px, y: p.py, w: p.pw, t: p.team, s: p.slot, n: p.name })),
    sc: s.score,
  });
}

function collidePaddle(b, p) {
  // AABB-circle collision
  const cx = Math.max(p.px, Math.min(p.px + p.pw, b.x));
  const cy = Math.max(p.py, Math.min(p.py + PAD_H, b.y));
  const dx = b.x - cx, dy = b.y - cy;
  if (dx * dx + dy * dy >= BALL_R * BALL_R) return;

  const up = p.team === 0; // team 0 at bottom deflects ball upward

  // Deflection angle based on where ball hits the paddle (edge = steep, center = shallow)
  const hit  = Math.max(0, Math.min(1, (b.x - p.px) / p.pw)); // 0..1
  const defl = (hit - 0.5) * 2;                                  // -1..1

  // Speed increases slightly each hit
  const currSpd = Math.hypot(b.vx, b.vy);
  b.spd = Math.min(MAX_SPEED, Math.max(currSpd, b.spd) * 1.04);

  b.vx = defl * b.spd * 0.7;
  const vyMag = Math.sqrt(Math.max(0.01, b.spd * b.spd - b.vx * b.vx));
  b.vy = up ? -vyMag : vyMag;

  // Spin from paddle's horizontal velocity at moment of impact
  b.spin = Math.max(-2.5, Math.min(2.5, b.spin + p.vel * SPIN_FACTOR));

  // Push ball clear of paddle
  b.y = up ? p.py - BALL_R : p.py + PAD_H + BALL_R;
}

// ── Scoring & game end ───────────────────────────────────────────────────────
function pointScored(s, scorer) {
  s.score[scorer]++;
  s.paused = true;
  s.ball = null;
  bcast(s, { type: 'pt', scorer, score: s.score });

  if (s.score[scorer] >= WIN) { endGame(s, scorer); return; }

  // Loser serves next
  s.serving = 1 - scorer;
  setTimeout(() => {
    if (s.state !== 'playing') return;
    for (const p of s.players) { p.input = { l: false, r: false }; p.vel = 0; }
    initPads(s);
    serveBall(s);
  }, 2000);
}

function endGame(s, winner) {
  s.state = 'game_over';
  clearInterval(s.interval);
  s.interval = null;
  bcast(s, {
    type: 'over', winner,
    names: s.players.filter(p => p.team === winner).map(p => p.name),
    score: s.score,
  });
}

// ── Lobby broadcast ──────────────────────────────────────────────────────────
function lobbyData(s) {
  return {
    type: 'lobby',
    players: s.players.map(p => ({ name: p.name, team: p.team, slot: p.slot })),
    obs: s.obs.length,
    state: s.state,
    sid: s.id,
  };
}

// ── WebSocket connections ────────────────────────────────────────────────────
wss.on('connection', ws => {
  let sess = null, me = null, isObs = false;

  // Send current lobby snapshot immediately on connect
  send(ws, openSess
    ? lobbyData(openSess)
    : { type: 'lobby', players: [], obs: 0, state: 'waiting', sid: null }
  );

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── join ──────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      if (sess) return;
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return;

      if (!openSess) openSess = mkSess();
      sess = openSess;

      const pref = (msg.team === 0 || msg.team === 1) ? msg.team : -1;
      let team = -1, slot = -1;

      const tryTeam = t => {
        const tp = byTeam(sess, t);
        if (tp.length >= 2) return false;
        team = t;
        slot = tp.some(p => p.slot === 0) ? 1 : 0;
        return true;
      };

      if (pref >= 0) {
        tryTeam(pref) || tryTeam(1 - pref);
      } else {
        const l0 = byTeam(sess, 0).length, l1 = byTeam(sess, 1).length;
        (l0 <= l1 ? tryTeam(0) || tryTeam(1) : tryTeam(1) || tryTeam(0));
      }

      if (team < 0) {
        // All slots taken → observe
        isObs = true;
        sess.obs.push({ ws, name });
        send(ws, { type: 'obs_joined', score: sess.score, state: sess.state, W, H });
        return;
      }

      me = {
        ws, name, team, slot,
        id: `${sess.id}_${team}_${slot}`,
        px: 0, py: 0, pw: PAD_W_SOLO,
        minX: 0, maxX: W - PAD_W_SOLO,
        vel: 0, input: { l: false, r: false },
      };
      sess.players.push(me);
      if (sess.players.length >= 4) openSess = null;

      send(ws, {
        type: 'joined', team, slot, W, H,
        isHost: sess.players[0] === me,
        canStart: byTeam(sess, 0).length > 0 && byTeam(sess, 1).length > 0,
      });
      bcast(sess, lobbyData(sess));

    // ── observe (explicit request to watch) ──────────────────────────────
    } else if (msg.type === 'observe') {
      if (sess) return;
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) return;
      const target = openSess || [...sessions.values()][0];
      if (!target) return;
      sess = target;
      isObs = true;
      sess.obs.push({ ws, name });
      send(ws, { type: 'obs_joined', score: sess.score, state: sess.state, W, H });

    // ── start game ────────────────────────────────────────────────────────
    } else if (msg.type === 'start') {
      if (!sess || !me || sess.state !== 'waiting') return;
      if (sess.players[0] !== me) return; // host only
      if (!byTeam(sess, 0).length || !byTeam(sess, 1).length) return;
      openSess = null;
      startGame(sess);

    // ── player input ──────────────────────────────────────────────────────
    } else if (msg.type === 'in') {
      if (!me || sess.state !== 'playing') return;
      me.input.l = !!msg.l;
      me.input.r = !!msg.r;

    // ── chat ──────────────────────────────────────────────────────────────
    } else if (msg.type === 'chat') {
      if (!sess) return;
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) return;
      bcast(sess, { type: 'chat', name: me ? me.name : 'Observer', text });

    // ── rematch ───────────────────────────────────────────────────────────
    } else if (msg.type === 'rematch') {
      if (!sess || !me || sess.state !== 'game_over') return;
      if (sess.interval) { clearInterval(sess.interval); sess.interval = null; }
      sess.state = 'waiting';
      sess.score = [0, 0];
      sess.ball = null;
      for (const p of sess.players) { p.input = { l: false, r: false }; p.vel = 0; }
      if (!openSess) openSess = sess;
      bcast(sess, { type: 'rematch' });
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
      sess.players = sess.players.filter(p => p !== me);
      if (sess.interval) { clearInterval(sess.interval); sess.interval = null; }
      sess.ball = null;

      if (!sess.players.length && !sess.obs.length) {
        sessions.delete(sess.id);
        if (openSess === sess) openSess = null;
        return;
      }

      if (sess.state === 'playing') {
        sess.state = 'waiting';
        bcast(sess, { type: 'left', name: me.name });
      }
      if (!openSess && sess.players.length < 4 && sess.state === 'waiting') openSess = sess;
      bcast(sess, lobbyData(sess));
    }
  });
});

module.exports = { wss };
