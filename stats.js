'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'playcounts.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function increment(game) {
  const counts = load();
  counts[game] = (counts[game] || 0) + 1;
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(counts, null, 2));
  } catch (e) { console.error('stats write error:', e.message); }
}

function getAll() {
  return load();
}

module.exports = { increment, getAll };
