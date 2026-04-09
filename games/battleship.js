const { WebSocketServer } = require('ws');

const GRID_SIZE = 10;
const FLEET = [
  { id: 'carrier',    size: 5 },
  { id: 'battleship', size: 4 },
  { id: 'cruiser',    size: 3 },
  { id: 'submarine',  size: 3 },
  { id: 'destroyer',  size: 2 },
];

let nextSessionId = 1;
const sessions = new Map();

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  ws.sessionId = null;
  ws.playerIndex = null; // 0 | 1 for players, -1 for observers
  ws.playerName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'bs_create')   handleCreate(ws, msg.name);
    if (msg.type === 'bs_join')     handleJoin(ws, msg.name, msg.sessionId);
    if (msg.type === 'bs_place')    handlePlace(ws, msg.ships);
    if (msg.type === 'bs_fire')     handleFire(ws, msg.row, msg.col);
    if (msg.type === 'bs_rematch')  handleRematch(ws);
    if (msg.type === 'bs_chat')     handleChat(ws, msg.text);
    if (msg.type === 'bs_sessions') handleSessionsList(ws);
    if (msg.type === 'bs_observe')  handleObserve(ws, msg.sessionId);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendBoth(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}

function sendObservers(session, obj) {
  session.observers.forEach(o => send(o.ws, obj));
}

// Send to players + observers
function sendAll(session, obj) {
  sendBoth(session, obj);
  sendObservers(session, obj);
}

// ── Join / Matchmaking ────────────────────────────────────────────────────────

function handleCreate(ws, name) {
  if (ws.sessionId !== null) return;
  if (!name || typeof name !== 'string') return send(ws, { type: 'bs_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'bs_error', message: 'Please enter a name.' });

  ws.playerName = cleanName;

  const sessionId = nextSessionId++;
  const session = {
    players: [
      { ws, name: cleanName, ships: null, grid: makeGrid(), fired: new Set() },
    ],
    observers: [],
    phase: 'placement',
    currentTurn: 0,
    rematchVotes: new Set(),
  };
  sessions.set(sessionId, session);

  ws.sessionId = sessionId;
  ws.playerIndex = 0;

  send(ws, { type: 'bs_waiting', sessionId });
}

function handleJoin(ws, name, sessionId) {
  if (ws.sessionId !== null) return;
  if (!name || typeof name !== 'string') return send(ws, { type: 'bs_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'bs_error', message: 'Please enter a name.' });

  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'bs_error', message: 'Session not found.' });
  if (session.players.length !== 1) return send(ws, { type: 'bs_error', message: 'Session is not available.' });

  ws.playerName = cleanName;

  const host = session.players[0];
  session.players.push({ ws, name: cleanName, ships: null, grid: makeGrid(), fired: new Set() });

  ws.sessionId = sessionId;
  ws.playerIndex = 1;

  send(host.ws, { type: 'bs_start', myIndex: 0, opponentName: cleanName });
  send(ws,      { type: 'bs_start', myIndex: 1, opponentName: host.name });
}

function createSession(ws0, name0, ws1, name1) {
  return {
    players: [
      { ws: ws0, name: name0, ships: null, grid: makeGrid(), fired: new Set() },
      { ws: ws1, name: name1, ships: null, grid: makeGrid(), fired: new Set() },
    ],
    observers: [],
    phase: 'placement',
    currentTurn: 0,
    rematchVotes: new Set(),
  };
}

function makeGrid() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}

// ── Observer / Sessions List ──────────────────────────────────────────────────

function handleSessionsList(ws) {
  const list = [];
  for (const [id, s] of sessions) {
    if (s.phase === 'over') continue;
    list.push({
      id,
      playerNames: s.players.map(p => p.name),
      phase: s.phase,
      observerCount: s.observers.length,
    });
  }
  send(ws, { type: 'bs_sessions_list', sessions: list });
}

function handleObserve(ws, sessionId) {
  if (ws.sessionId !== null) return;
  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'bs_error', message: 'Game not found.' });
  if (session.phase === 'over') return send(ws, { type: 'bs_error', message: 'Game has ended.' });

  session.observers.push({ ws });
  ws.sessionId = sessionId;
  ws.playerIndex = -1;

  send(ws, {
    type: 'bs_observe_start',
    phase: session.phase,
    playerNames: session.players.map(p => p.name),
    currentTurn: session.currentTurn,
    grids: buildObserveGridState(session),
  });
}

