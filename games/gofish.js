const { WebSocketServer } = require('ws');

const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = ['♠','♥','♦','♣'];

let nextId = 1;
const sessions = new Map();
const wss = new WebSocketServer({ noServer: true });

function makeDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function bcast(session, obj) {
  session.players.forEach(p => send(p.ws, obj));
}

function pub(session) {
  return session.players.map(p => ({
    idx: p.idx, name: p.name, cardCount: p.hand.length, books: [...p.books]
  }));
}

function extractBooks(player) {
  const cnt = {};
  player.hand.forEach(c => { cnt[c.r] = (cnt[c.r] || 0) + 1; });
  const done = [];
  for (const [r, n] of Object.entries(cnt)) {
    if (n === 4) {
      player.hand = player.hand.filter(c => c.r !== r);
      player.books.push(r);
      done.push(r);
    }
  }
  return done;
}

wss.on('connection', ws => {
  ws.sid = null; ws.pidx = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join')  handleJoin(ws, m.name, m.sessionId);
    if (m.type === 'start') handleStart(ws);
    if (m.type === 'ask')   handleAsk(ws, +m.target, m.rank);
    if (m.type === 'chat')  handleChat(ws, m.text);
  });

  ws.on('close', () => handleDC(ws));
  ws.on('error', () => handleDC(ws));
});

function handleJoin(ws, name, sessionId) {
  if (!name || typeof name !== 'string') return;
  name = name.trim().slice(0, 24);
  if (!name) return;

  let sid, session;
  if (sessionId && sessions.has(+sessionId)) {
    sid = +sessionId;
    session = sessions.get(sid);
    if (session.started) return send(ws, { type: 'error', message: 'Game already in progress.' });
    if (session.players.length >= 4) return send(ws, { type: 'error', message: 'Session is full (max 4 players).' });
  } else {
    sid = nextId++;
    session = { id: sid, players: [], deck: [], started: false, gameOver: false, turn: 0 };
    sessions.set(sid, session);
  }

  const idx = session.players.length;
  session.players.push({ ws, name, idx, hand: [], books: [] });
  ws.sid = sid; ws.pidx = idx;

  send(ws, { type: 'joined', sessionId: sid, yourIdx: idx, hostIdx: 0, players: pub(session) });
  session.players.forEach((p, i) => {
    if (i !== idx) send(p.ws, { type: 'lobby_update', players: pub(session) });
  });
}

function handleStart(ws) {
  const session = sessions.get(ws.sid);
  if (!session || ws.pidx !== 0 || session.started) return;
  if (session.players.length < 2)
    return send(ws, { type: 'error', message: 'Need at least 2 players to start.' });

  session.started = true;
  session.deck = makeDeck();
  const deal = session.players.length === 2 ? 7 : 5;
  session.players.forEach(p => {
    p.hand = session.deck.splice(0, deal);
    p.books = [];
    extractBooks(p);
  });

  session.players.forEach(p => {
    send(p.ws, {
      type: 'start',
      yourHand: p.hand,
      players: pub(session),
      deckCount: session.deck.length,
      turn: 0
    });
  });
}

