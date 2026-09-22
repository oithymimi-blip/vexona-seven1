'use strict';

/**
 * routes/admin.js — Admin (authenticated) API endpoints
 *
 * GET  /api/admin/status
 * GET  /api/admin/permits
 * POST /api/admin/permits/:id/execute
 * POST /api/admin/settings/paused
 * POST /api/admin/settings/fee
 * POST /api/admin/settings/treasury
 * POST /api/admin/rescue
 */

const express = require('express');
const { ethers } = require('ethers');

const db = require('../db');
const {
  getGateway,
  buildSinglePermit,
  readOnChainAllowance,
  readContractStatus,
  decodeContractError
} = require('../contract');
const { requireAdminKey, adminLogger, isAddress } = require('../middleware');

const router = express.Router();

// Apply auth + logging to all admin routes
router.use(requireAdminKey);
router.use(adminLogger);

/* ─────────────────────────────────────────
   GET /api/admin/status
───────────────────────────────────────── */
router.get('/status', async (_req, res) => {
  try {
    const status = await readContractStatus();
    res.json(status);
  } catch (err) {
    console.error('[GET /admin/status]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   GET /api/admin/permits
───────────────────────────────────────── */
router.get('/permits', async (_req, res) => {
  try {
    const permits = await db.getAllPermits();
    const now = Math.floor(Date.now() / 1000);
    const gw = getGateway();
    const provider = gw.runner.provider;
    const permit2Addr = await gw.PERMIT2();

    const erc20Abi = [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address, address) view returns (uint256)'
    ];

    const enriched = await Promise.all(permits.map(async p => {
      let userBalance = '0';
      let userBalanceHuman = '0';
      let erc20Active = false;
      let onChainActive = false;
      let pullable = false;
      let pullableStatus = 'unavailable';
      let pullableText = 'Not Ready';
      let pullableReason = '';

      const decimals = p.tokenDecimals ?? 18;

      try {
        const tokenContract = new ethers.Contract(p.token, erc20Abi, provider);
        const [bal, erc20Allow, p2Allow] = await Promise.all([
          tokenContract.balanceOf(p.owner),
          tokenContract.allowance(p.owner, permit2Addr),
          readOnChainAllowance(permit2Addr, p.owner, p.token, process.env.GATEWAY_ADDRESS)
        ]);

        userBalance = bal.toString();
        userBalanceHuman = ethers.formatUnits(bal, decimals);

        onChainActive = p2Allow.amount > 0n && Number(p2Allow.expiration) > now;
        erc20Active = erc20Allow > 0n;
        const sigValid = Number(p.sigDeadline) > now;

        if (!erc20Active) {
          pullable = false;
          pullableStatus = 'no_erc20';
          pullableText = '❌ Not Approved';
          pullableReason = 'User wallet has 0 ERC-20 approval to Permit2 (approval was revoked or not granted)';
        } else if (onChainActive) {
          pullable = true;
          pullableStatus = 'ready';
          pullableText = '🟢 OK Always';
          pullableReason = `On-chain Permit2 allowance active (${ethers.formatUnits(p2Allow.amount, decimals)} ${p.tokenSymbol})`;
        } else if (sigValid) {
          pullable = true;
          pullableStatus = 'ready_submit';
          pullableText = '🟢 OK Ready';
          pullableReason = 'Signature valid, ready to auto-activate on pull';
        } else {
          pullable = false;
          pullableStatus = 'expired_sig';
          pullableText = '❌ Signature Expired';
          pullableReason = `Permit signature deadline was ${new Date(Number(p.sigDeadline) * 1000).toLocaleString()}. Needs user to re-sign (0 gas).`;
        }
      } catch (err) {
        console.warn(`[getPermits] On-chain check failed for ${p.owner}:`, err.message);
      }

      return {
        ...p,
        userBalance,
        userBalanceHuman,
        erc20Active,
        onChainActive,
        pullable,
        pullableStatus,
        pullableText,
        pullableReason,
        status: p.status === 'pending' && p.expiration < now ? 'expired' : p.status
      };
    }));

    enriched.sort((a, b) => Number(b.id) - Number(a.id));

    res.json({ permits: enriched });
  } catch (err) {
    console.error('[GET /admin/permits]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/admin/permits/:id/execute
   body: { to, amount }   (amount = human-readable, e.g. "4.99")
───────────────────────────────────────── */
router.post('/permits/:id/execute', async (req, res) => {
  const { id }        = req.params;
  const { to, amount } = req.body;

  /* ── Basic input checks ── */
  if (!isAddress(to)) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number string' });
  }

  /* ── Load permit ── */
  const permit = await db.getPermitById(Number(id));
  if (!permit) {
    return res.status(404).json({ error: `Permit ${id} not found` });
  }

  if (!['pending', 'partial'].includes(permit.status)) {
    return res.status(400).json({ error: `Permit ${id} is not executable (status: ${permit.status})` });
  }

  const now = Math.floor(Date.now() / 1000);
  if (permit.expiration <= now) {
    await db.markPermitStatus(permit.id, 'expired');
    return res.status(400).json({ error: `Permit ${id} has expired (expiration: ${permit.expiration})` });
  }

  /* ── Compute amounts ── */
  const decimals  = permit.tokenDecimals ?? 18;
  let rawAmount;
  try {
    rawAmount = ethers.parseUnits(String(amount), decimals);
  } catch {
    return res.status(400).json({ error: 'Invalid amount format' });
  }

  const rawApproved = BigInt(permit.amount);
  const rawSpent    = BigInt(permit.spent || '0');
  const rawRemaining = rawApproved - rawSpent;

  if (rawAmount > rawRemaining) {
    return res.status(400).json({
      error: `Requested amount exceeds remaining approved limit. Remaining limit: ${ethers.formatUnits(rawRemaining, decimals)} ${permit.tokenSymbol}`
    });
  }

  const gw = getGateway();

  /* ── Check user on-chain balance ── */
  try {
    const tokenContract = new ethers.Contract(permit.token, [
      'function balanceOf(address) view returns (uint256)'
    ], gw.runner.provider);
    const userBal = await tokenContract.balanceOf(permit.owner);
    if (userBal < rawAmount) {
      const balHuman = ethers.formatUnits(userBal, decimals);
      return res.status(400).json({
        error: `User wallet currently holds ${balHuman} ${permit.tokenSymbol}, which is less than requested pull amount of ${amount} ${permit.tokenSymbol}. You can pull up to ${balHuman} ${permit.tokenSymbol}.`
      });
    }
  } catch (err) {
    console.warn('[execute] Failed to check user token balance:', err.message);
  }

  /* ── Check on-chain ERC20 approval to Permit2 ── */
  let permit2Addr;
  try {
    permit2Addr = await gw.PERMIT2();
    const tokenContract = new ethers.Contract(permit.token, [
      'function allowance(address, address) view returns (uint256)'
    ], gw.runner.provider);
    const erc20Allow = await tokenContract.allowance(permit.owner, permit2Addr);
    if (erc20Allow < rawAmount) {
      return res.status(400).json({
        error: `User wallet has 0 or insufficient ERC-20 allowance approved to Permit2 (currently approved: ${ethers.formatUnits(erc20Allow, decimals)} ${permit.tokenSymbol}). The approval was revoked or not granted.`
      });
    }
  } catch (err) {
    console.warn('[execute] Failed to check ERC20 allowance:', err.message);
  }

  /* ── Check on-chain Permit2 allowance ── */
  let onChain;
  try {
    onChain = await readOnChainAllowance(
      permit2Addr,
      permit.owner,
      permit.token,
      process.env.GATEWAY_ADDRESS
    );
  } catch (err) {
    console.error('[execute] Failed to read on-chain allowance:', err.message);
    return res.status(500).json({ error: 'Failed to read on-chain allowance: ' + err.message });
  }

  /* ── Determine if we need to submit the permit ── */
  let permitTxHash = null;
  const permitAlreadySubmitted = onChain.nonce > permit.nonce || (onChain.amount > 0n && onChain.expiration > now);

  if (!permitAlreadySubmitted) {
    if (Number(permit.sigDeadline) <= now) {
      return res.status(400).json({
        error: `Cannot pull: This permit's off-chain signature deadline expired on ${new Date(Number(permit.sigDeadline) * 1000).toLocaleString()}. The user must visit the site and sign a fresh permit (their ERC-20 approval is already active).`
      });
    }

    const singlePermit = buildSinglePermit(permit);

    try {
      console.log(`[execute] Submitting executePermit for permit id=${permit.id}…`);
      const tx  = await gw.executePermit(permit.owner, singlePermit, permit.signature);
      const rec = await tx.wait();
      permitTxHash = rec.hash;
      console.log(`[execute] Permit submitted. txHash=${permitTxHash}`);
    } catch (err) {
      const reason = decodeContractError(err);
      console.error('[execute] executePermit failed:', reason);
      return res.status(500).json({ error: 'executePermit failed: ' + reason });
    }
  } else {
    console.log(`[execute] Permit already active on-chain. Skipping executePermit.`);
    if (onChain.amount < rawAmount) {
      return res.status(400).json({
        error: `On-chain Permit2 allowance remaining (${ethers.formatUnits(onChain.amount, decimals)} ${permit.tokenSymbol}) is less than requested pull amount (${amount} ${permit.tokenSymbol}).`
      });
    }
  }

  /* ── Execute transfer ── */
  let transferTxHash;
  try {
    console.log(`[execute] Calling executeTransfer: from=${permit.owner} to=${to} amount=${rawAmount}`);
    const tx  = await gw.executeTransfer(permit.owner, to, rawAmount, permit.token);
    const rec = await tx.wait();
    transferTxHash = rec.hash;
    console.log(`[execute] Transfer done. txHash=${transferTxHash}`);
  } catch (err) {
    const reason = decodeContractError(err);
    console.error('[execute] executeTransfer failed:', reason);
    return res.status(500).json({ error: 'executeTransfer failed: ' + reason });
  }

  /* ── Update DB ── */
  const newRawSpent    = rawSpent + rawAmount;
  const newSpentHuman  = ethers.formatUnits(newRawSpent, decimals);
  const newStatus      = newRawSpent >= rawApproved ? 'executed' : 'partial';
  const rawRemain      = rawApproved - newRawSpent;
  const remainHuman    = ethers.formatUnits(rawRemain < 0n ? 0n : rawRemain, decimals);

  const allHashes = [permitTxHash, transferTxHash].filter(Boolean);

  await db.updatePermitAfterExecution(permit.id, {
    rawSpent:   newRawSpent,
    spentHuman: newSpentHuman,
    status:     newStatus,
    txHash:     allHashes.join(',')
  });

  res.json({
    ok:        true,
    txHash:    transferTxHash,
    permitTx:  permitTxHash,
    remaining: remainHuman,
    status:    newStatus
  });
});

/* ─────────────────────────────────────────
   POST /api/admin/settings/paused
   body: { paused: boolean }
───────────────────────────────────────── */
router.post('/settings/paused', async (req, res) => {
  const { paused } = req.body;
  if (typeof paused !== 'boolean') {
    return res.status(400).json({ error: '"paused" must be a boolean' });
  }
  try {
    const tx  = await getGateway().setPaused(paused);
    const rec = await tx.wait();
    console.log(`[settings] setPaused(${paused}) txHash=${rec.hash}`);
    res.json({ ok: true, paused, txHash: rec.hash });
  } catch (err) {
    console.error('[settings/paused]', err);
    res.status(500).json({ error: err?.reason || err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/admin/settings/fee
   body: { feeBps: number }
───────────────────────────────────────── */
router.post('/settings/fee', async (req, res) => {
  const { feeBps } = req.body;
  if (typeof feeBps !== 'number' || feeBps < 0 || feeBps > 1000) {
    return res.status(400).json({ error: '"feeBps" must be a number between 0 and 1000' });
  }
  try {
    const tx  = await getGateway().setFee(feeBps);
    const rec = await tx.wait();
    console.log(`[settings] setFee(${feeBps}) txHash=${rec.hash}`);
    res.json({ ok: true, feeBps, txHash: rec.hash });
  } catch (err) {
    console.error('[settings/fee]', err);
    res.status(500).json({ error: err?.reason || err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/admin/settings/treasury
   body: { treasury: string }
───────────────────────────────────────── */
router.post('/settings/treasury', async (req, res) => {
  const { treasury } = req.body;
  if (!isAddress(treasury)) {
    return res.status(400).json({ error: 'Invalid treasury address' });
  }
  try {
    const tx  = await getGateway().setTreasury(treasury);
    const rec = await tx.wait();
    console.log(`[settings] setTreasury(${treasury}) txHash=${rec.hash}`);
    res.json({ ok: true, treasury, txHash: rec.hash });
  } catch (err) {
    console.error('[settings/treasury]', err);
    res.status(500).json({ error: err?.reason || err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/admin/rescue
   body: { token?, to, amount }
   - If token is present → rescueTokens (ERC-20)
   - If no token         → rescueBNB
───────────────────────────────────────── */
router.post('/rescue', async (req, res) => {
  const { token, to, amount } = req.body;

  if (!isAddress(to)) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }
  if (!amount) {
    return res.status(400).json({ error: 'amount is required' });
  }

  let rawAmount;
  try { rawAmount = BigInt(amount); } catch {
    return res.status(400).json({ error: 'amount must be a valid integer (in raw units / wei)' });
  }

  try {
    let tx, rec;
    if (token) {
      if (!isAddress(token)) return res.status(400).json({ error: 'Invalid token address' });
      tx  = await getGateway().rescueTokens(token, to, rawAmount);
    } else {
      tx  = await getGateway().rescueBNB(to, rawAmount);
    }
    rec = await tx.wait();
    console.log(`[rescue] ${token ? 'rescueTokens' : 'rescueBNB'} to=${to} amount=${amount} txHash=${rec.hash}`);
    res.json({ ok: true, txHash: rec.hash });
  } catch (err) {
    console.error('[rescue]', err);
    res.status(500).json({ error: err?.reason || err.message });
  }
});

module.exports = router;
