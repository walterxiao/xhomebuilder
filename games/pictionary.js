'use strict';

const { WebSocketServer } = require('ws');

const WORD_CATEGORIES = {
  Animals: [
    'Cat','Dog','Fish','Bird','Horse','Elephant','Giraffe','Lion','Tiger','Bear',
    'Rabbit','Frog','Snake','Turtle','Butterfly','Bee','Spider','Crab','Duck','Penguin',
    'Owl','Pig','Cow','Shark','Whale','Dolphin','Octopus','Kangaroo','Panda','Koala',
    'Parrot','Eagle','Flamingo','Zebra','Crocodile','Gorilla','Monkey','Fox','Wolf','Deer',
    'Squirrel','Bat','Jellyfish','Lobster','Hedgehog','Camel','Peacock','Seal','Mouse','Hippo',
  ],
  Foods: [
    'Pizza','Sushi','Burger','Pasta','Taco','Waffle','Pancake','Salad','Steak','Soup',
    'Donut','Cookie','Cake','Sandwich','Noodle','Rice','Egg','Cheese','Bread','Popcorn',
    'Hot Dog','Ice Cream','Chocolate','Candy','Apple','Banana','Strawberry','Watermelon',
    'Mango','Orange','Grape','Pineapple','Peach','Lemon','Cherry','Coconut','Avocado',
    'Carrot','Broccoli','Mushroom','Dumpling','Burrito','Croissant','Pretzel','Pudding',
  ],
  Vehicles: [
    'Car','Truck','Bus','Bicycle','Motorcycle','Airplane','Helicopter','Boat','Ship',
    'Train','Submarine','Rocket','Skateboard','Scooter','Tractor','Tank','Hot Air Balloon',
    'Ambulance','Fire Truck','Race Car','Sailboat','Canoe','Yacht','Spaceship','Jeep',
    'Van','Pickup Truck','Ferry','Cable Car','Hovercraft','Snowplow','Forklift',
  ],
  Sports: [
    'Soccer','Basketball','Tennis','Swimming','Baseball','Golf','Volleyball','Boxing',
    'Skiing','Surfing','Running','Cycling','Gymnastics','Archery','Fishing','Karate',
    'Wrestling','Ice Skating','Rowing','Climbing','Rugby','Cricket','Badminton',
    'Table Tennis','Bowling','Fencing','Diving','Snowboarding','Skateboarding','Polo',
    'Weightlifting','Triathlon','Judo',
  ],
  Nature: [
    'Mountain','River','Ocean','Forest','Desert','Waterfall','Volcano','Rainbow',
    'Cloud','Lightning','Snow','Rain','Cave','Island','Beach','Cliff','Valley',
    'Glacier','Tornado','Sunset','Moon','Star','Sun','Tree','Flower','Grass',
    'Leaf','Rock','Sand','Mud','Swamp','Meadow','Coral Reef','Iceberg',
  ],
  Household: [
    'Chair','Table','Lamp','Door','Window','Bed','Sofa','Fridge','Oven','Sink',
    'Mirror','Clock','Telephone','Computer','Television','Pillow','Blanket','Carpet',
    'Bookshelf','Bathtub','Toilet','Stairs','Drawer','Cabinet','Fan','Microwave',
    'Kettle','Cup','Fork','Spoon','Broom','Candle','Vase','Umbrella',
  ],
  Clothing: [
    'Shirt','Pants','Hat','Shoes','Dress','Jacket','Socks','Scarf','Gloves','Boots',
    'Tie','Belt','Skirt','Shorts','Coat','Swimsuit','Sunglasses','Backpack','Watch',
    'Ring','Necklace','Earring','Sneakers','Sandals','Jeans','Sweater','Hoodie',
    'Vest','Cap','Mittens','Toga','Tuxedo','Kimono',
  ],
  Professions: [
    'Doctor','Teacher','Chef','Firefighter','Police Officer','Pilot','Farmer','Dentist',
    'Nurse','Engineer','Scientist','Artist','Musician','Plumber','Electrician','Lawyer',
    'Astronaut','Carpenter','Sailor','Baker','Butcher','Journalist','Photographer',
    'Librarian','Magician','Clown','Judge','Soldier','Archaeologist','Lifeguard',
  ],
};

const CATEGORY_NAMES = Object.keys(WORD_CATEGORIES);
const ALL_WORDS = [].concat(...Object.values(WORD_CATEGORIES));

const sessions = new Map();
let nextSessionId = 1;

