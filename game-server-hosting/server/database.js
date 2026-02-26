/**
 * database.js
 * SQLite database layer using better-sqlite3 (synchronous API).
 * Manages game server records — creation, updates, queries.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store DB file alongside the servers folder
const DB_DIR = path.join(__dirname, '..', 'servers');
const DB_PATH = path.join(DB_DIR, 'servers.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    game        TEXT NOT NULL DEFAULT 'minecraft',
    ram         TEXT NOT NULL DEFAULT '2G',
    port        INTEGER NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'stopped',
    container_id TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Statements ──────────────────────────────────────────────────────────────

const stmts = {
  insert: db.prepare(`
    INSERT INTO servers (id, name, game, ram, port, status)
    VALUES (@id, @name, @game, @ram, @port, @status)
  `),

  findAll: db.prepare(`SELECT * FROM servers ORDER BY created_at DESC`),

  findById: db.prepare(`SELECT * FROM servers WHERE id = ?`),

  updateStatus: db.prepare(`
    UPDATE servers
    SET status = @status, container_id = @container_id, updated_at = datetime('now')
    WHERE id = @id
  `),

  updateStatusOnly: db.prepare(`
    UPDATE servers
    SET status = @status, updated_at = datetime('now')
    WHERE id = @id
  `),

  delete: db.prepare(`DELETE FROM servers WHERE id = ?`),

  maxPort: db.prepare(`SELECT MAX(port) as max_port FROM servers`),
};

// ─── Port allocation ──────────────────────────────────────────────────────────

const BASE_PORT = 25565;

function getNextPort() {
  const row = stmts.maxPort.get();
  if (!row || row.max_port === null) return BASE_PORT;
  return row.max_port + 1;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function createServer({ id, name, game, ram }) {
  const port = getNextPort();
  stmts.insert.run({ id, name, game: game.toLowerCase(), ram, port, status: 'stopped' });
  return stmts.findById.get(id);
}

function getAllServers() {
  return stmts.findAll.all();
}

function getServerById(id) {
  return stmts.findById.get(id);
}

function updateServerStatus(id, status, containerId = null) {
  if (containerId !== null) {
    stmts.updateStatus.run({ id, status, container_id: containerId });
  } else {
    stmts.updateStatusOnly.run({ id, status });
  }
  return stmts.findById.get(id);
}

function deleteServer(id) {
  stmts.delete.run(id);
}

module.exports = {
  createServer,
  getAllServers,
  getServerById,
  updateServerStatus,
  deleteServer,
};
