'use strict';

/**
 * contract.js — ethers.js contract bindings for TokenGateway + Permit2
 */

const { ethers } = require('ethers');

/* ─────────────── ABIs ─────────────── */

const GATEWAY_ABI = [
  // View
  "function admin() view returns (address)",
  "function treasury() view returns (address)",
  "function paused() view returns (bool)",
  "function feeBps() view returns (uint16)",
  "function PERMIT2() view returns (address)",

  // Admin config
  "function setPaused(bool p)",
  "function setFee(uint16 f)",
  "function setTreasury(address t)",
  "function setAdmin(address a)",

  // Core
  "function executePermit(address tokenHolder, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) sp, bytes calldata sig)",
  "function executeTransfer(address from, address to, uint160 amount, address token)",
  "function executePermitAndTransfer(address tokenHolder, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) sp, bytes calldata sig, address to, uint160 amount)",

  // Rescue
  "function rescueTokens(address token, address to, uint256 amount)",
  "function rescueBNB(address payable to, uint256 amount)",

  // Permit2 Custom Errors
  "error SignatureExpired(uint256 signatureDeadline)",
  "error AllowanceExpired(uint256 expiration)",
  "error InsufficientAllowance(uint256 currentAllowance)",
  "error InvalidNonce()",
  "error InvalidSigner()",
  "error ExcessiveInvalidation()",
  "error LengthMismatch()"
];

const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "error SignatureExpired(uint256 signatureDeadline)",
  "error AllowanceExpired(uint256 expiration)",
  "error InsufficientAllowance(uint256 currentAllowance)",
  "error InvalidNonce()",
  "error InvalidSigner()"
];

/* ─────────────── Singletons ─────────────── */

let _provider;
let _wallet;
let _gateway;
let _permit2;

const DEFAULT_GATEWAY = '0x0c215808bf5251A47938C40971372f2DeCe7e507';
const DEFAULT_RPC     = 'https://bsc-dataseed.binance.org';

function getProvider() {
  if (!_provider) {
    const rpc = (process.env.RPC_URL || DEFAULT_RPC).trim();
    _provider = new ethers.JsonRpcProvider(rpc);
  }
  return _provider;
}

function getWallet() {
  if (!_wallet) {
    const pk = (process.env.ADMIN_PRIVATE_KEY || '').trim();
    if (!pk) {
      throw new Error('ADMIN_PRIVATE_KEY is not configured in environment variables.');
    }
    _wallet = new ethers.Wallet(pk, getProvider());
  }
  return _wallet;
}

function getGateway(withSigner = true) {
  const gwAddr = (process.env.GATEWAY_ADDRESS || DEFAULT_GATEWAY).trim();
  if (withSigner) {
    if (!_gateway) {
      _gateway = new ethers.Contract(gwAddr, GATEWAY_ABI, getWallet());
    }
    return _gateway;
  }
  return new ethers.Contract(gwAddr, GATEWAY_ABI, getProvider());
}

function getPermit2(address) {
  return new ethers.Contract(address, PERMIT2_ABI, getProvider());
}

/* ─────────────── Helpers ─────────────── */

/**
 * Build the SinglePermit tuple expected by the contract.
 */
function buildSinglePermit(row) {
  return {
    details: {
      token:      row.token,
      amount:     BigInt(row.amount),
      expiration: row.expiration,
      nonce:      row.nonce
    },
    spender:     row.spender,
    sigDeadline: BigInt(row.sigDeadline)
  };
}

/**
 * Read on-chain Permit2 allowance for (owner, token, gateway).
 */
async function readOnChainAllowance(permit2Address, owner, token, spender) {
  const permit2 = getPermit2(permit2Address);
  const [amount, expiration, nonce] = await permit2.allowance(owner, token, spender);
  return {
    amount:     BigInt(amount),
    expiration: Number(expiration),
    nonce:      Number(nonce)
  };
}

/**
 * Read the on-chain contract state for the admin dashboard.
 */
async function readContractStatus() {
  const gw       = getGateway(false);
  const provider = getProvider();
  const gwAddr   = (process.env.GATEWAY_ADDRESS || DEFAULT_GATEWAY).trim();

  const [admin, treasury, paused, feeBps, permit2, contractBalWei] = await Promise.all([
    gw.admin(),
    gw.treasury(),
    gw.paused(),
    gw.feeBps(),
    gw.PERMIT2(),
    provider.getBalance(gwAddr)
  ]);

  const adminBalWei = await provider.getBalance(admin);

  return {
    admin,
    treasury,
    paused,
    feeBps:     Number(feeBps),
    permit2,
    gateway:    gwAddr,
    bnbBalance: ethers.formatEther(adminBalWei),
    contractBnb: ethers.formatEther(contractBalWei)
  };
}

/* ─────────────── Chain ID verification ─────────────── */

let _chainId;
async function getChainId() {
  if (!_chainId) {
    const net = await getProvider().getNetwork();
    _chainId  = Number(net.chainId);
  }
  return _chainId;
}

/* ─────────────── Error decoding ─────────────── */

const PERMIT2_ERROR_IFACE = new ethers.Interface([
  "error SignatureExpired(uint256 signatureDeadline)",
  "error AllowanceExpired(uint256 expiration)",
  "error InsufficientAllowance(uint256 currentAllowance)",
  "error InvalidNonce()",
  "error InvalidSigner()",
  "error ExcessiveInvalidation()",
  "error LengthMismatch()"
]);

function decodeContractError(err) {
  const data = err?.data || err?.error?.data || err?.info?.error?.data;
  if (data && typeof data === 'string' && data.startsWith('0x')) {
    try {
      const parsed = PERMIT2_ERROR_IFACE.parseError(data);
      if (parsed) {
        if (parsed.name === 'SignatureExpired') {
          const deadline = Number(parsed.args[0]);
          const dStr = new Date(deadline * 1000).toISOString();
          return `Permit2 SignatureExpired: Signature deadline was ${dStr} (timestamp ${deadline})`;
        }
        if (parsed.name === 'AllowanceExpired') {
          const exp = Number(parsed.args[0]);
          return `Permit2 AllowanceExpired: Allowance expired at timestamp ${exp}`;
        }
        if (parsed.name === 'InsufficientAllowance') {
          return `Permit2 InsufficientAllowance: Allowance remaining is less than requested transfer`;
        }
        if (parsed.name === 'InvalidNonce') {
          return `Permit2 InvalidNonce: Nonce was already used or invalidated`;
        }
        if (parsed.name === 'InvalidSigner') {
          return `Permit2 InvalidSigner: Signature does not match the token owner`;
        }
        return `Permit2 custom error: ${parsed.name}`;
      }
    } catch (_) {}
  }
  return err?.reason || err?.shortMessage || err?.message || String(err);
}

module.exports = {
  getProvider,
  getWallet,
  getGateway,
  getPermit2,
  buildSinglePermit,
  readOnChainAllowance,
  readContractStatus,
  getChainId,
  decodeContractError
};
