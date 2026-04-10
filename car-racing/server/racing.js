'use strict';

// Multiplayer racing: matchmaking + state relay.
//
// The server doesn't simulate physics. Each client simulates its own car
// locally against a deterministic terrain (same seed -> same hills), and
// publishes its position at ~20Hz. The server relays snapshots to everyone
// else in the match and calls the race when players cross the finish line.

const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });

// ── Tunables ─────────────────────────────────────────────────────────────────
const MIN_PLAYERS      = 2;
const MAX_PLAYERS      = 4;
const LOBBY_COUNTDOWN  = 5_000;   // ms after MIN_PLAYERS reached before auto-start
const TRACK_LENGTH     = 3500;    // world units to the finish line
const BROADCAST_TICK   = 50;      // ms between state broadcasts (~20Hz)
const RACE_TIMEOUT     = 180_000; // 3 min wall-clock cap per race

const CAR_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00'];

// ── State ────────────────────────────────────────────────────────────────────
let nextMatchId  = 1;
let nextPlayerId = 1;
const matches    = new Map(); // id -> match
let openMatch    = null;      // the currently-filling lobby

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(match, obj) {
  const payload = JSON.stringify(obj);
  for (const p of match.players) {
    if (p.ws.readyState === 1) p.ws.send(payload);
  }
}

function makeSeed() {
  // 32-bit non-zero seed. Shared by server + clients to generate the same track.
  return (Math.floor(Math.random() * 0xffffffff) + 1) >>> 0;
}

function createMatch() {
  const m = {
    id:            nextMatchId++,
    state:         'lobby',        // 'lobby' | 'racing' | 'finished'
    players:       [],
    seed:          makeSeed(),
    trackLength:   TRACK_LENGTH,
    countdownAt:   0,              // timestamp when countdown should fire
    countdownT:    null,
    startTime:     0,
    finishOrder:   [],             // [{id, name, finishMs}]
    broadcastT:    null,
    timeoutT:      null,
  };
  matches.set(m.id, m);
  return m;
}

function cleanupMatch(m) {
  if (m.countdownT) clearTimeout(m.countdownT);
  if (m.broadcastT) clearInterval(m.broadcastT);
  if (m.timeoutT)   clearTimeout(m.timeoutT);
  matches.delete(m.id);
  if (openMatch === m) openMatch = null;
}

function lobbySnapshot(m) {
  return {
    type: 'lobby',
    matchId: m.id,
    trackLength: m.trackLength,
    seed: m.seed,
    players: m.players.map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready,
    })),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    state: m.state,
  };
}

function assignColor(match) {
  const used = new Set(match.players.map(p => p.color));
  return CAR_COLORS.find(c => !used.has(c)) || CAR_COLORS[0];
}

// ── Lobby flow ───────────────────────────────────────────────────────────────
function maybeStartCountdown(m) {
  if (m.state !== 'lobby') return;
  if (m.players.length < MIN_PLAYERS) {
    if (m.countdownT) { clearTimeout(m.countdownT); m.countdownT = null; m.countdownAt = 0; }
    broadcast(m, { type: 'countdown_cancel' });
    return;
  }
  if (m.countdownT) return; // already running

  m.countdownAt = Date.now() + LOBBY_COUNTDOWN;
  broadcast(m, { type: 'countdown', endsAt: m.countdownAt });
  m.countdownT = setTimeout(() => startRace(m), LOBBY_COUNTDOWN);
}

function startRace(m) {
  if (m.state !== 'lobby') return;
  if (m.players.length < 1) { cleanupMatch(m); return; }

  m.state = 'racing';
  m.startTime = Date.now() + 1500; // small delay for 3-2-1 on the client
  m.countdownT = null;

  if (openMatch === m) openMatch = null;

  broadcast(m, {
    type: 'start',
    matchId: m.id,
    seed: m.seed,
    trackLength: m.trackLength,
    startTime: m.startTime,
    players: m.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
  });

  // Fixed-rate relay of player positions.
  m.broadcastT = setInterval(() => relayWorld(m), BROADCAST_TICK);

  // Hard cap on race duration.
  m.timeoutT = setTimeout(() => endRace(m, 'timeout'), RACE_TIMEOUT);
}

function relayWorld(m) {
  if (m.state !== 'racing') return;
  broadcast(m, {
    type: 'world',
    t: Date.now(),
    players: m.players.map(p => ({
      id:       p.id,
      x:        p.x,
      y:        p.y,
      rot:      p.rot,
      wheelRot: p.wheelRot,
      finished: p.finished,
      dist:     p.x, // distance along track == x
    })),
  });
}