const wss = new WebSocketServer({ noServer: true });

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(session, obj) {
  if (session.painter) send(session.painter.ws, obj);
  for (const g of session.guessers) {
    send(g.ws, obj);
  }
}

function broadcastExcept(session, excludeWs, obj) {
  if (session.painter && session.painter.ws !== excludeWs) {
    send(session.painter.ws, obj);
  }
  for (const g of session.guessers) {
    if (g.ws !== excludeWs) send(g.ws, obj);
  }
}

function lobbyPlayers(session) {
  const players = [];
  if (session.painter) {
    players.push({ name: session.painter.name, role: 'painter' });
  }
  for (const g of session.guessers) {
    players.push({ name: g.name, role: 'guesser' });
  }
  return players;
}

function handleListSessions(ws) {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.phase === 'lobby' || session.phase === 'playing') {
      list.push({
        id,
        painterName: session.painter ? session.painter.name : '',
        guesserCount: session.guessers.length,
        phase: session.phase
      });
    }
  }
  send(ws, { type: 'pic_sessions_list', sessions: list });
}

function getSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    if (session.phase === 'lobby' || session.phase === 'playing') {
      const host = session.painter;
      const playerCount = (session.painter ? 1 : 0) + session.guessers.length;
      list.push({
        id,
        hostName: host ? host.name : '?',
        players: playerCount,
        maxPlayers: 99,
        observers: 0,
        canJoin: session.phase === 'lobby',
        canObserve: session.phase === 'playing',
        status: session.phase,
        label: session.phase === 'lobby' ? `${playerCount} players joined` : 'Drawing in progress'
      });
    }
  }
  return list;
}

function handleCreate(ws, name) {
  if (ws.picSessionId !== null) return;
  if (typeof name !== 'string') return;
  name = name.trim().slice(0, 24);
  if (!name) return;

  const sessionId = nextSessionId++;
  const session = {
    phase: 'lobby',
    painter: { ws, name },
    guessers: [],
    category: null,
    animals: [],
    answer: null,
    timer: null,
    drawLog: [],
    playAgainVotes: new Set(),
    lastPainterName: null,
  };
  sessions.set(sessionId, session);

  ws.picSessionId = sessionId;
  ws.picRole = 'painter';
  ws.picName = name;
  ws.picStatus = null;

  send(ws, {
    type: 'pic_lobby',
    sessionId,
    role: 'painter',
    players: lobbyPlayers(session)
  });
}

function handleJoin(ws, sessionId, name) {
  if (ws.picSessionId !== null) return;
  if (typeof name !== 'string') return;
  name = name.trim().slice(0, 24);
  if (!name) return;

  const session = sessions.get(sessionId);
  if (!session) {
    send(ws, { type: 'pic_error', message: 'Session not found.' });
    return;
  }
  if (session.phase !== 'lobby') {
    send(ws, { type: 'pic_error', message: 'Game has already started.' });
    return;
  }

  session.guessers.push({ ws, name, status: 'guessing', guessesLeft: 3 });

  ws.picSessionId = sessionId;
  ws.picRole = 'guesser';
  ws.picName = name;
  ws.picStatus = 'guessing';

  send(ws, {
    type: 'pic_lobby',
    sessionId,
    role: 'guesser',
    players: lobbyPlayers(session)
  });

  broadcast(session, { type: 'pic_lobby_update', players: lobbyPlayers(session) });
}

function handleStart(ws) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session || session.phase !== 'lobby') return;
  if (!session.painter || session.painter.ws !== ws) return;

  // Collect all connected players
  const allPlayers = getAllPlayers(session).filter(p => p.ws.readyState === 1);
  if (allPlayers.length < 2) {
    send(ws, { type: 'pic_error', message: 'Need at least 1 other player to start.' });
    return;
  }

  startNextGame(session, sessionId);
}

