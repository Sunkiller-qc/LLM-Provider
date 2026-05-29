#!/usr/bin/env node
// provider-agent/src/setup.js
// Setup interactif : guide le fournisseur dans l'auth wallet + update config.json.
//
// Usage : npm run setup

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
    console.log('Création de config.json depuis config.example.json');
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  }
  throw new Error('Ni config.json ni config.example.json trouvé');
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

  const platformUrl = (await prompt(`URL du backend [${config.platformUrl || 'http://localhost:3001'}] : `))
    || config.platformUrl || 'http://localhost:3001';
  config.platformUrl = platformUrl;

  const walletAddress = (await prompt(`Ton adresse Chia (xch1...) [${config.chiaWalletAddress || ''}] : `))
    || config.chiaWalletAddress;
  if (!walletAddress || !walletAddress.startsWith('xch1')) {
    console.error('Adresse invalide (doit commencer par xch1)');
    process.exit(1);
  }
  config.chiaWalletAddress = walletAddress;

  console.log('');
  console.log(`1. Demande du challenge a ${platformUrl}...`);
  let challenge;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/challenge`, { walletAddress });
    challenge = data.challenge;
    console.log(`   OK : challenge recu (expire dans ${Math.round(data.ttlMs / 60000)} min)`);
  } catch (err) {
    console.error(`   ECHEC : ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('2. SIGNE ce challenge avec ton wallet :');
  console.log('');
  console.log(`   Challenge (hex 32 bytes) :`);
  console.log(`   ${challenge}`);
  console.log('');
  console.log('   Options de signature :');
  console.log('   a) Goby Wallet (browser) : ouvre la console DevTools et execute :');
  console.log(`      await window.chia.request({ method: 'signMessage', params: { message: '${challenge}' } })`);
  console.log('      Copie le JSON retourne (contient signature + pubkey/publicKey)');
  console.log('');
  console.log('   b) Chia CLI / script Python custom avec AugSchemeMPL.sign(sk, bytes.fromhex(challenge))');
  console.log('');

  const pubkey = await prompt('   Colle ta pubkey (hex 48 bytes) : ');
  const signature = await prompt('   Colle ta signature (hex 96 bytes) : ');

  if (pubkey.length !== 96) {  // 48 bytes = 96 hex chars
    console.error(`   ECHEC : pubkey doit faire 96 hex chars (recu ${pubkey.length})`);
    process.exit(1);
  }
  if (signature.length !== 192) {  // 96 bytes = 192 hex chars
    console.error(`   ECHEC : signature doit faire 192 hex chars (recu ${signature.length})`);
    process.exit(1);
  }

  console.log('');
  console.log('3. Verification de la signature...');
  let token;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/verify`, {
      walletAddress, pubkey, signature,
    });
    token = data.token;
    console.log(`   OK : JWT recu (user ${data.user.id})`);
  } catch (err) {
    console.error(`   ECHEC : ${err.response?.data?.error || err.message}`);
    console.error('   Verifie que la pubkey correspond bien a la cle qui a signe.');
    process.exit(1);
  }

  config.authToken = token;

  console.log('');
  console.log('4. Configuration GPU optionnelle (Enter pour garder existant) :');

  const llamaCpp = await prompt(`   Chemin llama-server [${config.llamaCppPath || ''}] : `);
  if (llamaCpp) config.llamaCppPath = llamaCpp;

  const rate = await prompt(`   Tarif USD/heure [${config.rateUsdPerHour ?? 0.5}] : `);
  if (rate) config.rateUsdPerHour = parseFloat(rate);

  const payout = await prompt(`   Devise payout (BYC/XCH) [${config.payoutPreference || 'XCH'}] : `);
  if (payout) {
    if (!['BYC', 'XCH'].includes(payout.toUpperCase())) {
      console.error('   payoutPreference doit etre BYC ou XCH');
      process.exit(1);
    }
    config.payoutPreference = payout.toUpperCase();
  }

  saveConfig(config);

  console.log('');
  console.log('==========================================');
  console.log('  Setup termine !');
  console.log('==========================================');
  console.log('');
  console.log(`Config sauvegardee dans ${configPath}`);
  console.log(`Token JWT valide 7 jours.`);
  console.log('');
  console.log('Tu peux maintenant lancer l\'agent :');
  console.log('  npm start');
  console.log('');
  console.log('Rappel : verifie que llamaCppPath et models[].path pointent bien vers');
  console.log('des fichiers existants avant de lancer.');

  rl.close();
}

main().catch(err => {
  console.error('Erreur fatale :', err.message);
  rl.close();
  process.exit(1);
});
