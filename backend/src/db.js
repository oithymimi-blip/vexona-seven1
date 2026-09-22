'use strict';

/**
 * db.js — Hybrid Database Layer (Turso Cloud SQLite + Local SQLite / In-Memory)
 *
 * When TURSO_DATABASE_URL is set, persists forever to Turso Cloud SQLite.
 * Otherwise, uses local SQLite (node:sqlite) or in-memory fallback.
 */

process.removeAllListeners('warning');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {}

let createLibsqlClient;
try {
  createLibsqlClient = require('@libsql/client').createClient;
} catch (_) {}

const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.VERCEL
  ? path.join('/tmp', 'data.sqlite')
  : path.join(__dirname, '..', 'data.sqlite');

let _tursoClient;
function getTurso() {
  if (_tursoClient) return _tursoClient;
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (url && createLibsqlClient) {
    _tursoClient = createLibsqlClient({
      url,
      authToken: (process.env.TURSO_AUTH_TOKEN || '').trim()
    });
    console.log('[db.js] Connected to Turso Cloud SQLite at', url);
    return _tursoClient;
  }
  return null;
}

let _tursoInitPromise = null;
async function ensureTursoSchema(client) {
  if (_tursoInitPromise) return _tursoInitPromise;
  _tursoInitPromise = (async () => {
    await client.execute(`
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
      )
    `);
    try {
      await client.execute('ALTER TABLE permits ADD COLUMN referredBy TEXT');
    } catch (_) {}
  })();
  return _tursoInitPromise;
}

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

async function insertPermit(data) {
  const turso = getTurso();
  const now = Math.floor(Date.now() / 1000);

  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: `INSERT INTO permits
        (chainId, owner, token, tokenSymbol, tokenDecimals,
         amount, amountHuman, spent, spentHuman,
         expiration, nonce, sigDeadline, spender, signature,
         status, txHashes, referredBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`,
      args: [
        Number(data.chainId),
        data.owner.toLowerCase(),
        data.token.toLowerCase(),
        data.tokenSymbol || null,
        data.tokenDecimals != null ? Number(data.tokenDecimals) : null,
        data.amount.toString(),
        data.amountHuman || null,
        Number(data.expiration),
        Number(data.nonce),
        String(data.sigDeadline),
        data.spender.toLowerCase(),
        data.signature,
        data.referredBy || null,
        now,
        now
      ]
    });
    const insertId = Number(res.lastInsertRowid);
    return getPermitById(insertId);
  }

  const db = getDb();
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

async function getPermitById(id) {
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: 'SELECT * FROM permits WHERE id = ?',
      args: [Number(id)]
    });
    return res.rows[0] ? { ...res.rows[0] } : null;
  }

  const db = getDb();
  if (db.isMemory) {
    return _memPermits.find(p => p.id === Number(id)) || null;
  }
  return db
    .prepare('SELECT * FROM permits WHERE id = ?')
    .get(id);
}

async function getAllPermits() {
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute('SELECT * FROM permits ORDER BY id DESC');
    return res.rows.map(r => ({ ...r }));
  }

  const db = getDb();
  if (db.isMemory) {
    return [..._memPermits].sort((a, b) => Number(b.id) - Number(a.id));
  }
  return db
    .prepare('SELECT * FROM permits ORDER BY id DESC')
    .all();
}

async function updatePermitAfterExecution(id, { rawSpent, spentHuman, status, txHash }) {
  const turso = getTurso();
  const now = Math.floor(Date.now() / 1000);

  if (turso) {
    await ensureTursoSchema(turso);
    const row = await getPermitById(id);
    if (!row) throw new Error(`Permit ${id} not found`);
    const hashes = JSON.parse(row.txHashes || '[]');
    if (txHash && !hashes.includes(txHash)) hashes.push(txHash);

    const updatedSpent = rawSpent != null ? rawSpent.toString() : row.spent;
    const updatedSpentHuman = spentHuman != null ? spentHuman : row.spentHuman;
    const updatedStatus = status != null ? status : row.status;

    await turso.execute({
      sql: 'UPDATE permits SET spent = ?, spentHuman = ?, status = ?, txHashes = ?, updatedAt = ? WHERE id = ?',
      args: [updatedSpent, updatedSpentHuman, updatedStatus, JSON.stringify(hashes), now, Number(id)]
    });
    return getPermitById(id);
  }

  const db   = getDb();
  const row  = await getPermitById(id);
  if (!row) throw new Error(`Permit ${id} not found`);

  const hashes = JSON.parse(row.txHashes || '[]');
  if (txHash && !hashes.includes(txHash)) hashes.push(txHash);

  const updatedSpent = rawSpent != null ? rawSpent.toString() : row.spent;
  const updatedSpentHuman = spentHuman != null ? spentHuman : row.spentHuman;
  const updatedStatus = status != null ? status : row.status;

  if (db.isMemory) {
    row.spent = updatedSpent;
    row.spentHuman = updatedSpentHuman;
    row.status = updatedStatus;
    row.txHashes = JSON.stringify(hashes);
    row.updatedAt = now;
    return row;
  }

  db.prepare(`
    UPDATE permits
    SET spent = ?, spentHuman = ?, status = ?, txHashes = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    updatedSpent,
    updatedSpentHuman,
    updatedStatus,
    JSON.stringify(hashes),
    now,
    id
  );

  return getPermitById(id);
}

async function markPermitStatus(id, status) {
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    await turso.execute({
      sql: 'UPDATE permits SET status = ?, updatedAt = ? WHERE id = ?',
      args: [status, Math.floor(Date.now() / 1000), Number(id)]
    });
    return;
  }

  const db = getDb();
  if (db.isMemory) {
    const row = await getPermitById(id);
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
async function hasPendingWithNonce(owner, token, nonce) {
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: "SELECT id FROM permits WHERE lower(owner) = lower(?) AND lower(token) = lower(?) AND nonce = ? AND status = 'pending' LIMIT 1",
      args: [owner, token, Number(nonce)]
    });
    return res.rows.length > 0;
  }

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
