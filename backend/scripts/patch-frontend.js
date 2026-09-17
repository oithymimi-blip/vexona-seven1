'use strict';

/**
 * patch-frontend.js — Update frontend/index.html with the deployed contract address
 *
 * Usage:  node scripts/patch-frontend.js 0xYOUR_CONTRACT_ADDRESS
 *    or:  node scripts/patch-frontend.js   (reads from deployed.json or .env)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

let contractAddress = process.argv[2];

// Try reading from deployed.json if no arg
if (!contractAddress) {
  const recPath = path.join(__dirname, '..', '..', 'deployed.json');
  if (fs.existsSync(recPath)) {
    contractAddress = JSON.parse(fs.readFileSync(recPath, 'utf8')).contractAddress;
  }
}

// Try reading from .env
if (!contractAddress) {
  contractAddress = process.env.GATEWAY_ADDRESS;
}

if (!contractAddress || contractAddress === 'PENDING_DEPLOY') {
  console.error('❌  No contract address found. Pass it as argument:');
  console.error('    node scripts/patch-frontend.js 0xYOUR_CONTRACT');
  process.exit(1);
}

const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'index.html');

if (!fs.existsSync(frontendPath)) {
  console.error('❌  frontend/index.html not found at', frontendPath);
  process.exit(1);
}

let html = fs.readFileSync(frontendPath, 'utf8');

// Replace the placeholder
const before = html;
html = html.replace(
  /const GATEWAY\s*=\s*["']0xYOUR_GATEWAY_ADDRESS_HERE["']/,
  `const GATEWAY   = "${contractAddress}"`
);

if (html === before) {
  // Check if already patched
  if (html.includes(`const GATEWAY   = "${contractAddress}"`)) {
    console.log('ℹ️  Frontend already patched with', contractAddress);
  } else {
    console.error('❌  Could not find GATEWAY placeholder in frontend/index.html');
    process.exit(1);
  }
} else {
  fs.writeFileSync(frontendPath, html);
  console.log('✅  frontend/index.html patched with GATEWAY =', contractAddress);
}