function buildObserveGridState(session) {
  return session.players.map((p, pIdx) => {
    if (p.ships === null) return { ships: null, hits: [], misses: [], sunkShips: {} };

    const opponentFired = session.players[1 - pIdx].fired;
    const hits = [];
    const misses = [];
    const sunkShips = {};

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = p.grid[r][c];
        if (cell && cell.endsWith(':hit')) {
          hits.push(`${r},${c}`);
          const shipId = cell.replace(':hit', '');
          if (!sunkShips[shipId]) sunkShips[shipId] = [];
          sunkShips[shipId].push([r, c]);
        }
      }
    }

    // Only keep fully sunk ships
    for (const shipId of Object.keys(sunkShips)) {
      const fleet = FLEET.find(f => f.id === shipId);
      if (!fleet || sunkShips[shipId].length !== fleet.size) delete sunkShips[shipId];
    }

    for (const key of opponentFired) {
      const [r, c] = key.split(',').map(Number);
      if (p.grid[r][c] === null) misses.push(key);
    }

    return { ships: p.ships, hits, misses, sunkShips };
  });
}

// ── Placement ─────────────────────────────────────────────────────────────────

function handlePlace(ws, ships) {
  if (ws.sessionId === null) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'placement') return;

  const idx = ws.playerIndex;
  const player = session.players[idx];

  if (player.ships !== null) return send(ws, { type: 'bs_error', message: 'Already placed.' });

  if (!Array.isArray(ships) || ships.length !== FLEET.length) {
    return send(ws, { type: 'bs_error', message: 'Must place all 5 ships.' });
  }

  const grid = makeGrid();
  const providedIds = ships.map(s => s.id);
  const requiredIds = FLEET.map(f => f.id);
  for (const id of requiredIds) {
    if (!providedIds.includes(id)) {
      return send(ws, { type: 'bs_error', message: `Missing ship: ${id}` });
    }
  }

  for (const shipDef of ships) {
    const fleet = FLEET.find(f => f.id === shipDef.id);
    if (!fleet) return send(ws, { type: 'bs_error', message: `Unknown ship: ${shipDef.id}` });

    const { id, row, col, dir } = shipDef;
    if (typeof row !== 'number' || typeof col !== 'number') {
      return send(ws, { type: 'bs_error', message: 'Invalid ship coordinates.' });
    }
    if (dir !== 'h' && dir !== 'v') {
      return send(ws, { type: 'bs_error', message: 'Direction must be h or v.' });
    }

    const cells = getShipCells(row, col, dir, fleet.size);
    if (!cells) return send(ws, { type: 'bs_error', message: `Ship ${id} is out of bounds.` });

    for (const [r, c] of cells) {
      if (grid[r][c] !== null) {
        return send(ws, { type: 'bs_error', message: `Ship ${id} overlaps another ship.` });
      }
      grid[r][c] = id;
    }
  }

  player.ships = ships;
  player.grid = grid;

  const opponentIdx = 1 - idx;
  sendBoth(session, { type: 'bs_placed', playerIndex: idx });

  if (session.players[opponentIdx].ships !== null) {
    session.phase = 'battle';
    sendBoth(session, { type: 'bs_battle_start' });
    // Give observers the full grid state now that both players have placed
    sendObservers(session, {
      type: 'bs_observe_battle_start',
      playerNames: session.players.map(p => p.name),
      currentTurn: session.currentTurn,
      grids: buildObserveGridState(session),
    });
  }
}

function getShipCells(row, col, dir, size) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const r = dir === 'v' ? row + i : row;
    const c = dir === 'h' ? col + i : col;
    if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return null;
    cells.push([r, c]);
  }
  return cells;
}

// ── Battle ────────────────────────────────────────────────────────────────────