// Shared logic: pick a new random painter (excluding last), deal a word, begin choosing phase
function startNextGame(session, sessionId) {
  const allPlayers = getAllPlayers(session).filter(p => p.ws.readyState === 1);
  if (allPlayers.length < 2) return false;

  // Rotate painter in join order: find last painter's position, take the next one
  const lastIdx = allPlayers.findIndex(p => p.name === session.lastPainterName);
  const nextIdx = lastIdx < 0 ? 0 : (lastIdx + 1) % allPlayers.length;
  const newPainter = allPlayers[nextIdx];
  const newGuessers = allPlayers.filter(p => p !== newPainter);

  // Reassign roles
  session.painter = { ws: newPainter.ws, name: newPainter.name };
  session.guessers = newGuessers.map(p => ({ ws: p.ws, name: p.name, status: 'guessing', guessesLeft: 3 }));
  session.lastPainterName = newPainter.name;

  newPainter.ws.picRole = 'painter';
  newPainter.ws.picStatus = null;
  for (const g of session.guessers) {
    g.ws.picRole = 'guesser';
    g.ws.picStatus = 'guessing';
  }

  // Pick answer from a random category; pick 9 decoys from the full word pool
  const category = CATEGORY_NAMES[Math.floor(Math.random() * CATEGORY_NAMES.length)];
  const categoryWords = WORD_CATEGORIES[category];
  const defaultAnswer = categoryWords[Math.floor(Math.random() * categoryWords.length)];

  const decoys = ALL_WORDS
    .filter(w => w !== defaultAnswer)
    .sort(() => Math.random() - 0.5)
    .slice(0, 9);
  const animals = [defaultAnswer, ...decoys].sort(() => Math.random() - 0.5);

  session.category = category;
  session.animals = animals;
  session.answer = defaultAnswer;
  session.phase = 'choosing';
  session.drawLog = [];

  // Painter picks their word; guessers wait
  send(session.painter.ws, {
    type: 'pic_choose_word',
    defaultWord: defaultAnswer,
    category,
  });

  for (const g of session.guessers) {
    send(g.ws, { type: 'pic_waiting_word', painterName: session.painter.name });
  }

  return true;
}

function handleContinue(ws) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session || session.phase !== 'over') return;
  // Mark as starting immediately to prevent double-clicks
  session.phase = 'starting';
  if (session.timer) { clearInterval(session.timer); session.timer = null; }
  session.playAgainVotes.clear();
  startNextGame(session, sessionId);
}

function handleConfirmWord(ws, word) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session || session.phase !== 'choosing') return;
  if (!session.painter || session.painter.ws !== ws) return;

  let finalWord = typeof word === 'string' ? word.trim().slice(0, 30) : '';
  if (!finalWord) finalWord = session.answer; // fall back to default

  if (finalWord !== session.answer) {
    // Custom word: rebuild 9 decoys from full pool (excluding the custom word)
    const decoys = ALL_WORDS
      .filter(w => w !== finalWord)
      .sort(() => Math.random() - 0.5)
      .slice(0, 9);
    session.animals = [finalWord, ...decoys].sort(() => Math.random() - 0.5);
  }
  session.answer = finalWord;
  session.phase = 'playing';

  let remaining = 300;
  session.timer = setInterval(() => {
    remaining--;
    broadcast(session, { type: 'pic_tick', remaining });
    if (remaining <= 0) endGame(sessionId, null);
  }, 1000);

  send(session.painter.ws, {
    type: 'pic_start_game',
    role: 'painter',
    answer: finalWord,
    duration: 300,
  });

  for (const g of session.guessers) {
    send(g.ws, {
      type: 'pic_start_game',
      role: 'guesser',
      animals: session.animals,
      duration: 300,
      painterName: session.painter.name,
    });
  }
}

function handleDraw(ws, msg) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.painter || session.painter.ws !== ws) return;
  if (session.phase !== 'playing') return;

  const event = {
    type: 'pic_draw',
    x0: msg.x0,
    y0: msg.y0,
    x1: msg.x1,
    y1: msg.y1,
    color: msg.color,
    lineWidth: msg.lineWidth
  };

  broadcastExcept(session, ws, event);

  if (session.drawLog.length < 5000) {
    session.drawLog.push(event);
  }
}

function handleClear(ws) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.painter || session.painter.ws !== ws) return;
  if (session.phase !== 'playing') return;

  broadcastExcept(session, ws, { type: 'pic_clear' });
  session.drawLog = [];
}

function handleGuess(ws, animal) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.phase !== 'playing') return;
  if (ws.picRole !== 'guesser') return;
  if (ws.picStatus !== 'guessing') return;

  const correct = animal.trim().toLowerCase() === session.answer.toLowerCase();

  if (correct) {
    ws.picStatus = 'correct';
    const guesser = session.guessers.find(g => g.ws === ws);
    if (guesser) guesser.status = 'correct';
    broadcast(session, { type: 'pic_guess_result', name: ws.picName, animal, correct: true, eliminated: false, guessesLeft: 0 });
    endGame(sessionId, ws.picName);
    return;
  }

  // Wrong guess — decrement attempts
  const guesser = session.guessers.find(g => g.ws === ws);
  if (guesser) guesser.guessesLeft = Math.max(0, (guesser.guessesLeft ?? 3) - 1);
  const guessesLeft = guesser ? guesser.guessesLeft : 0;
  const eliminated = guessesLeft <= 0;

  if (eliminated) {
    ws.picStatus = 'wrong';
    if (guesser) guesser.status = 'wrong';
  }

  broadcast(session, { type: 'pic_guess_result', name: ws.picName, animal, correct: false, eliminated, guessesLeft });

  if (eliminated) {
    const allDone = session.guessers.every(g => g.status !== 'guessing');
    if (allDone) endGame(sessionId, null);
  }
}

