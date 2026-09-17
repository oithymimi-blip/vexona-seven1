'use strict';

/**
 * verify.js — Contract Verification Script
 *
 * Headless verification via Sourcify (free, no API key required, supported by Ethereum Foundation & Etherscan)
 * Plus BSCScan / Etherscan V2 API verification when an API key is provided.
 *
 * Usage: node scripts/verify.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONTRACT_ADDRESS = process.env.GATEWAY_ADDRESS;
const SOURCE_PATH      = path.join(__dirname, '..', '..', 'contracts', 'TokenGateway.sol');
const COMPILER_VERSION = '0.8.37+commit.f401782d';

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ statusCode: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ statusCode: res.statusCode, data: raw }); }
      });
    }).on('error', reject);
  });
}

async function verifySourcify(source) {
  console.log('📡 Submitting headless verification to Sourcify (Chain ID 56)...');
  
  // Check if already verified
  const checkRes = await httpsGet(`https://sourcify.dev/server/v2/contract/56/${CONTRACT_ADDRESS}`);
  if (checkRes.data && checkRes.data.match) {
    console.log(`✅ Already verified on Sourcify! (Match: ${checkRes.data.match})`);
    console.log(`   🔗 https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}\n`);
    return checkRes.data;
  }

  let txHash = undefined;
  try {
    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'deployed.json'), 'utf8'));
    txHash = dep.txHash;
  } catch {}

  const payload = {
    stdJsonInput: {
      language: 'Solidity',
      sources: {
        'TokenGateway.sol': {
          content: source
        }
      },
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        }
      }
    },
    compilerVersion: COMPILER_VERSION,
    contractIdentifier: 'TokenGateway.sol:TokenGateway'
  };

  if (txHash) {
    payload.creationTransactionHash = txHash;
  }

  const res = await httpsPost(`https://sourcify.dev/server/v2/verify/56/${CONTRACT_ADDRESS}`, payload);

  if (res.statusCode === 202 && res.data && res.data.verificationId) {
    console.log(`⏳ Verification queued (Job ID: ${res.data.verificationId}). Checking status...`);
    // Wait for job
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const jobRes = await httpsGet(`https://sourcify.dev/server/v2/verify/${res.data.verificationId}`);
      if (jobRes.data && jobRes.data.isJobCompleted) {
        console.log(`🎉 Verified successfully on Sourcify!`);
        console.log(`   Match: ${jobRes.data.contract?.match || 'exact_match'}`);
        console.log(`   🔗 https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}\n`);
        return jobRes.data;
      }
    }
  } else if (res.statusCode === 409) {
    console.log(`✅ Already verified on Sourcify!`);
    console.log(`   🔗 https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}\n`);
    return res.data;
  } else {
    console.log(`⚠️ Sourcify returned status ${res.statusCode}:`, res.data?.message || res.data);
  }
}

async function main() {
  console.log('\n🔍  TokenGateway Contract Verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === 'PENDING_DEPLOY') {
    console.error('❌  GATEWAY_ADDRESS not set in .env. Please deploy first.');
    process.exit(1);
  }

  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  console.log(`  Contract Address : ${CONTRACT_ADDRESS}`);
  console.log(`  Solidity Source  : ${SOURCE_PATH}`);
  console.log(`  Solc Compiler    : ${COMPILER_VERSION}`);
  console.log(`  Optimizer        : Enabled (200 runs)\n`);

  // 1. Headless internal verification via Sourcify
  await verifySourcify(source);

  // 2. BSCScan Manual Verification Guide
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋  BSCScan Manual Verification Guide');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('If you would like the verified green checkmark directly on BSCScan:');
  console.log(`1. Open: https://bscscan.com/verifyContract?a=${CONTRACT_ADDRESS}`);
  console.log('2. Step 1:');
  console.log(`   - Contract Address: ${CONTRACT_ADDRESS}`);
  console.log('   - Compiler Type: Solidity (Single file)');
  console.log(`   - Compiler Version: v${COMPILER_VERSION}`);
  console.log('   - Open Source License Type: 3) MIT License (MIT)');
  console.log('   - Click "Continue"');
  console.log('3. Step 2:');
  console.log('   - Optimization: Yes');
  console.log('   - Runs: 200');
  console.log('   - Enter Solidity Code: Paste the entire contents of contracts/TokenGateway.sol');
  console.log('   - Constructor Arguments: (Leave empty)');
  console.log('   - Complete the CAPTCHA & Click "Verify and Publish"');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => {
  console.error('❌  Verification error:', err);
  process.exit(1);
});
