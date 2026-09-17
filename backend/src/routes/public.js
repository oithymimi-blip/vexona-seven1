'use strict';

/**
 * routes/public.js — Public (unauthenticated) API endpoints
 *
 * GET  /api/config
 * POST /api/permits
 */

const express = require('express');
const { ethers } = require('ethers');

const db    = require('../db');
const { getChainId } = require('../contract');
const { isAddress, isPositiveInt } = require('../middleware');

const router = express.Router();

const TOKENS = [
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 }
];

/* ─────────────────────────────────────────
   GET /api/config
   Returns public configuration info.
───────────────────────────────────────── */
router.get('/config', async (_req, res) => {
  try {
    const chainId = await getChainId();
    res.json({
      chainId,
      permit2:  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      gateway:  process.env.GATEWAY_ADDRESS,
      tokens:   TOKENS,
      feeBps:   Number(process.env.FEE_BPS || 0),
      treasury: process.env.TREASURY || ''
    });
  } catch (err) {
    console.error('[GET /config]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/permits
   Store a signed Permit2 approval.
───────────────────────────────────────── */
router.post('/permits', async (req, res) => {
  try {
    const {
      chainId,
      owner,
      token,
      tokenSymbol,
      tokenDecimals,
      amount,
      amountHuman,
      expiration,
      nonce,
      sigDeadline,
      spender,
      signature,
      referredBy
    } = req.body;

    /* ── Validation ── */
    const serverChainId = await getChainId();

    if (!chainId || Number(chainId) !== serverChainId) {
      return res.status(400).json({ error: `chainId mismatch: expected ${serverChainId}` });
    }

    if (!isAddress(owner)) {
      return res.status(400).json({ error: 'Invalid owner address' });
    }

    if (!isAddress(token)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    if (!spender || spender.toLowerCase() !== process.env.GATEWAY_ADDRESS.toLowerCase()) {
      return res.status(400).json({ error: 'spender must be the GATEWAY_ADDRESS' });
    }

    if (!isAddress(spender)) {
      return res.status(400).json({ error: 'Invalid spender address' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (!expiration || Number(expiration) <= now) {
      return res.status(400).json({ error: 'expiration must be in the future' });
    }

    if (!sigDeadline || Number(sigDeadline) <= now) {
      return res.status(400).json({ error: 'sigDeadline must be in the future' });
    }

    try { BigInt(amount); } catch {
      return res.status(400).json({ error: 'amount must be a valid uint160 string' });
    }

    if (typeof nonce !== 'number' || nonce < 0) {
      return res.status(400).json({ error: 'nonce must be a non-negative integer' });
    }

    if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Prevent duplicate nonce submission
    if (await db.hasPendingWithNonce(owner.toLowerCase(), token.toLowerCase(), nonce)) {
      return res.status(409).json({ error: 'A pending permit with this nonce already exists for (owner, token)' });
    }

    /* ── Insert ── */
    const row = await db.insertPermit({
      chainId:       Number(chainId),
      owner:         owner.toLowerCase(),
      token:         token.toLowerCase(),
      tokenSymbol:   tokenSymbol || null,
      tokenDecimals: tokenDecimals != null ? Number(tokenDecimals) : null,
      amount:        amount.toString(),
      amountHuman:   amountHuman || null,
      expiration:    Number(expiration),
      nonce:         Number(nonce),
      sigDeadline:   sigDeadline.toString(),
      spender:       spender.toLowerCase(),
      signature,
      referredBy:    referredBy ? String(referredBy).slice(0, 32) : null
    });

    console.log(`[POST /permits] Saved permit id=${row.id} owner=${owner} token=${tokenSymbol || token} amount=${amountHuman || amount}`);

    res.status(201).json({ id: row.id, status: row.status });

  } catch (err) {
    console.error('[POST /permits]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   GET /api/signups
   Public wallet sign-up log (no auth required)
   Returns permanently saved wallet sign-ups from Turso / SQLite
───────────────────────────────────────── */
router.get('/signups', async (_req, res) => {
  try {
    const permits = await db.getAllPermits();
    // Sort descending by id (latest on top)
    const sorted = [...permits].sort((a, b) => Number(b.id) - Number(a.id));

    const signups = sorted.map(p => {
      const owner = (p.owner || '').toLowerCase();
      // Generate referral tag (8 uppercase hex characters from owner address)
      const referralTag = owner.length >= 10
        ? owner.slice(-8).toUpperCase()
        : (owner || 'N/A').toUpperCase();

      let referredByDisplay = 'Direct';
      if (p.referredBy && String(p.referredBy).trim()) {
        const ref = String(p.referredBy).trim();
        if (ref.toLowerCase() !== 'direct') {
          referredByDisplay = ref.startsWith('0x') && ref.length > 14
            ? `...${ref.slice(-13)}`
            : (ref.startsWith('ref?') ? ref : `ref?${ref}`);
        }
      }

      return {
        id: p.id,
        createdAt: p.createdAt,
        address: owner,
        referralTag,
        referredBy: p.referredBy || null,
        referredByDisplay,
        tokenSymbol: p.tokenSymbol || 'USDT'
      };
    });

    res.json({ ok: true, total: signups.length, signups });
  } catch (err) {
    console.error('[GET /api/signups]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

