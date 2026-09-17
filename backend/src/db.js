'use strict';

/**
 * db.js — SQLite database setup and helper functions
 *
 * Uses the built-in node:sqlite module (Node.js >= 22.5, no native addon).
 * Suppress the experimental warning with NODE_OPTIONS=--no-experimental-sqlite
 * or just let it print — it doesn't affect functionality.
 */

// Suppress experimental warning for cleaner logs
process.removeAllListeners('warning');

const { DatabaseSync } = require('node:sqlite');
const path             = require('path');
const fs               = require('fs');

// Store data.sqlite one level up from src/, or /tmp for serverless (Vercel)
const DB_PATH = process.env.VERCEL
  ? path.join('/tmp', 'data.sqlite')
  : path.join(__dirname, '..', 'data.sqlite');

let _db;

function getDb() {
  if (_db) return _db;

  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS permits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chainId       INTEGER NOT NULL,
      owner         TEXT    NOT NULL,
      token         TEXT    NOT NULL,
      tokenSymbol   TEXT,
      tokenDecimals INTEGER,
      amount        TEXT    NOT NULL,
      amountHuman   TEXT,
      spent         TEXT    NOT NULL DEFAULT '0',
      spentHuman    TEXT    NOT NULL DEFAULT '0',
      expiration    INTEGER NOT NULL,
      nonce         INTEGER NOT NULL,
      sigDeadline   TEXT    NOT NULL,
      spender       TEXT    NOT NULL,
      signature     TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      txHashes      TEXT    NOT NULL DEFAULT '[]',
      referredBy    TEXT,
      createdAt     INTEGER NOT NULL,
      updatedAt     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_permits_owner_token ON permits(owner, token);
    CREATE INDEX IF NOT EXISTS idx_permits_status      ON permits(status);
  `);

  try {
    _db.exec('ALTER TABLE permits ADD COLUMN referredBy TEXT');
  } catch (_) {}

  return _db;
}

/* ─────────────── Permit helpers ─────────────── */

function insertPermit(data) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO permits
      (chainId, owner, token, tokenSymbol, tokenDecimals,
       amount, amountHuman, spent, spentHuman,
       expiration, nonce, sigDeadline, spender, signature,
       status, txHashes, referredBy, createdAt, updatedAt)
    VALUES
      (@chainId, @owner, @token, @tokenSymbol, @tokenDecimals,
       @amount, @amountHuman, '0', '0',
       @expiration, @nonce, @sigDeadline, @spender, @signature,
       'pending', '[]', @referredBy, @createdAt, @updatedAt)
  `);

  const info = stmt.run({
    ...data,
    referredBy: data.referredBy || null,
    createdAt: now,
    updatedAt: now
  });

  return getPermitById(info.lastInsertRowid);
}

function getPermitById(id) {
  return getDb()
    .prepare('SELECT * FROM permits WHERE id = ?')
    .get(id);
}

function getAllPermits() {
  return getDb()
    .prepare('SELECT * FROM permits ORDER BY id DESC')
    .all();
}

function updatePermitAfterExecution(id, { rawSpent, spentHuman, status, txHash }) {
  const db   = getDb();
  const row  = getPermitById(id);
  if (!row) throw new Error(`Permit ${id} not found`);

  const hashes = JSON.parse(row.txHashes || '[]');
  if (txHash) hashes.push(txHash);

  db.prepare(`
    UPDATE permits
    SET spent = ?, spentHuman = ?, status = ?, txHashes = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    rawSpent.toString(),
    spentHuman,
    status,
    JSON.stringify(hashes),
    Math.floor(Date.now() / 1000),
    id
  );

  return getPermitById(id);
}

function markPermitStatus(id, status) {
  getDb().prepare(`
    UPDATE permits SET status = ?, updatedAt = ? WHERE id = ?
  `).run(status, Math.floor(Date.now() / 1000), id);
}

/* ─────────────── Nonce uniqueness check ─────────────── */

/**
 * Returns true if there is already a pending permit for
 * (owner, token) with the same nonce — prevents replay submissions.
 */
function hasPendingWithNonce(owner, token, nonce) {
  const row = getDb().prepare(`
    SELECT id FROM permits
    WHERE owner = ? AND token = ? AND nonce = ? AND status = 'pending'
    LIMIT 1
  `).get(owner.toLowerCase(), token.toLowerCase(), nonce);
  return !!row;
}

module.exports = {
  getDb,
  insertPermit,
  getPermitById,
  getAllPermits,
  updatePermitAfterExecution,
  markPermitStatus,
  hasPendingWithNonce
};
