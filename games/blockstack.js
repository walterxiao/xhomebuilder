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

// Find the Y coordinate where a block landing at (bx, bx+bw) would rest
// Returns the top-Y of the placed block
function computeLandY(stack, bx, bw, bh) {
  let highestTop = GROUND_Y; // ground surface
  for (const b of stack) {
    // Check horizontal overlap
    const overlapL = Math.max(bx, b.x);
    const overlapR = Math.min(bx + bw, b.x + b.w);
    if (overlapR > overlapL + 1) {
      // overlaps — check if this block's top is higher
      if (b.y < highestTop) {
        highestTop = b.y;
      }
    }
  }
  return highestTop - bh;
}

// Check if new block is stable. Returns { stable, wobble }
// wobble = true if it's barely stable (center of mass near edge)
function checkStability(stack, nb) {
  const nbCx = nb.x + nb.w / 2;

  // Find all blocks that support nb (their top = nb.y + nb.h, overlap)
  const supports = stack.filter(b => {
    if (b === nb) return false;
    const topOfB = b.y; // b.y is the top of b
    // support means nb rests on b: nb.y + nb.h ≈ b.y (nb bottom = b top)
    if (Math.abs((nb.y + nb.h) - b.y) > 2) return false;
    const overlapL = Math.max(nb.x, b.x);
    const overlapR = Math.min(nb.x + nb.w, b.x + b.w);
    return overlapR > overlapL + 1;
  });

  // If resting on ground (no supports), always stable
  if (supports.length === 0) {
    // check if resting on ground
    if (Math.abs(nb.y + nb.h - GROUND_Y) < 2) return { stable: true, wobble: false };
    // floating — unstable
    return { stable: false, wobble: false };
  }

  // Find support span
  let supL = Infinity, supR = -Infinity;
  for (const b of supports) {
    const overlapL = Math.max(nb.x, b.x);
    const overlapR = Math.min(nb.x + nb.w, b.x + b.w);
    if (overlapL < supL) supL = overlapL;
    if (overlapR > supR) supR = overlapR;
  }

  const supCenter = (supL + supR) / 2;
  const supSpan = supR - supL;

  // Center of mass must be within support span
  if (nbCx < supL || nbCx > supR) {
    return { stable: false, wobble: false };
  }

  // Wobble if within 15% of block width from edge of support
  const wobbleThresh = nb.w * 0.15;
  const wobble = (nbCx - supL < wobbleThresh) || (supR - nbCx < wobbleThresh);

  return { stable: true, wobble };
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
  // Clamp x to valid range
  x = Math.max(0, Math.min(GAME_W - block.w, x));

  const landY = computeLandY(s.stack, x, block.w, block.h);
  const playerIdx = s.currentTurn;
  const player = s.players[playerIdx];

  const newBlock = {
    id: s.nextBlockId++,
    x,
    y: landY,
    w: block.w,
    h: block.h,
    color: player.color,
    playerIdx,
    wobble: false
  };

  // Check stability before adding to stack
  const tempStack = [...s.stack, newBlock];
  const stability = checkStability(tempStack, newBlock);

  if (!stability.stable) {
    // Game over — add block briefly then collapse
    s.gameOver = true;
    s.stack.push(newBlock);
    broadcast(s, {
      type: 'dropped',
      block: newBlock,
      landY,
      stable: false,
      playerIdx,
      isAuto
    });
    setTimeout(() => {
      broadcast(s, { type: 'game_over', loserIdx: playerIdx, loserName: player.name, stack: s.stack });
    }, 1500);
    return;
  }

  newBlock.wobble = stability.wobble;
  s.stack.push(newBlock);

  broadcast(s, {
    type: 'dropped',
    block: newBlock,
    landY,
    stable: true,
    wobble: stability.wobble,
    playerIdx,
    isAuto
  });

  // Move to next turn
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
