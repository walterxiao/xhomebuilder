'use strict';
// Go is a client-side single-player vs AI game.
// This module only exists for server routing + stats tracking.
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', ws => { ws.on('message', () => {}); });
function getSessionList() { return []; }
module.exports = { wss, getSessionList };