function handleFire(ws, row, col) {
  if (ws.sessionId === null) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'battle') return send(ws, { type: 'bs_error', message: 'Not in battle phase.' });

  const idx = ws.playerIndex;
  if (session.currentTurn !== idx) return send(ws, { type: 'bs_error', message: 'Not your turn.' });

  if (typeof row !== 'number' || typeof col !== 'number' ||
      row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) {
    return send(ws, { type: 'bs_error', message: 'Invalid coordinates.' });
  }

  const key = `${row},${col}`;
  const firedSet = session.players[idx].fired;
  if (firedSet.has(key)) return send(ws, { type: 'bs_error', message: 'Already fired there.' });
  firedSet.add(key);

  const opponentIdx = 1 - idx;
  const opponentPlayer = session.players[opponentIdx];
  const targetCell = opponentPlayer.grid[row][col];
  const hit = targetCell !== null;

  let sunk = null;
  let shipCells = null;

  if (hit) {
    opponentPlayer.grid[row][col] = `${targetCell}:hit`;

    const fleet = FLEET.find(f => f.id === targetCell);
    if (fleet) {
      const cells = getShipCellsFromGrid(opponentPlayer.grid, targetCell);
      const allHit = cells.every(([r, c]) => opponentPlayer.grid[r][c] === `${targetCell}:hit`);
      if (allHit) {
        sunk = targetCell;
        shipCells = cells;
      }
    }
  }

  let winner = null;
  if (sunk) {
    const allSunk = FLEET.every(f => {
      const cells = getShipCellsFromGrid(opponentPlayer.grid, f.id);
      return cells.every(([r, c]) => opponentPlayer.grid[r][c] === `${f.id}:hit`);
    });
    if (allSunk) winner = idx;
  }

  if (winner !== null) {
    session.phase = 'over';
  } else {
    if (!hit) session.currentTurn = opponentIdx;
  }

  sendAll(session, {
    type: 'bs_result',
    row,
    col,
    hit,
    sunk,
    shipId: targetCell,
    shipCells,
    currentTurn: session.currentTurn,
    shooter: idx,  // for observers: tells which player fired (target = 1 - shooter)
  });

  if (winner !== null) {
    session.rematchVotes.clear();
    sendAll(session, { type: 'bs_win', winner });
  }
}

function getShipCellsFromGrid(grid, shipId) {
  const cells = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      if (cell === shipId || cell === `${shipId}:hit`) {
        cells.push([r, c]);
      }
    }
  }
  return cells;
}

// ── Rematch ───────────────────────────────────────────────────────────────────

function handleRematch(ws) {
  if (ws.sessionId === null) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'over') return;

  session.rematchVotes.add(ws.playerIndex);
  sendAll(session, { type: 'bs_rematch_vote', votes: session.rematchVotes.size });

  if (session.rematchVotes.size >= 2) {
    resetSession(session);
    sendBoth(session, { type: 'bs_rematch_start' });
    // Observers stay connected — re-send them the fresh placement state
    sendObservers(session, {
      type: 'bs_observe_start',
      phase: 'placement',
      playerNames: session.players.map(p => p.name),
      currentTurn: 0,
      grids: buildObserveGridState(session),
    });
  }
}

function resetSession(session) {
  session.players.forEach(p => {
    p.ships = null;
    p.grid = makeGrid();
    p.fired = new Set();
  });
  session.phase = 'placement';
  session.currentTurn = 0;
  session.rematchVotes.clear();
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function handleChat(ws, text) {
  if (!ws.playerName || ws.sessionId === null) return;
  if (typeof text !== 'string') return;
  const clean = text.trim().slice(0, 200);
  if (!clean) return;
  const session = sessions.get(ws.sessionId);
  if (!session) return;
  // Observers cannot chat — only relay player messages
  if (ws.playerIndex === -1) return;
  sendAll(session, { type: 'bs_chat', name: ws.playerName, text: clean });
}

// ── Disconnect ────────────────────────────────────────────────────────────────

function handleDisconnect(ws) {
  if (ws.sessionId === null) return;
  const session = sessions.get(ws.sessionId);
  if (!session) return;

  if (ws.playerIndex === -1) {
    // Observer left — just remove them, game continues
    session.observers = session.observers.filter(o => o.ws !== ws);
    ws.sessionId = null;
    return;
  }

  // A player disconnected — notify everyone and end session
  session.players.forEach(p => {
    if (p.ws !== ws && p.ws.readyState === 1) {
      send(p.ws, { type: 'bs_opponent_disconnected' });
    }
  });
  sendObservers(session, { type: 'bs_opponent_disconnected' });

  sessions.delete(ws.sessionId);
  ws.sessionId = null;
}

function getSessionList() {
  const list = [];
  for (const [id, s] of sessions) {
    if (s.phase === 'over') continue;
    const host = s.players[0];
    const playerCount = s.players.length;
    list.push({
      id,
      hostName: host ? host.name : '?',
      players: playerCount,
      maxPlayers: 2,
      observers: s.observers.length,
      canJoin: playerCount === 1,
      canObserve: playerCount === 2,
      status: playerCount === 1 ? 'waiting' : 'playing',
      label: playerCount === 1 ? 'Waiting for opponent' : `${s.phase}`,
    });
  }
  return list;
}

module.exports = { wss, getSessionList };
