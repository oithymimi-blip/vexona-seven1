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
  "function rescueBNB(address payable to, uint256 amount)"
];

const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"
];

/* ─────────────── Singletons ─────────────── */

let _provider;
let _wallet;
let _gateway;
let _permit2;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  }
  return _provider;
}

function getWallet() {
  if (!_wallet) {
    _wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, getProvider());
  }
  return _wallet;
}

function getGateway() {
  if (!_gateway) {
    _gateway = new ethers.Contract(
      process.env.GATEWAY_ADDRESS,
      GATEWAY_ABI,
      getWallet()
    );
  }
  return _gateway;
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
  const gw      = getGateway();
  const provider = getProvider();

  const [admin, treasury, paused, feeBps, permit2, contractBalWei] = await Promise.all([
    gw.admin(),
    gw.treasury(),
    gw.paused(),
    gw.feeBps(),
    gw.PERMIT2(),
    provider.getBalance(process.env.GATEWAY_ADDRESS)
  ]);

  const adminBalWei = await provider.getBalance(admin);

  return {
    admin,
    treasury,
    paused,
    feeBps:     Number(feeBps),
    permit2,
    gateway:    process.env.GATEWAY_ADDRESS,
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

module.exports = {
  getProvider,
  getWallet,
  getGateway,
  getPermit2,
  buildSinglePermit,
  readOnChainAllowance,
  readContractStatus,
  getChainId
};
