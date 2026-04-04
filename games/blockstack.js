'use strict';
const { WebSocketServer } = require('ws');

const GAME_W = 400;
const GROUND_Y = 520;
const MAX_PLAYERS = 6;
const TURN_TIME = 15; // seconds
const MIN_BW = 35, MAX_BW = 95;
const MIN_BH = 11, MAX_BH = 26;
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#1abc9c'];

const wss = new WebSocketServer({ noServer: true });

let sessions = {};

function makeId() {
  return Math.random().toString(36).slice(2, 8);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randBlock() {
  return {
    w: randInt(MIN_BW, MAX_BW),
    h: randInt(MIN_BH, MAX_BH)
  };
}

// ── Realistic stacking physics ──
//
// computeLandY: where a dropped block comes to rest (highest overlapping surface)
// checkStackStability: full aggregate-COM check on the entire stack
//   - sorts blocks top-to-bottom
//   - at each level, computes combined center of mass of ALL blocks above that level
//   - checks that COM falls within the physical support footprint at that level
//   - a block can cantilever as long as the aggregate COM is still supported below
//
function computeLandY(stack, bx, bw, bh) {
  if (stack.length === 0) return GROUND_Y - bh;

  const stackTopY = Math.min(...stack.map(b => b.y));

  // Highest block that horizontally overlaps the new block
  let highestTop = GROUND_Y;
  for (const b of stack) {
    const ol = Math.max(bx, b.x);
    const or_ = Math.min(bx + bw, b.x + b.w);
    if (or_ > ol + 1 && b.y < highestTop) highestTop = b.y;
  }

  // Block must touch the topmost block (no skipping to a lower gap)
  const capY = stackTopY - bh;
  return Math.min(highestTop - bh, capY);
}

function checkStackStability(stack) {
  if (stack.length === 0) return { stable: true, wobblyIds: new Set() };

  // Sort topmost-first (ascending Y)
  const sorted = [...stack].sort((a, b) => a.y - b.y);

  const wobblyIds = new Set();

  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];

    // Find blocks that physically support this block (directly below, overlapping)
    const supports = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const s = sorted[j];
      if (Math.abs((block.y + block.h) - s.y) > 2) continue;
      const ol = Math.max(block.x, s.x);
      const or_ = Math.min(block.x + block.w, s.x + s.w);
      if (or_ > ol + 1) supports.push({ s, ol, or_ });
    }

    // No support found — must be resting on ground
    if (supports.length === 0) {
      if (Math.abs(block.y + block.h - GROUND_Y) <= 2) continue; // on ground = fine
      // Floating block → unstable
      return { stable: false, wobblyIds, unstableBlockId: block.id, tipDir: 0 };
    }

    // Aggregate centre-of-mass of this block and everything above it
    // (sorted[0..i] = all blocks at or above the current level)
    let totalMass = 0, weightedX = 0;
    for (let k = 0; k <= i; k++) {
      const b = sorted[k];
      const mass = b.w * b.h; // treat area as mass (uniform density)
      totalMass += mass;
      weightedX += (b.x + b.w / 2) * mass;
    }
    const comX = weightedX / totalMass;

    // Physical support footprint = union of overlap regions with supporting blocks
    let supL = supports[0].ol, supR = supports[0].or_;
    for (const { ol, or_ } of supports) {
      if (ol < supL) supL = ol;
      if (or_ > supR) supR = or_;
    }

    // Stability test: aggregate COM must fall within support footprint
    if (comX < supL) {
      return { stable: false, wobblyIds, unstableBlockId: block.id, tipDir: -1 };
    }
    if (comX > supR) {
      return { stable: false, wobblyIds, unstableBlockId: block.id, tipDir: 1 };
    }

    // Wobble: COM within 18% of support span from either edge
    const supSpan = supR - supL;
    if (supSpan > 0 && (comX - supL < supSpan * 0.18 || supR - comX < supSpan * 0.18)) {
      wobblyIds.add(block.id);
    }
  }

  return { stable: true, wobblyIds };
}

function getSession(id) {
  return sessions[id];
}

function broadcast(s, msg) {
  const str = JSON.stringify(msg);
  for (const p of s.players) {
    if (p.ws.readyState === 1) p.ws.send(str);
  }
  for (const o of s.observers) {
    if (o.readyState === 1) o.send(str);
  }
}