function endGame(sessionId, winner) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.phase === 'over') return;

  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }

  session.phase = 'over';

  const results = session.guessers.map(g => ({ name: g.name, status: g.status }));

  broadcast(session, {
    type: 'pic_over',
    answer: session.answer,
    winner: winner || null,
    results
  });
}

// ── Players helper ────────────────────────────────────────────────────────────

function getAllPlayers(session) {
  const all = [];
  if (session.painter) all.push(session.painter);
  for (const g of session.guessers) all.push(g);
  return all;
}

function _unused_startRematch(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.timer) { clearInterval(session.timer); session.timer = null; }

  const connected = getAllPlayers(session).filter(p => p.ws.readyState === 1);
  if (connected.length < 2) return;

  // Pick random painter, excluding last game's painter
  const eligible = connected.filter(p => p.name !== session.lastPainterName);
  const pool = eligible.length > 0 ? eligible : connected;
  const newPainter = pool[Math.floor(Math.random() * pool.length)];
  const newGuessers = connected.filter(p => p !== newPainter);

  // Reset session
  session.phase = 'lobby';
  session.animals = [];
  session.answer = null;
  session.drawLog = [];
  session.playAgainVotes.clear();
  session.lastPainterName = newPainter.name;
  session.painter = { ws: newPainter.ws, name: newPainter.name };
  session.guessers = newGuessers.map(p => ({ ws: p.ws, name: p.name, status: 'guessing', guessesLeft: 3 }));

  // Update ws properties
  newPainter.ws.picRole = 'painter';
  newPainter.ws.picStatus = null;
  for (const g of session.guessers) {
    g.ws.picRole = 'guesser';
    g.ws.picStatus = 'guessing';
  }

  const players = lobbyPlayers(session);
  send(session.painter.ws, { type: 'pic_lobby', sessionId, role: 'painter', players });
  for (const g of session.guessers) {
    send(g.ws, { type: 'pic_lobby', sessionId, role: 'guesser', players });
  }
}

function handleChat(ws, text) {
  if (!ws.picName) return;
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.phase !== 'lobby' && session.phase !== 'choosing' && session.phase !== 'playing') return;

  if (typeof text !== 'string') return;
  text = text.trim().slice(0, 200);
  if (!text) return;

  broadcast(session, { type: 'pic_chat', name: ws.picName, text });
}

function handleDisconnect(ws) {
  const sessionId = ws.picSessionId;
  if (sessionId === null) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  const leavingName = ws.picName;

  if (session.painter && session.painter.ws === ws) {
    session.painter = null;
  } else {
    session.guessers = session.guessers.filter(g => g.ws !== ws);
  }

  const hasPainter = !!session.painter;
  const hasGuessers = session.guessers.length > 0;

  if (!hasPainter || !hasGuessers) {
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
    // Notify remaining players before deletion
    broadcast(session, { type: 'pic_player_left', name: leavingName });
    sessions.delete(sessionId);
  } else {
    broadcast(session, { type: 'pic_player_left', name: leavingName });
  }
}

wss.on('connection', (ws) => {
  ws.picSessionId = null;
  ws.picRole = null;
  ws.picName = null;
  ws.picStatus = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'pic_sessions':   handleListSessions(ws); break;
      case 'pic_create':     handleCreate(ws, msg.name); break;
      case 'pic_join':       handleJoin(ws, msg.sessionId, msg.name); break;
      case 'pic_start':        handleStart(ws); break;
      case 'pic_confirm_word': handleConfirmWord(ws, msg.word); break;
      case 'pic_draw':       handleDraw(ws, msg); break;
      case 'pic_clear':      handleClear(ws); break;
      case 'pic_guess':      handleGuess(ws, msg.animal); break;
      case 'pic_chat':       handleChat(ws, msg.text); break;
      case 'pic_continue':   handleContinue(ws); break;
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

module.exports = { wss, getSessionList };
