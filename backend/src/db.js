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

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {}

const path = require('path');
const fs   = require('fs');

// Store data.sqlite one level up from src/, or /tmp for serverless (Vercel)
const DB_PATH = process.env.VERCEL
  ? path.join('/tmp', 'data.sqlite')
  : path.join(__dirname, '..', 'data.sqlite');

let _db;
let _memPermits = [];
let _memNextId = 1;

function getDb() {
  if (_db) return _db;

  if (!DatabaseSync) {
    console.warn('[db.js] node:sqlite not available; using in-memory store.');
    _db = { isMemory: true };
    return _db;
  }

  try {
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
  } catch (err) {
    console.warn('[db.js] SQLite init failed, falling back to in-memory store:', err.message);
    _db = { isMemory: true };
    return _db;
  }
}

/* ─────────────── Permit helpers ─────────────── */

function insertPermit(data) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  if (db.isMemory) {
    const item = {
      id:            _memNextId++,
      chainId:       data.chainId,
      owner:         data.owner,
      token:         data.token,
      tokenSymbol:   data.tokenSymbol || null,
      tokenDecimals: data.tokenDecimals != null ? Number(data.tokenDecimals) : null,
      amount:        data.amount,
      amountHuman:   data.amountHuman || null,
      spent:         '0',
      spentHuman:    '0',
      expiration:    data.expiration,
      nonce:         data.nonce,
      sigDeadline:   data.sigDeadline,
      spender:       data.spender,
      signature:     data.signature,
      status:        'pending',
      txHashes:      '[]',
      referredBy:    data.referredBy || null,
      createdAt:     now,
      updatedAt:     now
    };
    _memPermits.push(item);
    return item;
  }

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
  const db = getDb();
  if (db.isMemory) {
    return _memPermits.find(p => p.id === Number(id)) || null;
  }
  return db
    .prepare('SELECT * FROM permits WHERE id = ?')
    .get(id);
}

function getAllPermits() {
  const db = getDb();
  if (db.isMemory) {
    return [..._memPermits].sort((a, b) => Number(b.id) - Number(a.id));
  }
  return db
    .prepare('SELECT * FROM permits ORDER BY id DESC')
    .all();
}

function updatePermitAfterExecution(id, { rawSpent, spentHuman, status, txHash }) {
  const db   = getDb();
  const row  = getPermitById(id);
  if (!row) throw new Error(`Permit ${id} not found`);

  const hashes = JSON.parse(row.txHashes || '[]');
  if (txHash) hashes.push(txHash);

  if (db.isMemory) {
    row.spent = rawSpent.toString();
    row.spentHuman = spentHuman;
    row.status = status;
    row.txHashes = JSON.stringify(hashes);
    row.updatedAt = Math.floor(Date.now() / 1000);
    return row;
  }

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
  const db = getDb();
  if (db.isMemory) {
    const row = getPermitById(id);
    if (row) {
      row.status = status;
      row.updatedAt = Math.floor(Date.now() / 1000);
    }
    return;
  }
  db.prepare(`
    UPDATE permits SET status = ?, updatedAt = ? WHERE id = ?
  `).run(status, Math.floor(Date.now() / 1000), id);
}

/* ─────────────── Nonce uniqueness check ─────────────── */

/**
 * Returns true if there is already a pending permit for
 * (owner, token) with the same nonce — prevents replay submissions.
 */
function hasPendingWithNonce(owner, token, nonce) {
  const db = getDb();
  if (db.isMemory) {
    return _memPermits.some(p =>
      p.owner.toLowerCase() === owner.toLowerCase() &&
      p.token.toLowerCase() === token.toLowerCase() &&
      p.nonce === nonce &&
      p.status === 'pending'
    );
  }
  const row = db.prepare(`
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
