#!/usr/bin/env node
// src/setup.js
// Interactive setup: guides the provider through wallet auth + config.json update.
//
// Usage: npm run setup

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');

function loadConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  if (fs.existsSync(examplePath)) {
    console.log('Creating config.json from config.example.json');
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  }
  throw new Error('Neither config.json nor config.example.json found');
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

async function main() {
  console.log('');
  console.log('==========================================');
  console.log('  GPU Rental — Provider Agent Setup');
  console.log('==========================================');
  console.log('');

  const config = loadConfig();

  const platformUrl = (await prompt(`Backend URL [${config.platformUrl || 'http://localhost:3001'}]: `))
    || config.platformUrl || 'http://localhost:3001';
  config.platformUrl = platformUrl;

  const walletAddress = (await prompt(`Your Chia address (xch1...) [${config.chiaWalletAddress || ''}]: `))
    || config.chiaWalletAddress;
  if (!walletAddress || !walletAddress.startsWith('xch1')) {
    console.error('Invalid address (must start with xch1)');
    process.exit(1);
  }
  config.chiaWalletAddress = walletAddress;

  console.log('');
  console.log(`1. Requesting challenge from ${platformUrl}...`);
  let challenge;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/challenge`, { walletAddress });
    challenge = data.challenge;
    console.log(`   OK: challenge received (expires in ${Math.round(data.ttlMs / 60000)} min)`);
  } catch (err) {
    console.error(`   FAILED: ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('2. SIGN this challenge with your wallet:');
  console.log('');
  console.log(`   Challenge (hex 32 bytes):`);
  console.log(`   ${challenge}`);
  console.log('');
  console.log('   Signing options:');
  console.log('   a) Goby Wallet (browser): open DevTools console and run:');
  console.log(`      await window.chia.request({ method: 'signMessage', params: { message: '${challenge}' } })`);
  console.log('      Copy the returned JSON (contains signature + pubkey/publicKey)');
  console.log('');
  console.log('   b) Chia CLI / custom Python script with AugSchemeMPL.sign(sk, bytes.fromhex(challenge))');
  console.log('');

  const pubkey = await prompt('   Paste your pubkey (hex 48 bytes): ');
  const signature = await prompt('   Paste your signature (hex 96 bytes): ');

  if (pubkey.length !== 96) {  // 48 bytes = 96 hex chars
    console.error(`   FAILED: pubkey must be 96 hex chars (got ${pubkey.length})`);
    process.exit(1);
  }
  if (signature.length !== 192) {  // 96 bytes = 192 hex chars
    console.error(`   FAILED: signature must be 192 hex chars (got ${signature.length})`);
    process.exit(1);
  }

  console.log('');
  console.log('3. Verifying signature...');
  let token;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/verify`, {
      walletAddress, pubkey, signature,
    });
    token = data.token;
    console.log(`   OK: JWT received (user ${data.user.id})`);
  } catch (err) {
    console.error(`   FAILED: ${err.response?.data?.error || err.message}`);
    console.error('   Verify that the pubkey matches the key that signed.');
    process.exit(1);
  }

  config.authToken = token;

  console.log('');
  console.log('4. Optional GPU configuration (Enter to keep existing):');

  const llamaCpp = await prompt(`   llama-server path [${config.llamaCppPath || ''}]: `);
  if (llamaCpp) config.llamaCppPath = llamaCpp;

  const rate = await prompt(`   Rate USD/hour [${config.rateUsdPerHour ?? 0.5}]: `);
  if (rate) config.rateUsdPerHour = parseFloat(rate);

  const payout = await prompt(`   Payout currency (BYC/XCH) [${config.payoutPreference || 'XCH'}]: `);
  if (payout) {
    if (!['BYC', 'XCH'].includes(payout.toUpperCase())) {
      console.error('   payoutPreference must be BYC or XCH');
      process.exit(1);
    }
    config.payoutPreference = payout.toUpperCase();
  }

  saveConfig(config);

  console.log('');
  console.log('==========================================');
  console.log('  Setup complete!');
  console.log('==========================================');
  console.log('');
  console.log(`Config saved to ${configPath}`);
  console.log(`JWT token valid for 7 days.`);
  console.log('');
  console.log('You can now start the agent:');
  console.log('  npm start');
  console.log('');
  console.log('Reminder: verify that llamaCppPath and models[].path point to');
  console.log('existing files before launching.');

  rl.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  rl.close();
  process.exit(1);
});
