'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');

function log(event, data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    }) + '\n';
    const file = path.join(LOG_DIR, new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.appendFileSync(file, line);
  } catch (e) {
    console.error('logger error:', e.message);
  }
}

module.exports = { log };
