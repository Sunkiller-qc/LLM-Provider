#!/usr/bin/env node
// src/auto-setup.js
// Ultra-simplified auto-setup: detects GPU + llama-server + disk scan for
// .gguf + suggests rates. The user only answers 2-3 questions:
//   - Their Chia address
//   - Where their models are (if not found automatically)
//   - The JWT obtained by signing on the frontend
//
// Usage: npm run setup-auto (or install.bat on Windows)

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { detectAllGpus } from './gpu-monitor.js';
import { detectLlamaServer, detectCloudflared, findFreePort, scanLaunchScripts } from './detect.js';
import { ensureModelLoaded, stopLlamaServer, getCurrentPort } from './llama-manager.js';
import { runPoolSetupStep } from './pool-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function title(s) { console.log(`\n${c.bold}${c.cyan}=== ${s} ===${c.reset}`); }
function ok(s) { console.log(`  ${c.green}✓${c.reset} ${s}`); }
function info(s) { console.log(`  ${c.dim}·${c.reset} ${s}`); }
function warn(s) { console.log(`  ${c.yellow}⚠${c.reset} ${s}`); }
function step(s) { console.log(`\n${c.bold}${c.magenta}▶ ${s}${c.reset}`); }

// === Suggested rates based on model size ===
function suggestRate(filename) {
  const lower = filename.toLowerCase();
  // Look for a pattern like "8B", "30B", "70B" in the name
  const match = lower.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return 0.30;
  const size = parseFloat(match[1]);
  if (size < 5) return 0.10;       // <5B (tiny)
  if (size < 15) return 0.20;      // 7B-13B
  if (size < 40) return 0.50;      // 14B-35B
  if (size < 80) return 1.00;      // 70B
  return 2.00;                     // 100B+
}

// === Recursive scan for .gguf ===
function findGgufFiles(roots, maxDepth = 3) {
  const found = [];
  const visited = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        try {
          const stat = fs.statSync(p);
          const sizeGb = stat.size / (1024 ** 3);
          if (sizeGb > 0.1) found.push({ path: p, sizeGb: parseFloat(sizeGb.toFixed(2)) });
        } catch (_) {}
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(p, depth + 1);
      }
    }
  }

  for (const r of roots) {
    if (fs.existsSync(r)) walk(r, 0);
  }
  return found;
}

function standardSearchRoots() {
  const home = os.homedir();
  return [
    path.join(home, 'models'),
    path.join(home, 'Downloads', 'models'),
    path.join(home, 'Documents', 'models'),
    path.join(home, 'Desktop', 'models'),
    'C:\\models',
    'C:\\llama',
    'C:\\llama.cpp\\models',
    'D:\\models',
    'D:\\llama',
    '/opt/models',
    '/home/models',
  ].filter((p, i, arr) => arr.indexOf(p) === i);  // dedup
}

// === Decode JWT to extract walletAddress ===
function decodeJwtAddress(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.walletAddress || null;
  } catch (_) { return null; }
}

