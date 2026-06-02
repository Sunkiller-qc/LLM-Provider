#!/usr/bin/env node
// src/wizard.js
// Full interactive setup: GPU detection, .bat folder scan, port tests,
// pre-benchmark, wallet auth, backend register.
//
// Usage: npm run wizard

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
import { runPoolSetupStep } from './pool-setup.js';

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

/** Adjust rates after tok/s measurement */
async function stepAdjustRates(models) {
  const withBench = models.filter(m => m._bench?.tokensPerSec);
  if (withBench.length === 0) return models;

  log.title('6b. Rates (based on benchmark)');
  console.log('Adjust your $/h prices if needed (equivalent $/M tokens).\n');

  for (const m of withBench) {
    printRateHints(m._bench.tokensPerSec, log);
    const raw = await prompt(
      `  ${m.name} — USD/h rate [${(m.rateUsdPerHour ?? 0.4).toFixed(2)}]: `,
    );
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0) m.rateUsdPerHour = n;
    }
  }
  return models;
}

// --- Step 1: environment detection ---
async function stepEnvironment() {
  log.title('1. Detecting your environment');

  // GPUs
  let gpus;
  try {
    gpus = await detectAllGpus();
    for (const g of gpus) {
      log.ok(`GPU #${g.index}: ${c.bold}${g.model}${c.reset} (${g.vramGb} GB VRAM)`);
    }
  } catch (err) {
    log.err(err.message);
    log.info('Verify that NVIDIA drivers are installed (nvidia-smi)');
    process.exit(1);
  }

  // llama-server
  const llama = await detectLlamaServer();
  if (llama.ok) log.ok(`llama-server: ${llama.path}`);
  else log.warn(`llama-server: ${llama.error} (you will be asked for the path later)`);

  // cloudflared
  const cf = await detectCloudflared();
  if (cf.ok) log.ok(`cloudflared: ${cf.version}`);
  else log.warn(`cloudflared: ${cf.error}`);

  // free port
  const port = await findFreePort(8080);
  if (port) log.ok(`Free port detected: ${port}`);
  else log.warn('No free port in 8080-8129');

  return { gpus, llama, cloudflared: cf, port };
}

// --- Step 2: choose GPU if multiple ---
async function stepChooseGpu(gpus) {
  if (gpus.length === 1) return gpus[0];
  log.title(`2. You have ${gpus.length} GPUs detected`);
  for (const g of gpus) {
    console.log(`  [${g.index}] ${g.model} ${g.vramGb} GB`);
  }
  const idx = await prompt(`Which GPU to rent? (index, default 0): `);
  const chosen = gpus[parseInt(idx) || 0] || gpus[0];
  log.ok(`Chosen: GPU #${chosen.index} ${chosen.model}`);
  return chosen;
}

// --- Step 3: llama-server path ---
async function stepLlamaPath(llama, existingPath) {
  log.title('3. Path to llama-server');
  let p = llama.ok ? llama.path : existingPath;
  if (p) {
    const accept = await prompt(`Detected: ${p}\nOK? (Y/n): `);
    if (accept.toLowerCase() !== 'n') return p;
  }
  while (true) {
    p = await prompt('Full path to llama-server (.exe on Windows): ');
    if (fs.existsSync(p)) {
      log.ok(`Found: ${p}`);
      return p;
    }
    log.err('File not found, try again');
  }
}

// --- Step 4: model discovery ---
async function stepModels(existingModels = []) {
  log.title('4. Your models');
  console.log('You have 2 options:');
  console.log(`  [a] ${c.bold}Scan a folder of .bat${c.reset} (fast if you already have launchers)`);
  console.log(`  [b] ${c.bold}Add manually${c.reset} (GGUF path + name)\n`);
  const choice = await prompt('Choice (a/b, default a): ');

  if (choice.toLowerCase() === 'b') {
    return stepModelsManual(existingModels);
  }
  return stepModelsScan(existingModels);
}

