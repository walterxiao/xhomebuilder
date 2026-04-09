'use strict';
const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ noServer: true });

let nextSessionId = 1;
const sessions = new Map();

// ── Board setup ───────────────────────────────────────────────────────────────

function makeBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  // Black back rank (row 0 = rank 8)
  const backRank = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { piece: backRank[c], color: 'b' };
    b[1][c] = { piece: 'P', color: 'b' };
    b[6][c] = { piece: 'P', color: 'w' };
    b[7][c] = { piece: backRank[c], color: 'w' };
  }
  return b;
}

function cloneBoard(board) {
  return board.map(row => row.map(cell => cell ? { ...cell } : null));
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// Convert [row,col] to algebraic like "e2"
function toAlg(r, c) {
  return String.fromCharCode(97 + c) + String(8 - r);
}

// ── Move generation ───────────────────────────────────────────────────────────

// Returns pseudo-legal destinations for a piece (ignores check).
// Does NOT handle castling or en passant here; those are handled in getLegalMoves.
function getPseudoMoves(board, r, c) {
  const cell = board[r][c];
  if (!cell) return [];
  const { piece, color } = cell;
  const moves = [];
  const enemy = color === 'w' ? 'b' : 'w';

  function push(nr, nc) {
    if (!inBounds(nr, nc)) return false;
    const target = board[nr][nc];
    if (target && target.color === color) return false; // blocked by own piece
    moves.push([nr, nc]);
    return !target; // can continue sliding if square was empty
  }

  function slide(dr, dc) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const target = board[nr][nc];
      if (target && target.color === color) break;
      moves.push([nr, nc]);
      if (target) break; // captured, stop
      nr += dr; nc += dc;
    }
  }

  switch (piece) {
    case 'P': {
      const dir = color === 'w' ? -1 : 1;
      const startRow = color === 'w' ? 6 : 1;
      // Forward 1
      if (inBounds(r + dir, c) && !board[r + dir][c]) {
        moves.push([r + dir, c]);
        // Forward 2 from start
        if (r === startRow && !board[r + 2 * dir][c]) {
          moves.push([r + 2 * dir, c]);
        }
      }
      // Captures
      for (const dc of [-1, 1]) {
        const nr = r + dir, nc = c + dc;
        if (inBounds(nr, nc) && board[nr][nc] && board[nr][nc].color === enemy) {
          moves.push([nr, nc]);
        }
      }
      break;
    }
    case 'N': {
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        push(r + dr, c + dc);
      }
      break;
    }
    case 'B': {
      for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) slide(dr, dc);
      break;
    }
    case 'R': {
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) slide(dr, dc);
      break;
    }
    case 'Q': {
      for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) slide(dr, dc);
      break;
    }
    case 'K': {
      for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
        push(r + dr, c + dc);
      }
      break;
    }
  }
  return moves;
}

// Check if a color's king is in check on a given board
function isInCheck(board, color) {
  // Find king
  let kr = -1, kc = -1;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (cell && cell.piece === 'K' && cell.color === color) {
        kr = r; kc = c;
      }
    }
  }
  if (kr === -1) return true; // shouldn't happen

  const enemy = color === 'w' ? 'b' : 'w';
  // Check if any enemy piece attacks the king's square
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (!cell || cell.color !== enemy) continue;
      const moves = getPseudoMoves(board, r, c);
      if (moves.some(([mr, mc]) => mr === kr && mc === kc)) return true;
    }
  }
  return false;
}