function loadOrCreateConfig() {
  if (fs.existsSync(configPath)) {
    info(`Existing config.json found, will enrich it`);
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  // No existing config: start from empty object (NOT the example
  // which contains fake C:\models\qwen3... models)
  return {
    platformUrl: 'http://localhost:3001',
    localLlamaPort: 8080,
    models: [],
    payoutPreference: 'XCH',
  };
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function main() {
  console.log('');
  console.log(`${c.bold}${c.cyan}╭────────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.cyan}│  GPU Rental — Auto Setup (Windows-friendly)│${c.reset}`);
  console.log(`${c.bold}${c.cyan}╰────────────────────────────────────────────╯${c.reset}`);

  const config = loadOrCreateConfig();

  // === 1. Environment detection (silent, display only) ===
  title('1. Automatic detection');

  let gpus;
  try {
    gpus = await detectAllGpus();
    for (const g of gpus) {
      ok(`GPU #${g.index}: ${c.bold}${g.model}${c.reset} (${g.vramGb} GB)`);
    }
  } catch (err) {
    console.log(`  ${c.red}✗${c.reset} No NVIDIA GPU detected`);
    console.log(`  ${c.dim}${err.message}${c.reset}`);
    console.log(`\n  ${c.yellow}Install NVIDIA drivers then re-run this script${c.reset}`);
    rl.close();
    process.exit(1);
  }

  // llama-server
  const llama = await detectLlamaServer(config.llamaCppPath);
  if (llama.ok) {
    ok(`llama-server: ${llama.path}`);
    config.llamaCppPath = llama.path;
  } else {
    warn(`llama-server not found in PATH`);
    info(`Download llama.cpp with CUDA: https://github.com/ggerganov/llama.cpp/releases`);
    info(`Place llama-server.exe somewhere and re-run this script`);

    const customPath = await ask(`\n  Or paste the path now (or Enter to skip): `);
    if (customPath) {
      if (fs.existsSync(customPath)) {
        ok(`llama-server: ${customPath}`);
        config.llamaCppPath = customPath;
      } else {
        warn(`File not found, you can edit config.json later`);
      }
    }
  }

  // cloudflared (OPTIONAL)
  const cf = await detectCloudflared();
  if (cf.ok) {
    ok(`cloudflared: ${cf.version.split('\n')[0]} (optional, used for debug)`);
  } else {
    info(`cloudflared not installed — OK, it's optional`);
    info(`(client<->agent routing goes through WebSocket, no public IP needed)`);
  }

  // Free port
  const port = await findFreePort(8080);
  if (port) {
    ok(`Free port detected: ${port}`);
    config.localLlamaPort = port;
  } else {
    warn(`No free port between 8080 and 8129`);
    config.localLlamaPort = 8080;
  }

  // === 2. Your existing .bat scripts (recommended mode) ===
  title('2. Your startup scripts (.bat / .sh)');
  info(`If you already have .bat files that launch llama-server with your settings,`);
  info(`we can use them directly (simplest option).`);

  const batDir = await ask(`\n  Folder containing your .bat (Enter to skip, direct .gguf mode next): `);
  let chosen = [];

  if (batDir) {
    const scan = scanLaunchScripts(batDir);
    if (!scan.ok) {
      warn(scan.error);
    } else if (scan.detected.length === 0) {
      warn(`No .bat with --model found in ${batDir}`);
    } else {
      ok(`${scan.detected.length} script(s) detected:\n`);
      scan.detected.forEach((s, i) => {
        const rate = suggestRate(s.name);
        const ok_marker = s.modelExists ? c.green + '✓' + c.reset : c.yellow + '?' + c.reset;
        console.log(`    [${i}] ${ok_marker} ${c.bold}${s.name}${c.reset}`);
        console.log(`        script : ${s.scriptPath}`);
        console.log(`        model  : ${s.path}${s.modelExists ? '' : c.yellow + ' (not found, but the .bat may locate it)' + c.reset}`);
        console.log(`        ctx ${s.ctx} · ngl ${s.nGpuLayers}${s.port ? ` · port ${s.port}` : ''}`);
        console.log(`        suggested rate ${c.green}$${rate.toFixed(2)}/h${c.reset}`);
      });

      console.log('');
      const sel = await ask(`  Which to rent? ("all", "0,1,3", Enter to skip): `);
      let indices = [];
      if (sel.toLowerCase() === 'all') indices = scan.detected.map((_, i) => i);
      else if (sel) indices = sel.split(',').map(s => parseInt(s.trim())).filter(i => !isNaN(i) && i >= 0 && i < scan.detected.length);

      for (const i of indices) {
        const s = scan.detected[i];
        const suggested = suggestRate(s.name);
        const customRate = await ask(`    $/h rate for ${s.name} [${suggested.toFixed(2)}]: `);
        chosen.push({
          name: s.name,
          scriptPath: s.scriptPath,
          port: s.port,
          rateUsdPerHour: parseFloat(customRate) || suggested,
        });
      }
      if (chosen.length > 0) ok(`${chosen.length} model(s) via .bat`);
    }
  }

  // === 3. Direct .gguf mode (fallback if no .bat) ===
  if (chosen.length === 0) {
    title('3. OR: your .gguf files directly');
    info(`Scanning ~/models, C:\\models, Downloads, etc.`);

  let ggufs = findGgufFiles(standardSearchRoots());
  let chosen = [];

  // Loop to add more folders to scan
  while (true) {
    if (ggufs.length === 0) {
      warn(`No .gguf found in current folders`);
    } else {
      ok(`${ggufs.length} model(s) found:\n`);
      ggufs.forEach((g, i) => {
        const name = path.basename(g.path, '.gguf');
        const rate = suggestRate(name);
        console.log(`    [${i}] ${c.bold}${name}${c.reset}`);
        console.log(`        ${g.path}`);
        console.log(`        ${g.sizeGb} GB · suggested rate ${c.green}$${rate.toFixed(2)}/h${c.reset}`);
      });
    }

    console.log('');
    console.log(`  ${c.bold}Options:${c.reset}`);
    console.log(`    · Type ${c.cyan}all${c.reset} to select all models`);
    console.log(`    · Type ${c.cyan}0,1,3${c.reset} to select by index`);
    console.log(`    · Type ${c.cyan}+${c.reset} to scan another folder`);
    console.log(`    · Type ${c.cyan}m${c.reset} to add a model manually (direct path)`);
    console.log(`    · Enter to finish`);
    const sel = (await ask(`\n  Choice: `)).trim();

    if (!sel) break;

    if (sel === '+') {
      const newDir = await ask(`  Folder path to scan: `);
      if (newDir) {
        const newGgufs = findGgufFiles([newDir], 5);
        if (newGgufs.length === 0) {
          warn(`No .gguf found in ${newDir}`);
        } else {
          ok(`+${newGgufs.length} model(s) added to list`);
          // Dedup
          const knownPaths = new Set(ggufs.map(g => g.path));
          for (const g of newGgufs) {
            if (!knownPaths.has(g.path)) ggufs.push(g);
          }
        }
      }
      continue;
    }

    if (sel === 'm') {
      const modelPath = await ask(`  Full path to .gguf: `);
      if (!modelPath || !fs.existsSync(modelPath)) {
        warn(`File not found: ${modelPath}`);
        continue;
      }
      const name = (await ask(`  Display name [${path.basename(modelPath, '.gguf')}]: `))
        || path.basename(modelPath, '.gguf');
      const suggested = suggestRate(name);
      const rate = await ask(`  $/h rate [${suggested.toFixed(2)}]: `);
      const ctx = await ask(`  Context [8192]: `);
      chosen.push({
        name,
        path: modelPath,
        ctx: parseInt(ctx) || 8192,
        nGpuLayers: 99,
        rateUsdPerHour: parseFloat(rate) || suggested,
      });
      ok(`Added: ${name} at $${(parseFloat(rate) || suggested).toFixed(2)}/h`);
      continue;
    }

    // Otherwise: selection by indices
    let indices = [];
    if (sel.toLowerCase() === 'all') {
      indices = ggufs.map((_, i) => i);
    } else {
      indices = sel.split(',').map(s => parseInt(s.trim())).filter(i => !isNaN(i) && i >= 0 && i < ggufs.length);
    }

    if (indices.length === 0) {
      warn(`Invalid indices`);
      continue;
    }

    for (const i of indices) {
      const g = ggufs[i];
      const name = path.basename(g.path, '.gguf');
      // Skip if already chosen
      if (chosen.find(m => m.path === g.path)) continue;
      const suggested = suggestRate(name);
      const customRate = await ask(`    $/h rate for ${name} [${suggested.toFixed(2)}]: `);
      const ctx = name.toLowerCase().includes('32k') ? 32768
        : name.toLowerCase().includes('16k') ? 16384
        : name.toLowerCase().includes('128k') ? 131072
        : 8192;
      chosen.push({
        name,
        path: g.path,
        ctx,
        nGpuLayers: 99,
        rateUsdPerHour: parseFloat(customRate) || suggested,
      });
    }
    ok(`${chosen.length} model(s) selected in total`);

    const more = await ask(`\n  Add more models? (y/N): `);
    if (more.toLowerCase() !== 'y') break;
  }

  }  // end of direct GGUF fallback

  if (chosen.length === 0) {
    console.log('');
    warn(`No models selected! The agent won't be able to do anything.`);
    warn(`You can add them later via the dashboard /dashboard.`);
    const confirm = await ask(`\n  Continue anyway with 0 models? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('  Setup interrupted. Re-run install.bat to try again.');
      rl.close();
      process.exit(1);
    }
  }
  config.models = chosen;  // always replace, never inherit

  // === 3. Chia address ===
  title('3. Your Chia address (xch1...)');
  info(`This is the address that will receive your payments`);
  info(`Find it in Sage Wallet > "Receive" tab`);

  let walletAddress = config.chiaWalletAddress;
  while (true) {
    const a = await ask(`\n  Chia address [${walletAddress || ''}]: `);
    walletAddress = a || walletAddress;
    if (walletAddress?.startsWith('xch1') && walletAddress.length >= 32) break;
    console.log(`  ${c.red}Invalid address${c.reset} (must start with xch1)`);
  }
  config.chiaWalletAddress = walletAddress;

  // === 4. JWT - simplified flow ===
  title('4. Authentication (sign once in Sage)');

  const platformUrl = config.platformUrl || (await ask(`\n  Backend URL [http://localhost:3001]: `)) || 'http://localhost:3001';
  config.platformUrl = platformUrl;

  console.log('');
  console.log(`  ${c.bold}Quick method (recommended):${c.reset}`);
  console.log(`  1. Go to ${c.cyan}${platformUrl.replace(':3001', ':3000')}${c.reset} in your browser`);
  console.log(`  2. Click ${c.bold}"Connect Sage"${c.reset} and sign`);
  console.log(`  3. Once connected, open the console (F12) and type:`);
  console.log(`     ${c.dim}localStorage.getItem('gpu-rental-jwt')${c.reset}`);
  console.log(`  4. Copy the token (without quotes) and paste it below`);
  console.log('');

  let authToken = '';
  while (!authToken) {
    authToken = await ask(`  JWT token: `);
    if (!authToken) continue;
    // Verify token looks valid
    const decoded = decodeJwtAddress(authToken);
    if (!decoded) {
      console.log(`  ${c.red}Invalid token${c.reset} (not a decodable JWT)`);
      authToken = '';
      continue;
    }
    if (decoded !== walletAddress) {
      console.log(`  ${c.yellow}⚠ Token is for ${decoded} but you provided ${walletAddress}${c.reset}`);
      const confirm = await ask(`  Continue anyway? (y/N): `);
      if (confirm.toLowerCase() !== 'y') { authToken = ''; continue; }
    }
    config.authToken = authToken;
    ok(`Valid JWT`);
  }

  // === 5. Payout preference ===
  title('5. Payout currency');
  const payout = await ask(`\n  Receive in XCH or BYC? [XCH]: `);
  config.payoutPreference = (payout || 'XCH').toUpperCase();
  if (!['XCH', 'BYC'].includes(config.payoutPreference)) config.payoutPreference = 'XCH';

  saveConfig(config);

  // === 6. Benchmark each model ===
  if (chosen.length > 0) {
    title('6. Benchmark your models');
    info('Each .bat will be launched one at a time to measure tokens/s + cold-start.');
    info(`Estimated duration: ~1-2 min per model (VRAM load + 1 short prompt).`);
    const skipBench = await ask(`\n  Skip benchmark (not recommended)? (y/N): `);

    if (skipBench.toLowerCase() !== 'y') {
      const VALIDATION_PROMPT = 'Reply with exactly these words and nothing else: GPU rental test ok';
      const BENCH_PROMPT = 'Write a 200-word paragraph about clouds, weather and rain. Be detailed.';

      for (let i = 0; i < chosen.length; i++) {
        const m = chosen[i];
        console.log(`\n  [${i + 1}/${chosen.length}] ${c.bold}${m.name}${c.reset}`);
        try {
          const t0 = Date.now();
          await ensureModelLoaded(config, m.name);
          const tLoaded = Date.now();
          ok(`Model loaded in ${((tLoaded - t0) / 1000).toFixed(1)}s`);

          const port = getCurrentPort();

          // Step 1: short warm-up to amortize first prompt (warm cache)
          info(`Warm-up...`);
          try {
            await axios.post(
              `http://127.0.0.1:${port}/v1/chat/completions`,
              {
                model: m.name,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 8,
                temperature: 0,
                stream: false,
              },
              { timeout: 60_000 },
            );
          } catch (_) { /* warm-up failure OK, continue */ }

          // Step 2: measure tokens/s at steady state (200 tokens generated)
          info(`Measuring tokens/s (200 tokens)...`);
          const tMeasure0 = Date.now();
          const resBench = await axios.post(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            {
              model: m.name,
              messages: [{ role: 'user', content: BENCH_PROMPT }],
              max_tokens: 200,
              temperature: 0.3,  // a bit of variation to avoid overly short patterns
              stream: false,
            },
            { timeout: 120_000 },
          );
          const tMeasure1 = Date.now();
          const totalTokens = resBench.data?.usage?.completion_tokens
            || resBench.data?.choices?.[0]?.message?.content?.split(/\s+/).length
            || 0;
          const inferenceMs = tMeasure1 - tMeasure0;
          const tokensPerSec = totalTokens / (inferenceMs / 1000);

          // Step 3: correct response validation (anti-fake-GPU)
          info(`Validation test...`);
          const resValid = await axios.post(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            {
              model: m.name,
              messages: [{ role: 'user', content: VALIDATION_PROMPT }],
              max_tokens: 20,
              temperature: 0,
              stream: false,
            },
            { timeout: 30_000 },
          );
          const validText = resValid.data?.choices?.[0]?.message?.content || '';
          const passed = tokensPerSec >= 5 && validText.toLowerCase().includes('gpu rental test ok');

          m.benchmark = {
            tokensPerSec: parseFloat(tokensPerSec.toFixed(1)),
            loadTimeMs: tLoaded - t0,
            inferenceMs,
            totalTokens,
            validationResponse: validText.slice(0, 100),
            timestamp: new Date().toISOString(),
            passed,
          };
          const status = passed ? c.green + '✓' : c.yellow + '?';
          ok(`${m.benchmark.tokensPerSec} tok/s on ${totalTokens} tokens · cold-start ${((tLoaded - t0) / 1000).toFixed(1)}s ${status}${c.reset}`);
        } catch (err) {
          warn(`Failed: ${err.message}`);
          m.benchmark = { passed: false, error: err.message, timestamp: new Date().toISOString() };
        }
      }

      info('\n  Freeing VRAM...');
      await stopLlamaServer();
      ok('VRAM freed, benchmarks saved');
    }
  }

  config.models = chosen;
  saveConfig(config);

  // === 7. Register on backend ===
  title('7. Platform registration');
  try {
    const ratePerHourUsd = Math.max(...chosen.map(m => m.rateUsdPerHour || 0), 0.30);
    const { data: registration } = await axios.post(
      `${config.platformUrl}/api/gpus/register`,
      {
        gpuModel: gpus[0].model,
        vramGb: gpus[0].vramGb,
        availableModels: chosen,  // includes benchmarks
        ratePerHourUsd,
        payoutPreference: config.payoutPreference,
        tunnelUrl: null,
      },
      { headers: { Authorization: `Bearer ${config.authToken}` } },
    );
    config.gpuId = registration.gpu.id;
    saveConfig(config);
    ok(`Registered! GPU ID = ${c.cyan}${registration.gpu.id}${c.reset}`);
    info(`Status: ${c.yellow}offline${c.reset} (will become "online" when you run start.bat)`);
  } catch (err) {
    warn(`Registration failed: ${err.response?.data?.error || err.message}`);
    warn('You can re-run install.bat later, or registration happens on first start.bat.');
  }

  // === 8. Solo or pool ===
  const poolLog = {
    title,
    ok,
    warn,
    err: (s) => console.log(`  ${c.red}✗${c.reset} ${s}`),
    info,
  };
  await runPoolSetupStep({
    config,
    models: chosen,
    gpuId: config.gpuId,
    authToken: config.authToken,
    platformUrl: config.platformUrl,
    ask,
    log: poolLog,
  });
  saveConfig(config);

  // === Summary ===
  console.log('');
  console.log(`${c.bold}${c.green}╭────────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.green}│  Setup complete!                           │${c.reset}`);
  console.log(`${c.bold}${c.green}╰────────────────────────────────────────────╯${c.reset}`);
  console.log('');
  console.log(`  Wallet         : ${config.chiaWalletAddress}`);
  console.log(`  Backend        : ${config.platformUrl}`);
  console.log(`  Payout         : ${config.payoutPreference}`);
  console.log(`  GPU            : ${gpus[0].model} (${gpus[0].vramGb} GB)`);
  console.log(`  llama-server   : ${config.llamaCppPath || c.yellow + 'configure in config.json' + c.reset}`);
  console.log(`  Models (${chosen.length}):`);
  for (const m of chosen) {
    const benchInfo = m.benchmark?.passed
      ? `${c.green}${m.benchmark.tokensPerSec} tok/s ✓${c.reset}`
      : m.benchmark
        ? `${c.yellow}bench failed${c.reset}`
        : `${c.dim}not benchmarked${c.reset}`;
    console.log(`    · ${m.name.padEnd(35)} ${c.green}$${m.rateUsdPerHour.toFixed(2)}/h${c.reset} · ${benchInfo}`);
  }
  console.log('');
  console.log(`  Config saved: ${c.dim}${configPath}${c.reset}`);
  if (config.gpuId) {
    console.log(`  GPU registered, ID: ${c.cyan}${config.gpuId}${c.reset}`);
    console.log(`  Status             : ${c.yellow}offline${c.reset}`);
  }
  if (config.poolMembership) {
    console.log(`  Pool               : ${c.cyan}#${config.poolMembership.poolNumber}${c.reset} (SHA256 verified)`);
  } else {
    console.log(`  Serving mode       : ${c.cyan}solo${c.reset}`);
  }
  console.log('');
  step(`To activate your GPU on the site: double-click ${c.cyan}start.bat${c.reset}`);
  step(`To take it offline: Ctrl+C in the start.bat window`);
  console.log('');
  step(`To edit your config later:`);
  console.log(`  · Quick: edit ${c.cyan}config.json${c.reset} (notepad)`);
  console.log(`  · Visual: go to ${c.cyan}${platformUrl.replace(':3001', ':3000')}/dashboard${c.reset} and click "Edit" on your GPU`);
  console.log(`  · Re-run this wizard: ${c.cyan}npm run setup-auto${c.reset}`);
  console.log('');

  rl.close();
}

main().catch(err => {
  console.error(`\n${c.red}Fatal error:${c.reset}`, err.response?.data || err.message);
  rl.close();
  process.exit(1);
});
