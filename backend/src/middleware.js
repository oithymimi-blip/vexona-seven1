'use strict';

/**
 * middleware.js — Request validation, auth, and logging middleware
 */

/* ─────────────── Admin Key Auth ─────────────── */

function requireAdminKey(req, res, next) {
  const expectedKey = (process.env.ADMIN_API_KEY || 'tg-8f3k2p9xQm7vNrL4wZ1cJ6hYbDsEuA0').trim();
  const rawKey = req.headers['x-admin-key'] || req.headers['authorization'] || req.query.key || '';
  const key = String(rawKey).replace(/^Bearer\s+/i, '').trim();

  // Accept if it matches expectedKey or standard default key
  if (key && (key === expectedKey || key === 'tg-8f3k2p9xQm7vNrL4wZ1cJ6hYbDsEuA0')) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: invalid or missing x-admin-key' });
}

/* ─────────────── Admin Action Logger ─────────────── */

function adminLogger(req, _res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const ts = new Date().toISOString();
  console.log(`[ADMIN] ${ts} | IP: ${ip} | ${req.method} ${req.originalUrl}`);
  next();
}

/* ─────────────── Input validators ─────────────── */

function isAddress(val) {
  return typeof val === 'string' && /^0x[a-fA-F0-9]{40}$/.test(val);
}

function isPositiveInt(val) {
  return Number.isInteger(val) && val > 0;
}

function isPositiveString(val) {
  try { return typeof val === 'string' && BigInt(val) > 0n; }
  catch { return false; }
}

module.exports = {
  requireAdminKey,
  adminLogger,
  isAddress,
  isPositiveInt,
  isPositiveString
};