// Apply a move to a board clone (does not validate)
// Returns new board, or null if invalid
function applyMove(board, from, to, promotion, enPassantTarget) {
  const [fr, fc] = from;
  const [tr, tc] = to;
  const b = cloneBoard(board);
  const piece = b[fr][fc];
  if (!piece) return null;

  // En passant capture
  if (piece.piece === 'P' && enPassantTarget &&
      tr === enPassantTarget[0] && tc === enPassantTarget[1]) {
    // Remove the captured pawn
    const capturedRow = piece.color === 'w' ? tr + 1 : tr - 1;
    b[capturedRow][tc] = null;
  }

  b[tr][tc] = { ...piece };
  b[fr][fc] = null;

  // Promotion
  if (piece.piece === 'P' && (tr === 0 || tr === 7)) {
    const promo = promotion ? promotion.toUpperCase() : 'Q';
    b[tr][tc] = { piece: promo, color: piece.color };
  }

  return b;
}

// Get all legal moves for a color, respecting check
// Returns array of { from, to, special } where special can be 'castle-k', 'castle-q', 'ep', 'promo-X'
function getLegalMoves(board, color, castlingRights, enPassantTarget) {
  const moves = [];
  const enemy = color === 'w' ? 'b' : 'w';

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = board[r][c];
      if (!cell || cell.color !== color) continue;

      let dests = getPseudoMoves(board, r, c);

      // Add en passant for pawns
      if (cell.piece === 'P' && enPassantTarget) {
        const dir = color === 'w' ? -1 : 1;
        const [epr, epc] = enPassantTarget;
        if (r + dir === epr && Math.abs(c - epc) === 1) {
          dests.push([epr, epc]);
        }
      }

      for (const [tr, tc] of dests) {
        const nb = applyMove(board, [r, c], [tr, tc], 'Q', enPassantTarget);
        if (!nb) continue;
        if (!isInCheck(nb, color)) {
          moves.push({ from: [r, c], to: [tr, tc] });
        }
      }
    }
  }

  // Castling
  const backRow = color === 'w' ? 7 : 0;
  const rights = castlingRights[color];

  if (!isInCheck(board, color)) {
    // Kingside
    if (rights.k) {
      if (!board[backRow][5] && !board[backRow][6]) {
        // e1/e8 already checked (not in check), check f and g
        const b1 = applyMove(board, [backRow, 4], [backRow, 5], null, null);
        const b2 = applyMove(board, [backRow, 4], [backRow, 6], null, null);
        if (b1 && !isInCheck(b1, color) && b2 && !isInCheck(b2, color)) {
          moves.push({ from: [backRow, 4], to: [backRow, 6], special: 'castle-k' });
        }
      }
    }
    // Queenside
    if (rights.q) {
      if (!board[backRow][3] && !board[backRow][2] && !board[backRow][1]) {
        const b1 = applyMove(board, [backRow, 4], [backRow, 3], null, null);
        const b2 = applyMove(board, [backRow, 4], [backRow, 2], null, null);
        if (b1 && !isInCheck(b1, color) && b2 && !isInCheck(b2, color)) {
          moves.push({ from: [backRow, 4], to: [backRow, 2], special: 'castle-q' });
        }
      }
    }
  }

  return moves;
}

// Check if a specific move is legal (returns the matched legal move or null)
function findLegalMove(board, color, castlingRights, enPassantTarget, from, to) {
  const moves = getLegalMoves(board, color, castlingRights, enPassantTarget);
  return moves.find(m => m.from[0] === from[0] && m.from[1] === from[1] &&
                         m.to[0] === to[0] && m.to[1] === to[1]) || null;
}