async function stepModelsScan(existingModels) {
  const folder = await prompt('Folder containing your .bat/.sh: ');
  const scan = scanLaunchScripts(folder);
  if (!scan.ok) {
    log.err(scan.error);
    return stepModels(existingModels);
  }
  log.info(`${scan.scripts} script(s) found in ${folder}`);
  for (const w of scan.warnings) log.warn(w);
  if (scan.detected.length === 0) {
    log.warn('No models detected (no --model in scripts)');
    return stepModelsManual(existingModels);
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
    console.log(`    path  : ${m.path} (${validation.sizeGb} GB)`);
    console.log(`    ctx   : ${m.ctx} · ngl : ${m.nGpuLayers}`);

    const rate = await promptRateForModel(`    USD/h rate for this model [0.40]: `, null);
    accepted.push({
      name: m.name,
      path: m.path,
      ctx: m.ctx,
      nGpuLayers: m.nGpuLayers,
      rateUsdPerHour: rate,
    });
    log.ok(`Added: ${m.name} at $${(parseFloat(rate) || 0.40).toFixed(2)}/h`);
  }
  return accepted;
}

async function stepModelsManual(existingModels) {
  const models = [...existingModels];
  while (true) {
    console.log('');
    if (models.length > 0) {
      log.info(`${models.length} model(s) already added: ${models.map(m => m.name).join(', ')}`);
    }
    const add = await prompt('Add a model? (Y/n): ');
    if (add.toLowerCase() === 'n') break;

    const modelPath = await prompt('  GGUF file path: ');
    const validation = validateModelFile(modelPath);
    if (!validation.ok) {
      log.err(validation.error);
      continue;
    }
    const name = await prompt(`  Display name [${path.basename(modelPath, '.gguf')}]: `)
      || path.basename(modelPath, '.gguf');
    const ctx = await prompt('  Context size [8192]: ');
    const ngl = await prompt('  N gpu layers [99]: ');
    const rate = await promptRateForModel('  USD/h rate [0.40]: ', null);

    models.push({
      name,
      path: modelPath,
      ctx: parseInt(ctx) || 8192,
      nGpuLayers: parseInt(ngl) || 99,
      rateUsdPerHour: rate,
    });
    log.ok(`${name} (${validation.sizeGb} GB) at $${parseFloat(rate || 0.40).toFixed(2)}/h`);
  }
  return models;
}

// --- Step 5: wallet auth ---
async function stepAuth(config) {
  log.title('5. Chia wallet authentication');

  const platformUrl = (await prompt(`Backend URL [${config.platformUrl || 'http://localhost:3001'}]: `))
    || config.platformUrl || 'http://localhost:3001';
  config.platformUrl = platformUrl;

  if (config.authToken) {
    try {
      const payload = JSON.parse(Buffer.from(config.authToken.split('.')[1], 'base64url').toString('utf8'));
      if (payload?.exp && payload.exp * 1000 > Date.now()) {
        const reuse = await prompt(`Token already present (wallet ${payload.walletAddress}). Reuse? (Y/n): `);
        if (reuse.toLowerCase() !== 'n') {
          log.ok('Existing token valid');
          return config;
        }
      }
    } catch (_) {}
  }

  const walletAddress = (await prompt(`Your Chia address (xch1...) [${config.chiaWalletAddress || ''}]: `))
    || config.chiaWalletAddress;
  if (!walletAddress || !walletAddress.startsWith('xch1')) {
    log.err('Invalid address');
    process.exit(1);
  }
  config.chiaWalletAddress = walletAddress;

  log.info('Requesting challenge...');
  let challenge;
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/challenge`, { walletAddress });
    challenge = data.challenge;
    log.ok(`Challenge received (expires in ${Math.round(data.ttlMs / 60000)} min)`);
  } catch (err) {
    log.err(`Auth challenge: ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }

  console.log('\n  Sign this challenge with your Sage / chia CLI wallet:');
  console.log(`  ${c.cyan}${challenge}${c.reset}\n`);
  console.log('  Sage: open the console (Ctrl+Shift+I) or use the /provider/setup page');
  console.log('  Chia CLI: chia keys sign --message <above> ...\n');

  const pubkey = await prompt('  Pubkey (hex 48 bytes = 96 chars): ');
  const signature = await prompt('  Signature (hex 96 bytes = 192 chars): ');

  log.info('Verifying...');
  try {
    const { data } = await axios.post(`${platformUrl}/api/auth/verify`, {
      walletAddress, pubkey, signature, scheme: 'chip-0002',
    });
    config.authToken = data.token;
    log.ok(`JWT received for ${data.user.walletAddress}`);
  } catch (err) {
    log.err(`Verify: ${err.response?.data?.error || err.message}`);
    process.exit(1);
  }
  return config;
}

