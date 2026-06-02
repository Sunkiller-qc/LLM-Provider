#!/usr/bin/env node
// provider-agent/src/wizard.js
// Setup interactif complet : detection GPU, scan dossier .bat, test ports,
// pre-benchmark, auth wallet, register backend.
//
// Usage : npm run wizard

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { detectAllGpus } from './gpu-monitor.js';
import {
  detectCloudflared,
  detectLlamaServer,
  findFreePort,
  scanLaunchScripts,
  validateModelFile,
} from './detect.js';
import { ensureModelLoaded, stopLlamaServer } from './llama-manager.js';
import { printRateHints } from './pricing.js';
import { askServingModeEarly, isPoolMode, finalizePoolJoin, runPoolJoinFlow } from './pool-setup.js';
import { DEFAULT_PLATFORM_URL, DEFAULT_FRONTEND_URL, normalizePlatformUrl } from './defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};
const log = {
  title: (s) => console.log(`\n${c.bold}${c.cyan}=== ${s} ===${c.reset}\n`),
  ok: (s) => console.log(`  ${c.green}✓${c.reset} ${s}`),
  warn: (s) => console.log(`  ${c.yellow}⚠${c.reset} ${s}`),
  err: (s) => console.log(`  ${c.red}✗${c.reset} ${s}`),
  info: (s) => console.log(`  ${c.dim}·${c.reset} ${s}`),
};

function loadOrCreateConfig() {
  if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (fs.existsSync(examplePath)) return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function promptRateForModel(question, tokensPerSec) {
  if (tokensPerSec) printRateHints(tokensPerSec, log);
  const raw = await prompt(question);
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.4;
}

/** Ajuste les tarifs après mesure tok/s */
async function stepAdjustRates(models) {
  const withBench = models.filter(m => m._bench?.tokensPerSec);
  if (withBench.length === 0) return models;

  log.title('6b. Tarifs (selon benchmark)');
  console.log('Ajuste tes prix $/h si besoin (équivalent $/M tokens).\n');

  for (const m of withBench) {
    printRateHints(m._bench.tokensPerSec, log);
    const raw = await prompt(
      `  ${m.name} — tarif USD/h [${(m.rateUsdPerHour ?? 0.4).toFixed(2)}] : `,
    );
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0) m.rateUsdPerHour = n;
    }
  }
  return models;
}

// --- Etape 1 : detection environnement ---
async function stepEnvironment() {
  log.title('1. Detection de ton environnement');

  // GPUs
  let gpus;
  try {
    gpus = await detectAllGpus();
    for (const g of gpus) {
      log.ok(`GPU #${g.index} : ${c.bold}${g.model}${c.reset} (${g.vramGb} Go VRAM)`);
    }
  } catch (err) {
    log.err(err.message);
    log.info('Verifie que les drivers NVIDIA sont installes (nvidia-smi)');
    process.exit(1);
  }

  // llama-server
  const llama = await detectLlamaServer();
  if (llama.ok) log.ok(`llama-server : ${llama.path}`);
  else log.warn(`llama-server : ${llama.error} (on te demande le chemin plus tard)`);

  // cloudflared
  const cf = await detectCloudflared();
  if (cf.ok) log.ok(`cloudflared : ${cf.version}`);
  else log.warn(`cloudflared : ${cf.error}`);

  // port libre
  const port = await findFreePort(8080);
  if (port) log.ok(`Port libre detecte : ${port}`);
  else log.warn('Aucun port libre dans 8080-8129');

  return { gpus, llama, cloudflared: cf, port };
}

// --- Etape 2 : choix du GPU si plusieurs ---
async function stepChooseGpu(gpus) {
  if (gpus.length === 1) return gpus[0];
  log.title(`2. Tu as ${gpus.length} GPUs detectes`);
  for (const g of gpus) {
    console.log(`  [${g.index}] ${g.model} ${g.vramGb} Go`);
  }
  const idx = await prompt(`Quel GPU louer ? (index, defaut 0) : `);
  const chosen = gpus[parseInt(idx) || 0] || gpus[0];
  log.ok(`Choisi : GPU #${chosen.index} ${chosen.model}`);
  return chosen;
}

// --- Etape 3 : llama-server path ---
async function stepLlamaPath(llama, existingPath) {
  log.title('3. Chemin vers llama-server');
  let p = llama.ok ? llama.path : existingPath;
  if (p) {
    const accept = await prompt(`Detecte : ${p}\nOK ? (Y/n) : `);
    if (accept.toLowerCase() !== 'n') return p;
  }
  while (true) {
    p = await prompt('Chemin complet vers llama-server (.exe sur Windows) : ');
    if (fs.existsSync(p)) {
      log.ok(`Trouve : ${p}`);
      return p;
    }
    log.err('Fichier introuvable, reessaye');
  }
}

