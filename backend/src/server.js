'use strict';

/**
 * server.js — TokenGateway Backend
 *
 * Serves the REST API that bridges the frontend and TokenGateway contract.
 * Stack: Node.js 20 + Express + better-sqlite3 + ethers v6
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');

const publicRoutes = require('./routes/public');
const adminRoutes  = require('./routes/admin');

/* ─────────────── Env validation ─────────────── */

const REQUIRED_VARS = [
  'RPC_URL',
  'ADMIN_PRIVATE_KEY',
  'GATEWAY_ADDRESS',
  'ADMIN_API_KEY'
];

const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('❌  Missing required environment variables:', missing.join(', '));
  console.error('    Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

/* ─────────────── Express setup ─────────────── */

const app  = express();
const PORT = Number(process.env.PORT || 8787);

// CORS — open in dev; tighten in production
app.use(cors({ origin: '*' }));
app.use(express.json());

// Basic request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ─────────────── Routes ─────────────── */

app.use('/api', publicRoutes);
app.use('/api/super', adminRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Disable browser caching for development so user always sees latest code
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.startsWith('/ref') || req.path.startsWith('/super')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Super portal
app.get(['/super', '/super/'], (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'super.html'));
});

// Referral routes
app.get(['/ref', '/ref/*'], (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'index.html'));
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', '..', 'frontend'), { etag: false, maxAge: 0 }));

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ─────────────── Startup ─────────────── */

if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║       TokenGateway Backend  ⚡           ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Listening on  http://localhost:${PORT}  ║`);
    console.log(`║  Gateway       ${process.env.GATEWAY_ADDRESS?.slice(0,10)}…    ║`);
    console.log(`║  RPC           ${(process.env.RPC_URL || '').slice(0,30)}…  ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });
}

module.exports = app;
