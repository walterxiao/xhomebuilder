'use strict';
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

const WINS = [
  [0,1,2],[3,4,5],[6,7,8], // rows
  [0,3,6],[1,4,7],[2,5,8], // cols
  [0,4,8],[2,4,6],          // diags
];

function checkWinner(board) {
  for (const [a, b, c] of WINS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a], line: [a, b, c] };
  }
  if (board.every(c => c)) return { winner: 'draw', line: null };
  return null;
}

let nextId = 3000;
const sessions = new Map();

function getSessionList() {
  return [...sessions.values()]
    .filter(s => s.state === 'waiting' && s.players.length < 2)
    .map(s => ({
      id: s.id,
      hostName: s.players[0]?.name || '?',
      players: s.players.length,
      canJoin: true,
      status: `${s.players.length}/2`,
    }));
}

function bcast(session, msg) {
  const data = JSON.stringify(msg);
  for (const p of session.players) if (p.ws.readyState === 1) p.ws.send(data);
}

function freshBoard() { return Array(9).fill(null); }

wss.on('connection', ws => {
  let session = null, player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Player').slice(0, 24);
      if (msg.sessionId) {
        session = sessions.get(+msg.sessionId);
        if (!session || session.state !== 'waiting' || session.players.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Game not available.' }));
          return;
        }
      } else {
        session = { id: nextId++, state: 'waiting', players: [], board: freshBoard(), turn: 0, rematchVotes: new Set() };
        sessions.set(session.id, session);
      }
      player = { ws, name, idx: session.players.length };
      session.players.push(player);
      ws.send(JSON.stringify({
        type: 'joined', sessionId: session.id, yourIdx: player.idx,
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      }));
      bcast(session, {
        type: 'lobby_update',
        players: session.players.map(p => ({ idx: p.idx, name: p.name })),
      });
      // Auto-start when 2 players join
      if (session.players.length === 2) {
        session.state = 'playing';
        session.board = freshBoard();
        session.turn = 0;
        session.rematchVotes = new Set();
        bcast(session, {
          type: 'start',
          players: session.players.map(p => ({ idx: p.idx, name: p.name })),
          turn: session.turn,
        });
      }
      return;
    }

    if (msg.type === 'move') {
      if (!session || !player || session.state !== 'playing') return;
      if (session.turn !== player.idx) return;
      const cell = +msg.cell;
      if (cell < 0 || cell > 8 || session.board[cell]) return;

      session.board[cell] = player.idx === 0 ? 'X' : 'O';
      session.turn = 1 - session.turn;

      const result = checkWinner(session.board);
      bcast(session, {
        type: 'move',
        cell,
        mark: session.board[cell],
        turn: session.turn,
      });

      if (result) {
        session.state = 'done';
        bcast(session, {
          type: 'game_over',
          winner: result.winner,
          line: result.line,
          winnerName: result.winner === 'draw' ? null
            : session.players[result.winner === 'X' ? 0 : 1]?.name,
        });
      }
      return;
    }

    if (msg.type === 'rematch') {
      if (!session || !player) return;
      session.rematchVotes.add(player.idx);
      bcast(session, { type: 'rematch_vote', votes: session.rematchVotes.size });
      if (session.rematchVotes.size >= 2) {
        session.board = freshBoard();
        // Swap who goes first
        session.turn = session.turn === 0 ? 1 : 0;
        session.state = 'playing';
        session.rematchVotes = new Set();
        bcast(session, {
          type: 'start',
          players: session.players.map(p => ({ idx: p.idx, name: p.name })),
          turn: session.turn,
        });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!session || !player) return;
    session.players = session.players.filter(p => p !== player);
    if (!session.players.length) { sessions.delete(session.id); return; }
    bcast(session, { type: 'player_left', playerIdx: player.idx, name: player.name });
    session.state = 'waiting';
  });
});

module.exports = { wss, getSessionList };