// --- Etape 4 : decouverte des modeles ---
async function stepModels(existingModels = [], opts = {}) {
  const { poolMode = false, poolRate = 0.4 } = opts;
  log.title(poolMode ? '5. Ton modele (pool)' : '5. Tes modeles');
  console.log('Tu as 2 options :');
  console.log(`  [a] ${c.bold}Scanner un dossier de .bat${c.reset} (rapide si tu as deja des launchers)`);
  console.log(`  [b] ${c.bold}Ajouter manuellement${c.reset} (path GGUF + nom)\n`);
  const choice = await prompt('Choix (a/b, defaut a) : ');

  if (choice.toLowerCase() === 'b') {
    return stepModelsManual(existingModels, opts);
  }
  return stepModelsScan(existingModels, opts);
}

async function stepModelsScan(existingModels, { poolMode, poolRate }) {
  const folder = await prompt('Dossier contenant tes .bat/.sh : ');
  const scan = scanLaunchScripts(folder);
  if (!scan.ok) {
    log.err(scan.error);
    return stepModels(existingModels, { poolMode, poolRate });
  }
  log.info(`${scan.scripts} script(s) trouve(s) dans ${folder}`);
  for (const w of scan.warnings) log.warn(w);
  if (scan.detected.length === 0) {
    log.warn('Aucun modele detecte (pas de --model dans les scripts)');
    return stepModelsManual(existingModels, { poolMode, poolRate });
  }

  console.log('');
  const accepted = [];
  for (const m of scan.detected) {
    const validation = validateModelFile(m.path);
    if (!validation.ok) {
      log.warn(`${m.name} → ${validation.error} (${m.path})`);
      continue;
    }
    console.log(`  ${c.bold}${m.name}${c.reset}`);
    console.log(`    path  : ${m.path} (${validation.sizeGb} Go)`);
    console.log(`    ctx   : ${m.ctx} · ngl : ${m.nGpuLayers}`);

    const rate = poolMode ? poolRate : await promptRateForModel(`    Tarif USD/h pour ce modele [0.40] : `, null);
    accepted.push({
      name: m.name,
      path: m.path,
      scriptPath: m.scriptPath,
      ctx: m.ctx,
      nGpuLayers: m.nGpuLayers,
      rateUsdPerHour: rate,
    });
    log.ok(poolMode ? `Ajoute : ${m.name} (tarif pool $${rate}/h)` : `Ajoute : ${m.name} a $${(parseFloat(rate) || 0.40).toFixed(2)}/h`);
  }
  return accepted;
}

async function stepModelsManual(existingModels, { poolMode, poolRate }) {
  const models = [...existingModels];
  while (true) {
    console.log('');
    if (models.length > 0) {
      log.info(`${models.length} modele(s) deja ajoute(s) : ${models.map(m => m.name).join(', ')}`);
    }
    const add = await prompt('Ajouter un modele ? (Y/n) : ');
    if (add.toLowerCase() === 'n') break;

    const modelPath = await prompt('  Chemin du fichier GGUF : ');
    const validation = validateModelFile(modelPath);
    if (!validation.ok) {
      log.err(validation.error);
      continue;
    }
    const name = await prompt(`  Nom affiche [${path.basename(modelPath, '.gguf')}] : `)
      || path.basename(modelPath, '.gguf');
    const ctx = await prompt('  Taille contexte [8192] : ');
    const ngl = await prompt('  N gpu layers [99] : ');
    const rate = poolMode ? poolRate : await promptRateForModel('  Tarif USD/h [0.40] : ', null);

    models.push({
      name,
      path: modelPath,
      ctx: parseInt(ctx) || 8192,
      nGpuLayers: parseInt(ngl) || 99,
      rateUsdPerHour: rate,
    });
    log.ok(poolMode
      ? `${name} (${validation.sizeGb} Go) — pool $${rate}/h`
      : `${name} (${validation.sizeGb} Go) a $${parseFloat(rate || 0.40).toFixed(2)}/h`);
  }
  return models;
}

