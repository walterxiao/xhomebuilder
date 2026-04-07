const { WebSocketServer } = require('ws');

// 48-square track: clockwise starting bottom-left
const TRACK = [
  [13,1],[13,2],[13,3],[13,4],[13,5],[13,6],[13,7],[13,8],[13,9],[13,10],[13,11],[13,12],[13,13],
  [12,13],[11,13],[10,13],[9,13],[8,13],[7,13],[6,13],[5,13],[4,13],[3,13],[2,13],[1,13],
  [1,12],[1,11],[1,10],[1,9],[1,8],[1,7],[1,6],[1,5],[1,4],[1,3],[1,2],[1,1],
  [2,1],[3,1],[4,1],[5,1],[6,1],[7,1],[8,1],[9,1],[10,1],[11,1],[12,1],
];

const PLAYER_CONFIG = {
  red:    { entry: 0,  home: [[10,2],[11,2],[10,3],[11,3]],     safeZone: [[7,2],[7,3],[7,4],[7,5],[7,6]] },
  green:  { entry: 12, home: [[10,11],[11,11],[10,12],[11,12]], safeZone: [[12,7],[11,7],[10,7],[9,7],[8,7]] },
  blue:   { entry: 24, home: [[2,11],[3,11],[2,12],[3,12]],     safeZone: [[7,12],[7,11],[7,10],[7,9],[7,8]] },
  yellow: { entry: 36, home: [[2,2],[3,2],[2,3],[3,3]],         safeZone: [[2,7],[3,7],[4,7],[5,7],[6,7]] },
};

const ALL_COLORS = ['red', 'green', 'blue', 'yellow'];
const CENTER = [7, 7];

const wss = new WebSocketServer({ noServer: true });
let nextSessionId = 1;
const sessions = new Map();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
  session.observers.forEach(o => send(o.ws, obj));
}

function broadcastPlayers(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}

// relPos: -1=hangar, 0-47=track(main+safe), 48=finished
// relPos 43-47 = safe zone cells (safeZone[0..4])
// relPos 42 = safe zone trigger (still on main track)
function getCoord(color, relPos) {
  if (relPos < 0) return null;
  if (relPos === 48) return CENTER;
  const cfg = PLAYER_CONFIG[color];
  if (relPos >= 43) return cfg.safeZone[relPos - 43];
  return TRACK[(cfg.entry + relPos) % 48];
}

function coordEq(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

function makePieces() {
  const p = {};
  for (const c of ALL_COLORS) p[c] = [-1, -1, -1, -1];
  return p;
}

function playerListData(session) {
  return session.players.map(p => ({ name: p.name, color: p.color }));
}

function sessionSummary(id, session) {
  return {
    id,
    phase: session.phase,
    players: playerListData(session),
    observers: session.observers.length,
  };
}

// Returns indices (0-3) of pieces that can legally move with this dice value
function getMovable(session, color, diceVal) {
  const pieces = session.pieces[color];
  const movable = [];
  pieces.forEach((relPos, idx) => {
    if (relPos === 48) return;
    if (relPos === -1) {
      if (diceVal === 6) movable.push(idx);
      return;
    }
    const newRel = relPos + diceVal;
    if (newRel > 48) return;
    const dest = getCoord(color, newRel);
    // Can't land on own piece
    const blocked = pieces.some((pos2, i2) => {
      if (i2 === idx || pos2 < 0 || pos2 === 48) return false;
      return coordEq(getCoord(color, pos2), dest);
    });
    if (!blocked) movable.push(idx);
  });
  return movable;
}

function doMove(session, color, pieceIdx, diceVal) {
  const pieces = session.pieces[color];
  const fromPos = pieces[pieceIdx];
  const toPos = fromPos === -1 ? 0 : fromPos + diceVal;
  pieces[pieceIdx] = toPos;

  const dest = getCoord(color, toPos);
  const captures = [];

  // Captures only happen on the main track (relPos 0-42), not in safe zone or finish
  if (toPos >= 0 && toPos <= 42) {
    for (const otherColor of ALL_COLORS) {
      if (otherColor === color) continue;
      session.pieces[otherColor].forEach((pos, i) => {
        if (pos < 0 || pos >= 43) return;
        if (coordEq(getCoord(otherColor, pos), dest)) {
          session.pieces[otherColor][i] = -1;
          captures.push({ color: otherColor, pieceIdx: i });
        }
      });
    }
  }

  return { fromPos, toPos, captures };
}

function isColorDone(session, color) {
  return session.pieces[color].every(p => p === 48);
}

function advanceTurn(session) {
  const order = session.activeColors;
  if (order.length === 0) return;
  let tries = 0;
  do {
    session.currentColorIdx = (session.currentColorIdx + 1) % order.length;
    tries++;
  } while (tries < order.length && isColorDone(session, order[session.currentColorIdx]));
  session.diceRolled = false;
  session.diceValue = null;
}

// ---- WebSocket handler ----

wss.on('connection', (ws) => {
  ws.apSessionId = null;
  ws.apColor = null;
  ws.apName = null;
  ws.apIsObserver = false;
  ws.apObservingId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'aj_get_sessions': handleGetSessions(ws); break;
      case 'aj_create':  handleCreate(ws, msg.name); break;
      case 'aj_join':    handleJoin(ws, msg.name, msg.sessionId, msg.color); break;
      case 'aj_observe': handleObserve(ws, msg.name, msg.sessionId); break;
      case 'aj_start':   handleStart(ws); break;
      case 'aj_roll':    handleRoll(ws); break;
      case 'aj_move':    handleMovePiece(ws, msg.pieceIdx); break;
      case 'aj_chat':    handleChat(ws, msg.text); break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function handleGetSessions(ws) {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.phase === 'lobby' && session.players.length < 4) {
      list.push(sessionSummary(id, session));
    }
  }
  send(ws, { type: 'aj_sessions', sessions: list });
}

function getSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    const max = 4;
    const cur = session.players.length;
    const host = session.players[0];
    list.push({
      id,
      hostName: host ? host.name : '?',
      players: cur,
      maxPlayers: max,
      observers: session.observers.length,
      canJoin: session.phase === 'lobby' && cur < max,
      canObserve: true,
      status: session.phase === 'lobby' ? 'waiting' : 'playing',
      label: session.phase === 'lobby' ? `${cur}/${max} players` : 'In progress'
    });
  }
  return list.filter(s => s.status !== 'over');
}