function broadcastLobby(s) {
  broadcast(s, {
    type: 'lobby',
    players: s.players.map(p => ({ name: p.name, color: p.color, idx: p.idx })),
    started: s.started,
    stack: s.stack,
    currentTurn: s.currentTurn,
    currentBlock: s.currentBlock
  });
}

function startTurn(s) {
  clearInterval(s.turnTimer);
  s.timerLeft = TURN_TIME;
  const block = randBlock();
  s.currentBlock = block;
  s.sliderX = 0; // reset slider to left

  broadcast(s, {
    type: 'new_turn',
    playerIdx: s.currentTurn,
    playerName: s.players[s.currentTurn].name,
    playerColor: s.players[s.currentTurn].color,
    block,
    timeLeft: TURN_TIME
  });

  s.turnTimer = setInterval(() => {
    s.timerLeft--;
    broadcast(s, { type: 'timer', timeLeft: s.timerLeft });
    if (s.timerLeft <= 0) {
      clearInterval(s.turnTimer);
      // auto-drop at current slider position
      const autoX = s.sliderX != null ? s.sliderX : Math.floor((GAME_W - s.currentBlock.w) / 2);
      handleDrop(s, autoX, true);
    }
  }, 1000);
}

function handleDrop(s, x, isAuto) {
  if (!s.started || s.gameOver) return;
  clearInterval(s.turnTimer);

  const block = s.currentBlock;
  x = Math.max(0, Math.min(GAME_W - block.w, x));

  const landY = computeLandY(s.stack, x, block.w, block.h);
  const playerIdx = s.currentTurn;
  const player = s.players[playerIdx];

  const newBlock = {
    id: s.nextBlockId++,
    x, y: landY,
    w: block.w, h: block.h,
    color: player.color,
    playerIdx,
    wobble: false
  };

  s.stack.push(newBlock);

  // Full aggregate-COM stability check on the entire stack
  const result = checkStackStability(s.stack);

  // Propagate updated wobble flags to all blocks
  for (const b of s.stack) b.wobble = result.wobblyIds.has(b.id);

  const wobbleUpdates = s.stack.map(b => ({ id: b.id, wobble: b.wobble }));

  if (!result.stable) {
    s.gameOver = true;
    broadcast(s, {
      type: 'dropped',
      block: newBlock, landY,
      stable: false,
      unstableBlockId: result.unstableBlockId,
      tipDir: result.tipDir,
      wobbleUpdates,
      playerIdx, isAuto
    });
    setTimeout(() => {
      broadcast(s, { type: 'game_over', loserIdx: playerIdx, loserName: player.name, stack: s.stack });
    }, 1500);
    return;
  }

  broadcast(s, {
    type: 'dropped',
    block: newBlock, landY,
    stable: true,
    wobbleUpdates,
    playerIdx, isAuto
  });

  setTimeout(() => {
    if (!s.gameOver) {
      s.currentTurn = (s.currentTurn + 1) % s.players.length;
      startTurn(s);
    }
  }, 1300);
}

