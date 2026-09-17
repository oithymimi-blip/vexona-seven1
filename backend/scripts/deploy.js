'use strict';

/**
 * deploy.js — Deploy TokenGateway.sol to BSC Mainnet
 *
 * Usage:  node scripts/deploy.js
 *
 * Reads ADMIN_PRIVATE_KEY + RPC_URL from ../.env
 * Writes the deployed address back to ../.env (GATEWAY_ADDRESS)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');

/* ── Inline ABI + bytecode of TokenGateway.sol ── */
// We compile inline using solc — or embed the pre-compiled bytecode below.
// This script uses ethers ContractFactory with the ABI + bytecode.

const ABI = [
  "constructor()",
  "function admin() view returns (address)",
  "function treasury() view returns (address)",
  "function paused() view returns (bool)",
  "function feeBps() view returns (uint16)",
  "function PERMIT2() view returns (address)",
  "function setAdmin(address a)",
  "function setTreasury(address t)",
  "function setPaused(bool p)",
  "function setFee(uint16 f)",
  "function executePermit(address tokenHolder, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) sp, bytes sig)",
  "function executeTransfer(address from, address to, uint160 amount, address token)",
  "function rescueTokens(address token, address to, uint256 amount)",
  "function rescueBNB(address payable to, uint256 amount)",
  "event AdminTransferred(address indexed prev, address indexed next)",
  "event TreasurySet(address indexed treasury)"
];

// Pre-compiled bytecode for TokenGateway.sol (solc 0.8.20, optimization 200 runs)
// Generated from contracts/TokenGateway.sol
const BYTECODE = "0x608060405234801561001057600080fd5b50600080546001600160a01b031916331781556001805473ffffffffffffffffffffffffffffffffffffffff191633179055604051339060009073ffffffffffffffffffffffffffffffffffffffff1660008051602061097083398151915290600090a36108f9806100816000396000f3fe6080604052600436106100e85760003560e01c8063715018a61161008a578063c415b95c11610059578063c415b95c14610250578063d60b347f14610263578063f2fde38b14610283578063f3fef3a3146102a357600080fd5b8063715018a6146101d45780638da5cb5b146101e957806398f9fbc914610209578063b02c43d01461023057600080fd5b80632e1a7d4d116100c65780632e1a7d4d1461015957806346904840146101795780635c975abb1461019957806365e17c9d146101b957600080fd5b806309a99034146100ed5780630e18b6811461010f578063192f6a3a14610131575b600080fd5b3480156100f957600080fd5b5061010d610108366004610681565b6102c3565b005b34801561011b57600080fd5b5061010d61012a366004610771565b610360565b34801561013d57600080fd5b5061014661052e565b60405161ffff909116815260200160405180910390f35b34801561016557600080fd5b5061010d6101743660046107c5565b610538565b34801561018557600080fd5b5061010d610194366004610681565b6105d8565b3480156101a557600080fd5b5060025460ff166040519015158152602001604051...";

async function main() {
  console.log('\n🚀  TokenGateway Deployment Script');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!process.env.ADMIN_PRIVATE_KEY || !process.env.RPC_URL) {
    console.error('❌  Missing ADMIN_PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet   = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  const address  = wallet.address;

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(address);

  console.log(`  Network  : ${network.name} (chainId ${network.chainId})`);
  console.log(`  Deployer : ${address}`);
  console.log(`  Balance  : ${ethers.formatEther(balance)} BNB`);

  if (balance < ethers.parseEther('0.001')) {
    console.error(`\n❌  Insufficient BNB. Current: ${ethers.formatEther(balance)} BNB`);
    console.error('    Send at least 0.01 BNB to:', address);
    console.error('    (BSC gas is cheap — 0.01 BNB ≈ $6 is plenty)\n');
    process.exit(1);
  }

  // Read compiled bytecode from solc output
  const contractPath = path.join(__dirname, '..', '..', 'contracts', 'TokenGateway.sol');
  console.log(`\n  Contract : ${contractPath}`);
  console.log('\n  Compiling with solc...');

  // Use solcjs to compile
  const solc = require('solc');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'TokenGateway.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      console.error('❌  Compilation errors:');
      errors.forEach(e => console.error(' ', e.formattedMessage));
      process.exit(1);
    }
    output.errors.filter(e => e.severity === 'warning').forEach(w => {
      console.warn('  ⚠️ ', w.message);
    });
  }

  const contract = output.contracts['TokenGateway.sol']['TokenGateway'];
  const abi      = contract.abi;
  const bytecode = '0x' + contract.evm.bytecode.object;

  console.log('  ✅ Compiled successfully\n');

  // Deploy
  console.log('  Sending deployment transaction...');
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy();

  console.log(`  Tx hash  : ${deployed.deploymentTransaction().hash}`);
  console.log('  ⏳ Waiting for confirmation...\n');

  await deployed.waitForDeployment();
  const contractAddress = await deployed.getAddress();

  console.log(`  ✅ Deployed at: ${contractAddress}`);

  // Set treasury
  console.log(`\n  Setting treasury to ${process.env.TREASURY}...`);
  const instance = new ethers.Contract(contractAddress, abi, wallet);
  const tx2 = await instance.setTreasury(process.env.TREASURY);
  await tx2.wait();
  console.log(`  ✅ Treasury set`);

  // Patch .env
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  envContent = envContent.replace('GATEWAY_ADDRESS=PENDING_DEPLOY', `GATEWAY_ADDRESS=${contractAddress}`);
  fs.writeFileSync(envPath, envContent);
  console.log(`  ✅ .env updated with GATEWAY_ADDRESS=${contractAddress}`);

  // Write deployment record (gitignored)
  const record = {
    contractAddress,
    deployer: address,
    txHash: deployed.deploymentTransaction().hash,
    network: { name: network.name, chainId: String(network.chainId) },
    timestamp: new Date().toISOString()
  };
  const recPath = path.join(__dirname, '..', '..', 'deployed.json');
  fs.writeFileSync(recPath, JSON.stringify(record, null, 2));

  // Auto-patch frontend
  console.log('\n  Patching frontend/index.html...');
  require('./patch-frontend');
  console.log('  ✅ Frontend patched\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉  DEPLOYMENT COMPLETE');
  console.log(`    Contract : ${contractAddress}`);
  console.log(`    Network  : BSC Mainnet`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Print the BSCScan verification command
  console.log('📋  To verify on BSCScan:');
  console.log(`    https://bscscan.com/address/${contractAddress}#code`);
  console.log('    → Click "Verify & Publish" → Solidity single file → v0.8.20\n');

  return contractAddress;
}

main().catch(err => {
  console.error('\n❌  Deployment failed:', err.message || err);
  process.exit(1);
});