function handleCreate(ws, name) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'aj_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'aj_error', message: 'Please enter a name.' });

  const sessionId = nextSessionId++;
  const session = {
    players: [],
    observers: [],
    pieces: makePieces(),
    activeColors: [],
    currentColorIdx: 0,
    diceValue: null,
    diceRolled: false,
    gameOver: false,
    phase: 'lobby',
    hostColor: 'red',
  };
  sessions.set(sessionId, session);

  ws.apSessionId = sessionId;
  ws.apColor = 'red';
  ws.apName = cleanName;
  session.players.push({ ws, name: cleanName, color: 'red' });

  send(ws, {
    type: 'aj_joined',
    sessionId,
    color: 'red',
    isHost: true,
    players: playerListData(session),
  });
}

function handleJoin(ws, name, sessionId, color) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'aj_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'aj_error', message: 'Please enter a name.' });
  if (!ALL_COLORS.includes(color)) return send(ws, { type: 'aj_error', message: 'Invalid color.' });

  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'aj_error', message: 'Session not found.' });
  if (session.phase !== 'lobby') return send(ws, { type: 'aj_error', message: 'Game already started.' });
  if (session.players.length >= 4) return send(ws, { type: 'aj_error', message: 'Session is full.' });
  if (session.players.some(p => p.color === color)) return send(ws, { type: 'aj_error', message: 'Color already taken.' });

  ws.apSessionId = sessionId;
  ws.apColor = color;
  ws.apName = cleanName;
  session.players.push({ ws, name: cleanName, color });

  const list = playerListData(session);
  send(ws, { type: 'aj_joined', sessionId, color, isHost: false, players: list });
  session.players.forEach(p => { if (p.ws !== ws) send(p.ws, { type: 'aj_player_joined', players: list }); });
  session.observers.forEach(o => send(o.ws, { type: 'aj_player_joined', players: list }));
}

function handleObserve(ws, name, sessionId) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'aj_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'aj_error', message: 'Session not found.' });

  ws.apIsObserver = true;
  ws.apObservingId = sessionId;
  ws.apName = cleanName;
  session.observers.push({ ws, name: cleanName });

  broadcastPlayers(session, { type: 'aj_observer_count', count: session.observers.length });

  const curColor = session.activeColors[session.currentColorIdx] || null;
  send(ws, {
    type: 'aj_observe_start',
    sessionId,
    players: playerListData(session),
    phase: session.phase,
    pieces: session.pieces,
    activeColors: session.activeColors,
    currentColor: curColor,
    diceValue: session.diceValue,
    diceRolled: session.diceRolled,
  });
}

function handleStart(ws) {
  const session = sessions.get(ws.apSessionId);
  if (!session || session.phase !== 'lobby') return;
  if (ws.apColor !== session.hostColor) return send(ws, { type: 'aj_error', message: 'Only the host can start.' });
  if (session.players.length < 2) return send(ws, { type: 'aj_error', message: 'Need at least 2 players.' });

  session.phase = 'playing';
  session.activeColors = session.players
    .map(p => p.color)
    .sort((a, b) => ALL_COLORS.indexOf(a) - ALL_COLORS.indexOf(b));
  session.currentColorIdx = 0;
  session.diceRolled = false;
  session.diceValue = null;

  broadcast(session, {
    type: 'aj_game_start',
    pieces: session.pieces,
    activeColors: session.activeColors,
    currentColor: session.activeColors[0],
  });
}