wss.on('connection', (ws) => {
  let sess = null;
  let playerIdx = -1;
  let isObserver = false;

  function send(obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      // Create new session
      const id = makeId();
      sess = {
        id,
        players: [],
        observers: [],
        stack: [],
        started: false,
        gameOver: false,
        currentTurn: 0,
        currentBlock: null,
        sliderX: 0,
        timerLeft: TURN_TIME,
        turnTimer: null,
        nextBlockId: 1
      };
      sessions[id] = sess;
      const color = COLORS[0];
      const player = { ws, name: msg.name || 'Player 1', color, idx: 0 };
      sess.players.push(player);
      playerIdx = 0;
      send({ type: 'created', sessionId: id, playerIdx: 0, color });
      broadcastLobby(sess);

    } else if (msg.type === 'join') {
      sess = sessions[msg.sessionId];
      if (!sess) { send({ type: 'error', msg: 'Session not found' }); return; }

      if (sess.players.length >= MAX_PLAYERS) {
        // Join as observer
        isObserver = true;
        sess.observers.push(ws);
        send({
          type: 'obs_joined',
          players: sess.players.map(p => ({ name: p.name, color: p.color, idx: p.idx })),
          stack: sess.stack,
          started: sess.started,
          currentTurn: sess.currentTurn,
          currentBlock: sess.currentBlock,
          timeLeft: sess.timerLeft
        });
        return;
      }

      const color = COLORS[sess.players.length % COLORS.length];
      const player = { ws, name: msg.name || `Player ${sess.players.length + 1}`, color, idx: sess.players.length };
      sess.players.push(player);
      playerIdx = player.idx;

      if (sess.started) {
        // Mid-game join — send full state
        send({
          type: 'joined',
          sessionId: sess.id,
          playerIdx,
          color,
          stack: sess.stack,
          started: true,
          currentTurn: sess.currentTurn,
          currentBlock: sess.currentBlock,
          timeLeft: sess.timerLeft,
          players: sess.players.map(p => ({ name: p.name, color: p.color, idx: p.idx }))
        });
      } else {
        send({ type: 'joined', sessionId: sess.id, playerIdx, color });
      }
      broadcastLobby(sess);

    } else if (msg.type === 'start') {
      if (!sess || sess.started || playerIdx !== 0) return;
      if (sess.players.length < 1) return;
      sess.started = true;
      broadcast(sess, { type: 'start', players: sess.players.map(p => ({ name: p.name, color: p.color, idx: p.idx })) });
      startTurn(sess);

    } else if (msg.type === 'slide_pos') {
      // Update current slider position and broadcast to all other viewers
      if (!sess || playerIdx !== sess.currentTurn) return;
      sess.sliderX = msg.x;
      const posStr = JSON.stringify({ type: 'slide_pos', x: msg.x });
      for (const p of sess.players) {
        if (p.idx !== playerIdx && p.ws.readyState === 1) p.ws.send(posStr);
      }
      for (const o of sess.observers) {
        if (o.readyState === 1) o.send(posStr);
      }

    } else if (msg.type === 'drop') {
      if (!sess || playerIdx !== sess.currentTurn || sess.gameOver) return;
      if (sess.timerLeft <= 0) return; // timer already fired
      handleDrop(sess, msg.x, false);

    } else if (msg.type === 'play_again') {
      if (!sess || playerIdx !== 0) return;
      // Reset session
      clearInterval(sess.turnTimer);
      sess.stack = [];
      sess.started = true;
      sess.gameOver = false;
      sess.currentTurn = 0;
      sess.timerLeft = TURN_TIME;
      sess.nextBlockId = 1;
      broadcast(sess, { type: 'play_again', players: sess.players.map(p => ({ name: p.name, color: p.color, idx: p.idx })) });
      startTurn(sess);

    } else if (msg.type === 'chat') {
      if (!sess) return;
      const name = isObserver ? 'Observer' : (sess.players[playerIdx]?.name || 'Player');
      broadcast(sess, { type: 'chat', name, text: msg.text });
    }
  });

  ws.on('close', () => {
    if (!sess) return;
    if (isObserver) {
      sess.observers = sess.observers.filter(o => o !== ws);
      return;
    }
    if (playerIdx < 0) return;
    const name = sess.players[playerIdx]?.name || 'Player';
    // Remove player
    sess.players = sess.players.filter((_, i) => i !== playerIdx);
    // Re-index
    sess.players.forEach((p, i) => { p.idx = i; });
    broadcastLobby(sess);

    if (sess.players.length === 0) {
      clearInterval(sess.turnTimer);
      delete sessions[sess.id];
      return;
    }

    // If it was this player's turn, advance
    if (sess.started && !sess.gameOver) {
      if (playerIdx === sess.currentTurn || playerIdx < sess.currentTurn) {
        sess.currentTurn = sess.currentTurn % Math.max(1, sess.players.length);
      }
      clearInterval(sess.turnTimer);
      startTurn(sess);
    }
  });
});

function getSessionList() {
  return Object.values(sessions).map(s => ({
    id: s.id,
    players: s.players.map(p => ({ name: p.name, color: p.color })),
    started: s.started,
    gameOver: s.gameOver,
    blockCount: s.stack.length,
    maxPlayers: MAX_PLAYERS
  }));
}

module.exports = { wss, getSessionList };
