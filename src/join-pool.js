#!/usr/bin/env node
// Rejoindre une pool sans refaire tout le setup (SHA256 + POST /api/pools/join).

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { runPoolJoinFlow } from './pool-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const log = {
  title: (s) => console.log(`\n=== ${s} ===`),
  ok: (s) => console.log(`  ✓ ${s}`),
  warn: (s) => console.log(`  ⚠ ${s}`),
  err: (s) => console.log(`  ✗ ${s}`),
  info: (s) => console.log(`  · ${s}`),
};

async function main() {
  if (!fs.existsSync(configPath)) {
    console.error('config.json manquant — lance npm run setup-auto d\'abord.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (!config.authToken) {
    console.error('authToken manquant dans config.json');
    process.exit(1);
  }
  if (!config.gpuId) {
    console.error('gpuId manquant — lance start.bat une fois pour enregistrer le GPU, puis relance join-pool.');
    process.exit(1);
  }
  if (!Array.isArray(config.models) || config.models.length === 0) {
    console.error('config.models est vide');
    process.exit(1);
  }

  console.log('\n  Rejoindre une pool (meme fichier GGUF que la pool, SHA256 identique)\n');
  console.log(`  Backend : ${config.platformUrl}`);
  console.log(`  GPU ID  : ${config.gpuId}\n`);

  const result = await runPoolJoinFlow({
    config,
    models: config.models,
    gpuId: config.gpuId,
    authToken: config.authToken,
    platformUrl: config.platformUrl,
    ask,
    log,
  });

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  if (result === 'pool' && config.poolMembership) {
    log.ok(`Config mise a jour — pool #${config.poolMembership.poolNumber}`);
    log.info('Relance start.bat pour activer le mode pool.');
  } else {
    log.err('Echec — verifie le numero de pool et le chemin du fichier .gguf.');
    process.exit(1);
  }

  rl.close();
}

main().catch((err) => {
  console.error('Erreur:', err.response?.data?.error || err.message);
  rl.close();
  process.exit(1);
});