function handleRoll(ws) {
  const session = sessions.get(ws.apSessionId);
  if (!session || session.phase !== 'playing' || session.gameOver) return;
  const curColor = session.activeColors[session.currentColorIdx];
  if (ws.apColor !== curColor) return;
  if (session.diceRolled) return;

  const value = Math.floor(Math.random() * 6) + 1;
  session.diceValue = value;
  session.diceRolled = true;

  const movable = getMovable(session, curColor, value);
  broadcast(session, { type: 'aj_rolled', color: curColor, value, movable });

  if (movable.length === 0) {
    setTimeout(() => {
      if (!session || session.gameOver) return;
      advanceTurn(session);
      broadcast(session, { type: 'aj_turn', color: session.activeColors[session.currentColorIdx] });
    }, 1500);
  }
}

function handleMovePiece(ws, pieceIdx) {
  const session = sessions.get(ws.apSessionId);
  if (!session || session.phase !== 'playing' || session.gameOver) return;
  const curColor = session.activeColors[session.currentColorIdx];
  if (ws.apColor !== curColor) return;
  if (!session.diceRolled) return;
  if (typeof pieceIdx !== 'number' || pieceIdx < 0 || pieceIdx > 3) return;

  const movable = getMovable(session, curColor, session.diceValue);
  if (!movable.includes(pieceIdx)) return;

  const { fromPos, toPos, captures } = doMove(session, curColor, pieceIdx, session.diceValue);

  broadcast(session, {
    type: 'aj_moved',
    color: curColor,
    pieceIdx,
    fromPos,
    toPos,
    captures,
    pieces: session.pieces,
  });

  if (isColorDone(session, curColor)) {
    session.gameOver = true;
    const winner = session.players.find(p => p.color === curColor);
    broadcast(session, { type: 'aj_win', color: curColor, name: winner ? winner.name : curColor });
    return;
  }

  const extraTurn = session.diceValue === 6 || captures.length > 0;
  if (extraTurn) {
    session.diceRolled = false;
    session.diceValue = null;
    broadcast(session, { type: 'aj_turn', color: curColor, extraTurn: true });
  } else {
    advanceTurn(session);
    broadcast(session, { type: 'aj_turn', color: session.activeColors[session.currentColorIdx] });
  }
}

function handleChat(ws, text) {
  if (!ws.apName || typeof text !== 'string') return;
  const clean = text.trim().slice(0, 200);
  if (!clean) return;
  const sessionId = ws.apIsObserver ? ws.apObservingId : ws.apSessionId;
  const session = sessions.get(sessionId);
  if (!session) return;
  broadcast(session, { type: 'aj_chat', name: ws.apName, text: clean, isObserver: ws.apIsObserver });
}

function handleDisconnect(ws) {
  if (ws.apIsObserver) {
    const session = sessions.get(ws.apObservingId);
    if (session) {
      session.observers = session.observers.filter(o => o.ws !== ws);
      broadcastPlayers(session, { type: 'aj_observer_count', count: session.observers.length });
    }
    return;
  }

  if (!ws.apSessionId) return;
  const session = sessions.get(ws.apSessionId);
  if (!session) return;

  const idx = session.players.findIndex(p => p.ws === ws);
  if (idx === -1) return;
  const color = ws.apColor;
  session.players.splice(idx, 1);

  if (session.phase === 'lobby') {
    if (session.players.length === 0) { sessions.delete(ws.apSessionId); return; }
    if (color === session.hostColor) {
      session.hostColor = session.players[0].color;
      send(session.players[0].ws, { type: 'aj_you_are_host' });
    }
    broadcast(session, { type: 'aj_player_left', players: playerListData(session), color });
    return;
  }

  // Game in progress
  const colorIdx = session.activeColors.indexOf(color);
  if (colorIdx !== -1) {
    const wasCurrent = session.currentColorIdx === colorIdx;
    if (session.currentColorIdx >= colorIdx && session.currentColorIdx > 0) session.currentColorIdx--;
    session.activeColors.splice(colorIdx, 1);
  }

  broadcast(session, { type: 'aj_player_left', color, name: ws.apName });

  if (session.players.length === 0) { sessions.delete(ws.apSessionId); return; }
  if (session.activeColors.length <= 1) {
    if (session.activeColors.length === 1 && !session.gameOver) {
      const lastColor = session.activeColors[0];
      const lastPlayer = session.players.find(p => p.color === lastColor);
      session.gameOver = true;
      broadcast(session, { type: 'aj_win', color: lastColor, name: lastPlayer ? lastPlayer.name : lastColor });
    }
    return;
  }

  session.currentColorIdx = session.currentColorIdx % session.activeColors.length;
  session.diceRolled = false;
  session.diceValue = null;
  broadcast(session, { type: 'aj_turn', color: session.activeColors[session.currentColorIdx] });
}

module.exports = { wss, TRACK, PLAYER_CONFIG, ALL_COLORS, getSessionList };