// Apply a fully-validated move, updating castling rights, en passant, etc.
// Returns { board, castlingRights, enPassantTarget, notation }
function applyFullMove(session, from, to, promotion) {
  const board = session.board;
  const color = session.turn;
  const [fr, fc] = from;
  const [tr, tc] = to;
  const piece = board[fr][fc];

  const legalMove = findLegalMove(board, color, session.castlingRights, session.enPassantTarget, from, to);
  if (!legalMove) return null;

  let newBoard = cloneBoard(board);
  const newCastling = {
    w: { k: session.castlingRights.w.k, q: session.castlingRights.w.q },
    b: { k: session.castlingRights.b.k, q: session.castlingRights.b.q },
  };
  let newEP = null;
  let notation = `${toAlg(fr, fc)}-${toAlg(tr, tc)}`;

  const isEP = piece.piece === 'P' && session.enPassantTarget &&
               tr === session.enPassantTarget[0] && tc === session.enPassantTarget[1];

  // Handle castling
  if (legalMove.special === 'castle-k') {
    const row = color === 'w' ? 7 : 0;
    newBoard[row][6] = { piece: 'K', color };
    newBoard[row][5] = { piece: 'R', color };
    newBoard[row][4] = null;
    newBoard[row][7] = null;
    newCastling[color].k = false;
    newCastling[color].q = false;
    notation = 'O-O';
  } else if (legalMove.special === 'castle-q') {
    const row = color === 'w' ? 7 : 0;
    newBoard[row][2] = { piece: 'K', color };
    newBoard[row][3] = { piece: 'R', color };
    newBoard[row][4] = null;
    newBoard[row][0] = null;
    newCastling[color].k = false;
    newCastling[color].q = false;
    notation = 'O-O-O';
  } else {
    // En passant capture
    if (isEP) {
      const capturedRow = color === 'w' ? tr + 1 : tr - 1;
      newBoard[capturedRow][tc] = null;
    }

    newBoard[tr][tc] = { ...piece };
    newBoard[fr][fc] = null;

    // Promotion
    if (piece.piece === 'P' && (tr === 0 || tr === 7)) {
      const promo = (promotion || 'q').toUpperCase();
      const validPromos = ['Q', 'R', 'B', 'N'];
      const p = validPromos.includes(promo) ? promo : 'Q';
      newBoard[tr][tc] = { piece: p, color };
      notation += `=${p}`;
    }

    // En passant target: pawn double push
    if (piece.piece === 'P' && Math.abs(tr - fr) === 2) {
      newEP = [(fr + tr) / 2, tc];
    }

    // Update castling rights
    if (piece.piece === 'K') {
      newCastling[color].k = false;
      newCastling[color].q = false;
    }
    if (piece.piece === 'R') {
      if (fc === 7) newCastling[color].k = false;
      if (fc === 0) newCastling[color].q = false;
    }
    // If a rook is captured, revoke rights
    if (tr === 7 && tc === 7) newCastling.w.k = false;
    if (tr === 7 && tc === 0) newCastling.w.q = false;
    if (tr === 0 && tc === 7) newCastling.b.k = false;
    if (tr === 0 && tc === 0) newCastling.b.q = false;
  }

  return { board: newBoard, castlingRights: newCastling, enPassantTarget: newEP, notation, legalMove };
}

// ── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.sessionId = null;
  ws.chessColor = null;
  ws.chessName = null;
  ws.isObserver = false;
  ws.observingSessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'chess_create':      handleCreate(ws, msg.name); break;
      case 'chess_join':        handleJoin(ws, msg.name, msg.sessionId); break;
      case 'chess_move':        handleMove(ws, msg.from, msg.to, msg.promotion); break;
      case 'chess_resign':      handleResign(ws); break;
      case 'chess_rematch':     handleRematch(ws); break;
      case 'chess_sessions':    handleSessions(ws); break;
      case 'chess_observe':     handleObserve(ws, msg.sessionId); break;
      case 'chess_chat':        handleChat(ws, msg.text); break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
  session.observers.forEach(o => send(o.ws, obj));
}

function handleCreate(ws, name) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'chess_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'chess_error', message: 'Please enter a name.' });

  ws.chessName = cleanName;

  const sessionId = nextSessionId++;
  const board = makeBoard();
  const session = {
    players: [
      { ws, name: cleanName, color: 'w' },
    ],
    observers: [],
    board,
    turn: 'w',
    phase: 'waiting',
    castlingRights: { w: { k: true, q: true }, b: { k: true, q: true } },
    enPassantTarget: null,
    result: null,
    resultReason: null,
    moveHistory: [],
    rematchVotes: new Set(),
  };
  sessions.set(sessionId, session);

  ws.sessionId = sessionId;
  ws.chessColor = 'w';

  send(ws, { type: 'chess_waiting', sessionId });
}

