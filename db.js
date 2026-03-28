const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB || 'gamehub';

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

let db = null;

async function connect() {
  if (db) return db;
  await client.connect();
  db = client.db(dbName);
  console.log(`MongoDB connected: ${uri}/${dbName}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB not connected');
  return db;
}

function collection(name) {
  return getDb().collection(name);
}

module.exports = {
  connect,
  getDb,
  collection,
};