// --- Etape 5 : auth wallet ---
async function stepAuth(config) {
  log.title('5. Authentification wallet Chia');

  const platformUrl = normalizePlatformUrl(
    (await prompt(`Backend API URL [${config.platformUrl || DEFAULT_PLATFORM_URL}] : `))
    || config.platformUrl
    || DEFAULT_PLATFORM_URL,
  );
  config.platformUrl = platformUrl;
  log.info(`Frontend (Sage/JWT) : ${DEFAULT_FRONTEND_URL}`);

  if (config.authToken) {
    try {
      const payload = JSON.parse(Buffer.from(config.authToken.split('.')[1], 'base64url').toString('utf8'));
      if (payload?.exp && payload.exp * 1000 > Date.now()) {
        const reuse = await prompt(`Token deja present (wallet ${payload.walletAddress}). Reutiliser ? (Y/n) : `);
        if (reuse.toLowerCase() !== 'n') {
          log.ok('Token existant valide');
          return config;
        }
      }
    } catch (_) {}
  }

  const walletAddress = (await prompt(`Ton adresse Chia (xch1...) [${config.chiaWalletAddress || ''}] : `))
    || config.chiaWalletAddress;
  if (!walletAddress || !walletAddress.startsWith('xch1')) {
    log.err('Adresse invalide');
    process.exit(1);
  }
  config.chiaWalletAddress = walletAddress;

  log.info('Demande du challenge...');
  let challenge;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/challenge`, { walletAddress });
    challenge = data.challenge;
    log.ok(`Challenge recu (expire dans ${Math.round(data.ttlMs / 60000)} min)`);
  } catch (err) {
    log.err(`Auth challenge : ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }

  console.log('\n  Signe ce challenge avec ton wallet Sage / chia CLI :');
  console.log(`  ${c.cyan}${challenge}${c.reset}\n`);
  console.log('  Sage : ouvre la console (Ctrl+Shift+I) ou utilise la page /provider/setup');
  console.log('  Chia CLI : chia keys sign --message <ci-dessus> ...\n');

  const pubkey = await prompt('  Pubkey (hex 48 bytes = 96 chars) : ');
  const signature = await prompt('  Signature (hex 96 bytes = 192 chars) : ');

  log.info('Verification...');
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/verify`, {
      walletAddress, pubkey, signature, scheme: 'chip-0002',
    });
    config.authToken = data.token;
    log.ok(`JWT recu pour ${data.user.walletAddress}`);
  } catch (err) {
    log.err(`Verify : ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }
  return config;
}

// --- Etape 6 : pre-benchmark de chaque modele ---
async function stepBenchmark(config, models) {
  log.title('6. Pre-benchmark (mesure tokens/s)');
  console.log('On charge chaque modele 1 fois pour mesurer son debut et son debit.\n');

  const skip = await prompt('Skipper le pre-benchmark (plus rapide) ? (y/N) : ');
  if (skip.toLowerCase() === 'y') {
    log.info('Skipped — le backend lancera un benchmark complet au register');
    return models;
  }

  const PROMPT = 'Reply with exactly these words and nothing else: GPU rental test ok';
  const benchmarked = [];

  for (const m of models) {
    console.log(`\n  ${c.bold}${m.name}${c.reset}`);
    try {
      const t0 = Date.now();
      await ensureModelLoaded({ ...config, models }, m.name);
      const tLoaded = Date.now();
      const res = await axios.post(
        `http://127.0.0.1:${config.localLlamaPort}/v1/chat/completions`,
        {
          model: m.name,
          messages: [{ role: 'user', content: PROMPT }],
          max_tokens: 30,
          temperature: 0,
          stream: false,
        },
        { timeout: 90_000 },
      );
      const tDone = Date.now();
      const text = res.data?.choices?.[0]?.message?.content || '';
      const tokens = res.data?.usage?.completion_tokens || text.split(/\s+/).length;
      const loadMs = tLoaded - t0;
      const tokensPerSec = tokens / ((tDone - tLoaded) / 1000);
      log.ok(`Charge : ${(loadMs / 1000).toFixed(1)}s · Debit : ${tokensPerSec.toFixed(1)} tok/s`);
      benchmarked.push({ ...m, _bench: { loadMs, tokensPerSec: parseFloat(tokensPerSec.toFixed(1)) } });
    } catch (err) {
      log.err(`Echec : ${err.message}`);
      const keep = await prompt('  Conserver quand meme ce modele ? (y/N) : ');
      if (keep.toLowerCase() === 'y') benchmarked.push(m);
    }
  }
  await stopLlamaServer();
  return benchmarked;
}