function handleJoin(ws, name, sessionId) {
  if (!name || typeof name !== 'string') return send(ws, { type: 'chess_error', message: 'Invalid name.' });
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) return send(ws, { type: 'chess_error', message: 'Please enter a name.' });

  const session = sessions.get(sessionId);
  if (!session) return send(ws, { type: 'chess_error', message: 'Session not found.' });
  if (session.phase !== 'waiting') return send(ws, { type: 'chess_error', message: 'Session is not available.' });

  ws.chessName = cleanName;

  const host = session.players[0];
  session.players.push({ ws, name: cleanName, color: 'b' });

  ws.sessionId = sessionId;
  ws.chessColor = 'b';

  session.phase = 'playing';
  const { board } = session;

  send(host.ws, { type: 'chess_start', myColor: 'w', opponentName: cleanName, board, turn: 'w' });
  send(ws,      { type: 'chess_start', myColor: 'b', opponentName: host.name, board, turn: 'w' });
}

function handleMove(ws, from, to, promotion) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'playing') return;
  if (session.turn !== ws.chessColor) return send(ws, { type: 'chess_error', message: 'Not your turn.' });

  if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) {
    return send(ws, { type: 'chess_error', message: 'Invalid move format.' });
  }
  const [fr, fc] = from.map(Number);
  const [tr, tc] = to.map(Number);
  if (!inBounds(fr, fc) || !inBounds(tr, tc)) return send(ws, { type: 'chess_error', message: 'Out of bounds.' });

  const cell = session.board[fr][fc];
  if (!cell || cell.color !== ws.chessColor) return send(ws, { type: 'chess_error', message: 'Not your piece.' });

  const result = applyFullMove(session, [fr, fc], [tr, tc], promotion);
  if (!result) return send(ws, { type: 'chess_error', message: 'Illegal move.' });

  session.board = result.board;
  session.castlingRights = result.castlingRights;
  session.enPassantTarget = result.enPassantTarget;
  session.moveHistory.push(result.notation);

  const opponent = session.turn === 'w' ? 'b' : 'w';
  session.turn = opponent;

  // Check for check, checkmate, stalemate
  const opponentInCheck = isInCheck(session.board, opponent);
  const opponentMoves = getLegalMoves(session.board, opponent, session.castlingRights, session.enPassantTarget);

  if (opponentMoves.length === 0) {
    if (opponentInCheck) {
      // Checkmate
      endGame(session, ws.chessColor, 'checkmate');
    } else {
      // Stalemate
      endGame(session, 'draw', 'stalemate');
    }
    return;
  }

  broadcast(session, {
    type: 'chess_update',
    board: session.board,
    turn: session.turn,
    lastMove: { from: [fr, fc], to: [tr, tc] },
    check: opponentInCheck,
    moveHistory: session.moveHistory,
  });
}

function endGame(session, result, reason) {
  session.phase = 'over';
  session.result = result;
  session.resultReason = reason;
  session.rematchVotes.clear();

  broadcast(session, {
    type: 'chess_over',
    result,
    reason,
    board: session.board,
    moveHistory: session.moveHistory,
  });
}

function handleResign(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'playing') return;

  const winner = ws.chessColor === 'w' ? 'b' : 'w';
  endGame(session, winner, 'resignation');
}