// --- Step 6: pre-benchmark each model ---
async function stepBenchmark(config, models) {
  log.title('6. Pre-benchmark (measure tokens/s)');
  console.log('Each model will be loaded once to measure startup and throughput.\n');

  const skip = await prompt('Skip pre-benchmark (faster)? (y/N): ');
  if (skip.toLowerCase() === 'y') {
    log.info('Skipped — backend will run a full benchmark on register');
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
      log.ok(`Load: ${(loadMs / 1000).toFixed(1)}s · Throughput: ${tokensPerSec.toFixed(1)} tok/s`);
      benchmarked.push({ ...m, _bench: { loadMs, tokensPerSec: parseFloat(tokensPerSec.toFixed(1)) } });
    } catch (err) {
      log.err(`Failed: ${err.message}`);
      const keep = await prompt('  Keep this model anyway? (y/N): ');
      if (keep.toLowerCase() === 'y') benchmarked.push(m);
    }
  }
  await stopLlamaServer();
  return benchmarked;
}

// --- Step 7: recap and register ---
async function stepRegister(config, models, gpu) {
  log.title('7. Recap + registration');

  console.log(`  Wallet         : ${config.chiaWalletAddress}`);
  console.log(`  GPU            : ${gpu.model} (${gpu.vramGb} GB)`);
  console.log(`  Backend        : ${config.platformUrl}`);
  console.log(`  Payout         : ${config.payoutPreference || 'XCH'}`);
  console.log(`  Models (${models.length}):`);
  for (const m of models) {
    let line = `    · ${m.name.padEnd(30)} $${m.rateUsdPerHour.toFixed(2)}/h`;
    if (m._bench) line += ` (${m._bench.tokensPerSec} tok/s)`;
    console.log(line);
  }
  console.log('');

  const confirm = await prompt(`${c.bold}Register this GPU on the platform? (Y/n): ${c.reset}`);
  if (confirm.toLowerCase() === 'n') {
    log.warn('Aborted — config saved locally');
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
        ratePerHourUsd: cleanModels[0]?.rateUsdPerHour || 0.40,  // reference rate (first one)
        payoutPreference: config.payoutPreference || 'XCH',
        tunnelUrl: null,  // updated on first launch
      },
      { headers: { Authorization: `Bearer ${config.authToken}` } },
    );
    log.ok(`Registered! GPU ID = ${c.cyan}${data.gpu.id}${c.reset}`);
    config.gpuId = data.gpu.id;
    saveConfig(config);
    return data.gpu.id;
  } catch (err) {
    log.err(`Register: ${err.response?.data?.error || err.message}`);
    log.info('Config saved, you can retry with npm run wizard');
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

  log.title('Payout');
  const payout = await prompt(`Payout currency (XCH/BYC) [${config.payoutPreference || 'XCH'}]: `);
  if (payout) config.payoutPreference = payout.toUpperCase();
  else config.payoutPreference = config.payoutPreference || 'XCH';

  const models = await stepModels(config.models || []);
  if (models.length === 0) {
    log.err('At least 1 model required');
    process.exit(1);
  }
  config.models = models;
  saveConfig(config);

  await stepAuth(config);
  saveConfig(config);

  let benchedModels = await stepBenchmark(config, models);
  benchedModels = await stepAdjustRates(benchedModels);
  config.models = benchedModels.map(({ _bench, ...rest }) => rest);
  saveConfig(config);

  const gpuId = await stepRegister(config, benchedModels, gpu);

  if (gpuId) {
    log.title('8. Serving mode');
    await runPoolSetupStep({
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
  console.error(`\n${c.red}Fatal error:${c.reset}`, err.response?.data || err.message);
  rl.close();
  process.exit(1);
});