// --- Etape 7 : recap et register ---
async function stepRegister(config, models, gpu) {
  log.title('7. Recap + enregistrement');

  console.log(`  Wallet         : ${config.chiaWalletAddress}`);
  console.log(`  GPU            : ${gpu.model} (${gpu.vramGb} Go)`);
  console.log(`  Backend        : ${config.platformUrl}`);
  console.log(`  Payout         : ${config.payoutPreference || 'XCH'}`);
  console.log(`  Modeles (${models.length}) :`);
  for (const m of models) {
    let line = `    · ${m.name.padEnd(30)} $${m.rateUsdPerHour.toFixed(2)}/h`;
    if (m._bench) line += ` (${m._bench.tokensPerSec} tok/s)`;
    console.log(line);
  }
  console.log('');

  const confirm = await prompt(`${c.bold}Enregistrer ce GPU sur la plateforme ? (Y/n) : ${c.reset}`);
  if (confirm.toLowerCase() === 'n') {
    log.warn('Abandonne — config sauvegardee localement');
    saveConfig(config);
    return null;
  }

  const cleanModels = models.map(({ _bench, ...m }) => ({
    ...m,
    ...(_bench
      ? {
          benchmark: {
            tokensPerSec: _bench.tokensPerSec,
            latencyMs: _bench.loadMs ?? _bench.latencyMs,
            measuredAt: new Date().toISOString(),
            source: 'provider-wizard',
          },
        }
      : {}),
  }));

  try {
    const { data } = await axios.post(
      `${config.platformUrl}/api/gpus/register`,
      {
        gpuModel: gpu.model,
        vramGb: gpu.vramGb,
        availableModels: cleanModels,
        ratePerHourUsd: isPoolMode(config)
          ? config._pendingPool.ratePerHourUsd
          : (cleanModels[0]?.rateUsdPerHour || 0.40),
        payoutPreference: config.payoutPreference || 'XCH',
        tunnelUrl: null,  // sera mis a jour au 1er launch
      },
      { headers: { Authorization: `Bearer ${config.authToken}` } },
    );
    log.ok(`Enregistre ! GPU ID = ${c.cyan}${data.gpu.id}${c.reset}`);
    config.gpuId = data.gpu.id;
    saveConfig(config);
    return data.gpu.id;
  } catch (err) {
    log.err(`Register : ${err.response?.data?.error || err.message}`);
    log.info('Config sauvegardee, tu peux retenter avec npm run wizard');
    saveConfig(config);
    return null;
  }
}

// --- Main ---
async function main() {
  console.log(`\n${c.bold}${c.cyan}╭──────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.cyan}│  GPU Rental — Provider Setup Wizard      │${c.reset}`);
  console.log(`${c.bold}${c.cyan}╰──────────────────────────────────────────╯${c.reset}`);

  const config = loadOrCreateConfig();
  const env = await stepEnvironment();
  const gpu = await stepChooseGpu(env.gpus);
  const llamaPath = await stepLlamaPath(env.llama, config.llamaCppPath);
  config.llamaCppPath = llamaPath;
  config.localLlamaPort = env.port || config.localLlamaPort || 8080;

  log.title('4. Payout');
  const payout = await prompt(`Devise reception (XCH/BYC) [${config.payoutPreference || 'XCH'}] : `);
  if (payout) config.payoutPreference = payout.toUpperCase();
  else config.payoutPreference = config.payoutPreference || 'XCH';

  await askServingModeEarly({ config, ask: prompt, log });
  saveConfig(config);
  let poolMode = isPoolMode(config);
  const poolRate = config._pendingPool?.ratePerHourUsd ?? 0.4;

  const models = await stepModels(config.models || [], { poolMode, poolRate });
  if (models.length === 0) {
    log.err('Au moins 1 modele requis');
    process.exit(1);
  }
  config.models = models;

  if (poolMode && config._pendingPool) {
    log.title('4b. Verification pool — SHA256');
    log.info('Calcul du hash (peut prendre 1–2 min)…');
    const verified = await runPoolJoinFlow({
      config,
      models,
      gpuId: null,
      authToken: null,
      platformUrl: config.platformUrl,
      ask: prompt,
      log,
      pool: config._pendingPool,
      skipApiJoin: true,
    });
    if (!verified) {
      log.err('SHA256 refuse — mode solo pour la suite.');
      poolMode = false;
      delete config.poolMembership;
      config.servingMode = 'solo';
    }
  }
  saveConfig(config);

  await stepAuth(config);
  saveConfig(config);

  let benchedModels = await stepBenchmark(config, models);
  if (!poolMode) {
    benchedModels = await stepAdjustRates(benchedModels);
  }
  config.models = benchedModels.map(({ _bench, ...rest }) => rest);
  saveConfig(config);

  const gpuId = await stepRegister(config, benchedModels, gpu);

  if (gpuId && isPoolMode(config)) {
    log.title('10. Pool — verification SHA256');
    await finalizePoolJoin({
      config,
      models: config.models,
      gpuId,
      authToken: config.authToken,
      platformUrl: config.platformUrl,
      ask: prompt,
      log,
    });
    saveConfig(config);
  }

  log.title('Done');
  log.ok(`Config saved: ${configPath}`);
  if (config.poolMembership) {
    log.ok(`Pool #${config.poolMembership.poolNumber} — SHA256 verified`);
  } else {
    log.info('Solo mode — GPU listed in public catalog');
  }
  log.info('Start the agent: npm start');
  rl.close();
}

main().catch(err => {
  console.error(`\n${c.red}Erreur fatale :${c.reset}`, err.response?.data || err.message);
  rl.close();
  process.exit(1);
});