function handleRematch(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session || session.phase !== 'over') return;

  session.rematchVotes.add(ws.chessColor);
  broadcast(session, { type: 'chess_rematch_vote', votes: session.rematchVotes.size });

  if (session.rematchVotes.size >= 2) {
    // Swap colors
    session.players.forEach(p => {
      p.color = p.color === 'w' ? 'b' : 'w';
      p.ws.chessColor = p.color;
    });

    session.board = makeBoard();
    session.turn = 'w';
    session.phase = 'playing';
    session.castlingRights = { w: { k: true, q: true }, b: { k: true, q: true } };
    session.enPassantTarget = null;
    session.result = null;
    session.resultReason = null;
    session.moveHistory = [];
    session.rematchVotes.clear();

    session.players.forEach(p => {
      const opponent = session.players.find(q => q.ws !== p.ws);
      send(p.ws, {
        type: 'chess_rematch_start',
        myColor: p.color,
        opponentName: opponent ? opponent.name : '',
        board: session.board,
        turn: 'w',
      });
    });

    session.observers.forEach(o => {
      send(o.ws, {
        type: 'chess_observe_start',
        board: session.board,
        turn: 'w',
        playerNames: { w: session.players.find(p => p.color === 'w')?.name || '', b: session.players.find(p => p.color === 'b')?.name || '' },
        phase: 'playing',
        result: null,
        resultReason: null,
        moveHistory: [],
      });
    });
  }
}

function handleSessions(ws) {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.phase === 'playing') {
      const wPlayer = session.players.find(p => p.color === 'w');
      const bPlayer = session.players.find(p => p.color === 'b');
      list.push({
        id,
        wName: wPlayer ? wPlayer.name : '',
        bName: bPlayer ? bPlayer.name : '',
        moves: session.moveHistory.length,
      });
    }
  }
  send(ws, { type: 'chess_sessions_list', sessions: list });
}

function handleObserve(ws, sessionId) {
  const id = Number(sessionId);
  const session = sessions.get(id);
  if (!session) return send(ws, { type: 'chess_error', message: 'Game not found.' });
  if (session.phase === 'waiting') return send(ws, { type: 'chess_error', message: 'Game not started yet.' });

  ws.isObserver = true;
  ws.observingSessionId = id;
  session.observers.push({ ws });

  const wPlayer = session.players.find(p => p.color === 'w');
  const bPlayer = session.players.find(p => p.color === 'b');

  send(ws, {
    type: 'chess_observe_start',
    board: session.board,
    turn: session.turn,
    playerNames: {
      w: wPlayer ? wPlayer.name : '',
      b: bPlayer ? bPlayer.name : '',
    },
    phase: session.phase,
    result: session.result,
    resultReason: session.resultReason,
    moveHistory: session.moveHistory,
  });
}

function handleChat(ws, text) {
  if (typeof text !== 'string') return;
  const clean = text.trim().slice(0, 200);
  if (!clean) return;

  const name = ws.chessName || 'Observer';
  let session = null;

  if (ws.isObserver) {
    session = sessions.get(ws.observingSessionId);
  } else if (ws.sessionId) {
    session = sessions.get(ws.sessionId);
  }

  if (!session) return;
  broadcast(session, { type: 'chess_chat', name, text: clean });
}

function handleDisconnect(ws) {
  if (ws.isObserver) {
    const session = sessions.get(ws.observingSessionId);
    if (session) {
      session.observers = session.observers.filter(o => o.ws !== ws);
    }
    return;
  }

  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session) return;

  if (session.phase === 'playing') {
    session.players.forEach(p => {
      if (p.ws !== ws) send(p.ws, { type: 'chess_opponent_disconnected' });
    });
    session.observers.forEach(o => send(o.ws, { type: 'chess_opponent_disconnected' }));
    session.phase = 'over';
  }

  sessions.delete(ws.sessionId);
  ws.sessionId = null;
}

function getSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.phase === 'over') continue;
    const host = session.players.find(p => p.color === 'w');
    const playerCount = session.players.length;
    list.push({
      id,
      hostName: host ? host.name : '?',
      players: playerCount,
      maxPlayers: 2,
      observers: session.observers.length,
      canJoin: playerCount === 1,
      canObserve: playerCount === 2,
      status: playerCount === 1 ? 'waiting' : 'playing',
      label: playerCount === 1 ? 'Waiting for opponent' : `${session.moveHistory.length} moves`,
    });
  }
  return list;
}

module.exports = { wss, getSessionList };