function handleAsk(ws, target, rank) {
  const session = sessions.get(ws.sid);
  if (!session || !session.started || session.gameOver) return;
  const askerIdx = ws.pidx;
  if (session.turn !== askerIdx) return;
  const a = session.players[askerIdx];
  const t = session.players[target];
  if (!t || target === askerIdx) return;
  if (!a.hand.some(c => c.r === rank)) return;

  bcast(session, { type: 'asked', asker: askerIdx, target, rank, askerName: a.name, targetName: t.name });

  const given = t.hand.filter(c => c.r === rank);
  if (given.length > 0) {
    t.hand = t.hand.filter(c => c.r !== rank);
    a.hand.push(...given);
    bcast(session, { type: 'card_transfer', asker: askerIdx, target, count: given.length });
    send(a.ws, { type: 'got_cards', cards: given, fromIdx: target, rank });
    send(t.ws, { type: 'hand_update', hand: t.hand });

    const books = extractBooks(a);
    send(a.ws, { type: 'hand_update', hand: a.hand });
    books.forEach(r => bcast(session, { type: 'book', playerIdx: askerIdx, rank: r }));

    advanceTurn(session, askerIdx, true);
  } else {
    let drawnCard = null;
    let lucky = false;
    if (session.deck.length > 0) {
      drawnCard = session.deck.shift();
      a.hand.push(drawnCard);
      send(a.ws, { type: 'drew', card: drawnCard });
      lucky = drawnCard.r === rank;
      if (lucky) bcast(session, { type: 'lucky', asker: askerIdx, rank });
      const books = extractBooks(a);
      send(a.ws, { type: 'hand_update', hand: a.hand });
      books.forEach(r => bcast(session, { type: 'book', playerIdx: askerIdx, rank: r }));
    }
    advanceTurn(session, askerIdx, lucky);
  }
}

function advanceTurn(session, askerIdx, anotherTurn) {
  bcast(session, { type: 'state', players: pub(session), deckCount: session.deck.length });

  const totalBooks = session.players.reduce((s, p) => s + p.books.length, 0);
  if (totalBooks === 13) {
    endGame(session);
    return;
  }

  let next;
  if (anotherTurn) {
    next = askerIdx;
  } else {
    next = (askerIdx + 1) % session.players.length;
    let tries = 0;
    while (session.players[next].hand.length === 0 && session.deck.length === 0
           && tries < session.players.length) {
      next = (next + 1) % session.players.length;
      tries++;
    }
    if (tries >= session.players.length) { endGame(session); return; }
  }

  // Replenish empty hand from deck
  const np = session.players[next];
  if (np.hand.length === 0 && session.deck.length > 0) {
    const drawn = session.deck.shift();
    np.hand.push(drawn);
    send(np.ws, { type: 'drew', card: drawn });
    send(np.ws, { type: 'hand_update', hand: np.hand });
    bcast(session, { type: 'state', players: pub(session), deckCount: session.deck.length });
  }

  session.turn = next;
  bcast(session, { type: 'turn', playerIdx: next });
}

function endGame(session) {
  session.gameOver = true;
  const scores = session.players
    .map(p => ({ name: p.name, idx: p.idx, books: p.books.length, bookRanks: [...p.books] }))
    .sort((a, b) => b.books - a.books);
  bcast(session, { type: 'game_over', scores });
}

function handleChat(ws, text) {
  const session = sessions.get(ws.sid);
  if (!session) return;
  const p = session.players[ws.pidx];
  if (!p) return;
  bcast(session, { type: 'chat', name: p.name, text: String(text).slice(0, 200) });
}

function handleDC(ws) {
  const session = sessions.get(ws.sid);
  if (!session) return;
  const p = session.players[ws.pidx];
  if (!p) return;
  if (!session.started) {
    session.players.splice(ws.pidx, 1);
    session.players.forEach((q, i) => { q.idx = i; if (q.ws) q.ws.pidx = i; });
    if (session.players.length === 0) { sessions.delete(session.id); return; }
    bcast(session, { type: 'lobby_update', players: pub(session) });
  } else {
    p.ws = null;
    bcast(session, { type: 'chat', name: '·', text: `${p.name} disconnected.` });
  }
}

function getSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.gameOver) continue;
    const host = session.players[0];
    const cur = session.players.length;
    list.push({
      id,
      hostName: host ? host.name : '?',
      players: cur,
      maxPlayers: 4,
      observers: 0,
      canJoin: !session.started && cur < 4,
      canObserve: false,
      status: session.started ? 'playing' : 'waiting',
      label: session.started ? 'In progress' : `${cur}/4 players`
    });
  }
  return list;
}

module.exports = { wss, getSessionList };