function endRace(m, reason) {
  if (m.state === 'finished') return;
  m.state = 'finished';
  if (m.broadcastT) { clearInterval(m.broadcastT); m.broadcastT = null; }
  if (m.timeoutT)   { clearTimeout(m.timeoutT);    m.timeoutT   = null; }

  // Anyone not finished gets ranked by distance traveled.
  const unfinished = m.players
    .filter(p => !m.finishOrder.find(f => f.id === p.id))
    .sort((a, b) => b.x - a.x)
    .map(p => ({ id: p.id, name: p.name, finishMs: null, distance: p.x }));

  const rankings = [
    ...m.finishOrder.map((f, i) => ({ ...f, place: i + 1 })),
    ...unfinished.map((u, i) => ({ ...u, place: m.finishOrder.length + i + 1 })),
  ];

  broadcast(m, { type: 'finish', reason, rankings });

  // Give clients a moment to display results, then dispose.
  setTimeout(() => cleanupMatch(m), 30_000);
}

// ── Connection handling ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  let match = null;
  let me    = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      // ── join matchmaking ──────────────────────────────────────────────
      case 'join': {
        if (match) return;
        const name = String(msg.name || '').trim().slice(0, 24) || `Driver ${nextPlayerId}`;

        if (!openMatch || openMatch.players.length >= MAX_PLAYERS || openMatch.state !== 'lobby') {
          openMatch = createMatch();
        }
        match = openMatch;

        me = {
          ws,
          id:       nextPlayerId++,
          name,
          color:    assignColor(match),
          ready:    false,
          x:        0,
          y:        0,
          rot:      0,
          wheelRot: 0,
          finished: false,
          lastSeen: Date.now(),
        };
        match.players.push(me);

        send(ws, { type: 'joined', you: { id: me.id, color: me.color } });
        broadcast(match, lobbySnapshot(match));

        if (match.players.length >= MAX_PLAYERS) {
          openMatch = null;
          // Full lobby: skip remaining countdown and start immediately.
          if (match.countdownT) { clearTimeout(match.countdownT); match.countdownT = null; }
          startRace(match);
        } else if (match.players.length >= MIN_PLAYERS) {
          maybeStartCountdown(match);
        }
        break;
      }

      // ── ready-up in lobby (optional UX; not required to start) ────────
      case 'ready': {
        if (!match || !me || match.state !== 'lobby') return;
        me.ready = !!msg.ready;
        broadcast(match, lobbySnapshot(match));
        if (me.ready && match.players.length >= MIN_PLAYERS &&
            match.players.every(p => p.ready)) {
          if (match.countdownT) { clearTimeout(match.countdownT); match.countdownT = null; }
          startRace(match);
        }
        break;
      }

      // ── periodic position update from a client ────────────────────────
      case 'state': {
        if (!match || !me || match.state !== 'racing' || me.finished) return;
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
        me.x        = msg.x;
        me.y        = msg.y;
        me.rot      = Number(msg.rot) || 0;
        me.wheelRot = Number(msg.wheelRot) || 0;
        me.lastSeen = Date.now();
        break;
      }

      // ── client reports crossing the finish line ───────────────────────
      case 'finished': {
        if (!match || !me || match.state !== 'racing' || me.finished) return;
        me.finished = true;
        const finishMs = Date.now() - match.startTime;
        match.finishOrder.push({ id: me.id, name: me.name, finishMs });

        broadcast(match, {
          type: 'player_finished',
          playerId: me.id,
          name: me.name,
          finishMs,
          place: match.finishOrder.length,
        });

        if (match.finishOrder.length >= match.players.length) {
          endRace(match, 'all_finished');
        }
        break;
      }

      // ── player-to-player chat in the lobby or mid-race ────────────────
      case 'chat': {
        if (!match || !me) return;
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        broadcast(match, { type: 'chat', from: me.name, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!match || !me) return;

    match.players = match.players.filter(p => p !== me);
    broadcast(match, { type: 'player_left', playerId: me.id, name: me.name });

    if (match.state === 'lobby') {
      if (match.players.length === 0) {
        cleanupMatch(match);
      } else {
        broadcast(match, lobbySnapshot(match));
        if (match.players.length < MIN_PLAYERS && match.countdownT) {
          clearTimeout(match.countdownT);
          match.countdownT = null;
          match.countdownAt = 0;
          broadcast(match, { type: 'countdown_cancel' });
        }
      }
    } else if (match.state === 'racing') {
      if (match.players.length === 0 ||
          match.players.every(p => p.finished)) {
        endRace(match, 'abandoned');
      }
    }
  });
});

function listMatches() {
  const out = [];
  for (const m of matches.values()) {
    out.push({
      id: m.id,
      state: m.state,
      players: m.players.length,
      maxPlayers: MAX_PLAYERS,
    });
  }
  return out;
}

module.exports = { wss, listMatches };
