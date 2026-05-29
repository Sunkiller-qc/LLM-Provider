#!/usr/bin/env node
// provider-agent/src/auto-setup.js
// Auto-setup ultra simplifie : detecte GPU + llama-server + scan disque pour
// les .gguf + suggere les tarifs. Le user repond seulement a 2-3 questions :
//   - Son adresse Chia
//   - Ou sont ses modeles (si pas trouves auto)
//   - Le JWT obtenu en signant sur le frontend
//
// Usage : npm run setup-auto (ou install.bat sur Windows)

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { detectAllGpus } from './gpu-monitor.js';
import { detectLlamaServer, detectCloudflared, findFreePort, scanLaunchScripts } from './detect.js';
import { ensureModelLoaded, stopLlamaServer, getCurrentPort } from './llama-manager.js';

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

// === Tarifs suggeres selon taille modele ===
function suggestRate(filename) {
  const lower = filename.toLowerCase();
  // Cherche un pattern comme "8B", "30B", "70B" dans le nom
  const match = lower.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return 0.30;
  const size = parseFloat(match[1]);
  if (size < 5) return 0.10;       // <5B (tiny)
  if (size < 15) return 0.20;      // 7B-13B
  if (size < 40) return 0.50;      // 14B-35B
  if (size < 80) return 1.00;      // 70B
  return 2.00;                     // 100B+
}

// === Scan recursif pour .gguf ===
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

// === Decode JWT pour extraire walletAddress ===
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
    info(`config.json existant trouve, on va l'enrichir`);
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  // Pas de config existant : on part d'un objet vide (PAS du example
  // qui contient des modeles bidons C:\models\qwen3...)
  return {
    platformUrl: 'https://backend.chia-offer.com',
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

  // === 1. Detection environnement (silencieuse, juste affichage) ===
  title('1. Detection automatique');

  let gpus;
  try {
    gpus = await detectAllGpus();
    for (const g of gpus) {
      ok(`GPU #${g.index} : ${c.bold}${g.model}${c.reset} (${g.vramGb} Go)`);
    }
  } catch (err) {
    console.log(`  ${c.red}✗${c.reset} Pas de GPU NVIDIA detecte`);
    console.log(`  ${c.dim}${err.message}${c.reset}`);
    console.log(`\n  ${c.yellow}Installe les drivers NVIDIA puis relance ce script${c.reset}`);
    rl.close();
    process.exit(1);
  }

  // llama-server
  const llama = await detectLlamaServer(config.llamaCppPath);
  if (llama.ok) {
    ok(`llama-server : ${llama.path}`);
    config.llamaCppPath = llama.path;
  } else {
    warn(`llama-server introuvable dans le PATH`);
    info(`Telecharge llama.cpp avec CUDA : https://github.com/ggerganov/llama.cpp/releases`);
    info(`Place llama-server.exe quelque part et relance ce script`);

    const customPath = await ask(`\n  Ou colle le chemin maintenant (ou Enter pour skip) : `);
    if (customPath) {
      if (fs.existsSync(customPath)) {
        ok(`llama-server : ${customPath}`);
        config.llamaCppPath = customPath;
      } else {
        warn(`Fichier introuvable, tu pourras editer config.json plus tard`);
      }
    }
  }

  // cloudflared (OPTIONNEL)
  const cf = await detectCloudflared();
  if (cf.ok) {
    ok(`cloudflared : ${cf.version.split('\n')[0]} (optionnel, utilise pour debug)`);
  } else {
    info(`cloudflared non installe — OK, c'est optionnel`);
    info(`(le routing client<->agent passe par le WebSocket, pas besoin d'IP publique)`);
  }

  // Port libre
  const port = await findFreePort(8080);
  if (port) {
    ok(`Port libre detecte : ${port}`);
    config.localLlamaPort = port;
  } else {
    warn(`Aucun port libre entre 8080 et 8129`);
    config.localLlamaPort = 8080;
  }

  // === 2. Tes scripts .bat existants (mode recommande) ===
  title('2. Tes scripts de demarrage (.bat / .sh)');
  info(`Si tu as deja des .bat qui lancent llama-server avec tes parametres,`);
  info(`on peut les utiliser directement (le plus simple).`);

  const batDir = await ask(`\n  Dossier contenant tes .bat (Enter pour skip, mode .gguf direct ensuite) : `);
  let chosen = [];

  if (batDir) {
    const scan = scanLaunchScripts(batDir);
    if (!scan.ok) {
      warn(scan.error);
    } else if (scan.detected.length === 0) {
      warn(`Aucun .bat avec --model trouve dans ${batDir}`);
    } else {
      ok(`${scan.detected.length} script(s) detecte(s) :\n`);
      scan.detected.forEach((s, i) => {
        const rate = suggestRate(s.name);
        const ok_marker = s.modelExists ? c.green + '✓' + c.reset : c.yellow + '?' + c.reset;
        console.log(`    [${i}] ${ok_marker} ${c.bold}${s.name}${c.reset}`);
        console.log(`        script : ${s.scriptPath}`);
        console.log(`        model  : ${s.path}${s.modelExists ? '' : c.yellow + ' (introuvable, mais le .bat saura peut-etre le retrouver)' + c.reset}`);
        console.log(`        ctx ${s.ctx} · ngl ${s.nGpuLayers}${s.port ? ` · port ${s.port}` : ''}`);
        console.log(`        tarif suggere ${c.green}$${rate.toFixed(2)}/h${c.reset}`);
      });

      console.log('');
      const sel = await ask(`  Lesquels louer ? ("all", "0,1,3", Enter pour skip) : `);
      let indices = [];
      if (sel.toLowerCase() === 'all') indices = scan.detected.map((_, i) => i);
      else if (sel) indices = sel.split(',').map(s => parseInt(s.trim())).filter(i => !isNaN(i) && i >= 0 && i < scan.detected.length);

      for (const i of indices) {
        const s = scan.detected[i];
        const suggested = suggestRate(s.name);
        const customRate = await ask(`    Tarif $/h pour ${s.name} [${suggested.toFixed(2)}] : `);
        chosen.push({
          name: s.name,
          scriptPath: s.scriptPath,
          port: s.port,
          rateUsdPerHour: parseFloat(customRate) || suggested,
        });
      }
      if (chosen.length > 0) ok(`${chosen.length} modele(s) via .bat`);
    }
  }

  // === 3. Mode .gguf direct (fallback si pas de .bat) ===
  if (chosen.length === 0) {
    title('3. OU : tes fichiers .gguf direct');
    info(`On scanne ~/models, C:\\models, Downloads, etc.`);

  let ggufs = findGgufFiles(standardSearchRoots());
  let chosen = [];

  // Boucle pour ajouter d'autres dossiers a scanner
  while (true) {
    if (ggufs.length === 0) {
      warn(`Aucun .gguf trouve dans les dossiers actuels`);
    } else {
      ok(`${ggufs.length} modele(s) trouve(s) :\n`);
      ggufs.forEach((g, i) => {
        const name = path.basename(g.path, '.gguf');
        const rate = suggestRate(name);
        console.log(`    [${i}] ${c.bold}${name}${c.reset}`);
        console.log(`        ${g.path}`);
        console.log(`        ${g.sizeGb} Go · tarif suggere ${c.green}$${rate.toFixed(2)}/h${c.reset}`);
      });
    }

    console.log('');
    console.log(`  ${c.bold}Options :${c.reset}`);
    console.log(`    · Tape ${c.cyan}all${c.reset} pour selectionner tous les modeles`);
    console.log(`    · Tape ${c.cyan}0,1,3${c.reset} pour selectionner par indice`);
    console.log(`    · Tape ${c.cyan}+${c.reset} pour scanner un autre dossier`);
    console.log(`    · Tape ${c.cyan}m${c.reset} pour ajouter un modele manuellement (chemin direct)`);
    console.log(`    · Enter pour finir`);
    const sel = (await ask(`\n  Choix : `)).trim();

    if (!sel) break;

    if (sel === '+') {
      const newDir = await ask(`  Chemin du dossier a scanner : `);
      if (newDir) {
        const newGgufs = findGgufFiles([newDir], 5);
        if (newGgufs.length === 0) {
          warn(`Aucun .gguf trouve dans ${newDir}`);
        } else {
          ok(`+${newGgufs.length} modele(s) ajoutes a la liste`);
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
      const modelPath = await ask(`  Chemin complet du .gguf : `);
      if (!modelPath || !fs.existsSync(modelPath)) {
        warn(`Fichier introuvable : ${modelPath}`);
        continue;
      }
      const name = (await ask(`  Nom affiche [${path.basename(modelPath, '.gguf')}] : `))
        || path.basename(modelPath, '.gguf');
      const suggested = suggestRate(name);
      const rate = await ask(`  Tarif $/h [${suggested.toFixed(2)}] : `);
      const ctx = await ask(`  Contexte [8192] : `);
      chosen.push({
        name,
        path: modelPath,
        ctx: parseInt(ctx) || 8192,
        nGpuLayers: 99,
        rateUsdPerHour: parseFloat(rate) || suggested,
      });
      ok(`Ajoute : ${name} a $${(parseFloat(rate) || suggested).toFixed(2)}/h`);
      continue;
    }

    // Sinon : selection par indices
    let indices = [];
    if (sel.toLowerCase() === 'all') {
      indices = ggufs.map((_, i) => i);
    } else {
      indices = sel.split(',').map(s => parseInt(s.trim())).filter(i => !isNaN(i) && i >= 0 && i < ggufs.length);
    }

    if (indices.length === 0) {
      warn(`Indices invalides`);
      continue;
    }

    for (const i of indices) {
      const g = ggufs[i];
      const name = path.basename(g.path, '.gguf');
      // Skip si deja choisi
      if (chosen.find(m => m.path === g.path)) continue;
      const suggested = suggestRate(name);
      const customRate = await ask(`    Tarif $/h pour ${name} [${suggested.toFixed(2)}] : `);
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
    ok(`${chosen.length} modele(s) selectionne(s) au total`);

    const more = await ask(`\n  Ajouter d'autres modeles ? (y/N) : `);
    if (more.toLowerCase() !== 'y') break;
  }

  }  // fin du fallback GGUF direct

  if (chosen.length === 0) {
    console.log('');
    warn(`Aucun modele selectionne ! L'agent ne pourra rien faire.`);
    warn(`Tu peux les ajouter plus tard via le dashboard /dashboard.`);
    const confirm = await ask(`\n  Continuer quand meme avec 0 modele ? (y/N) : `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('  Setup interrompu. Relance install.bat pour reessayer.');
      rl.close();
      process.exit(1);
    }
  }
  config.models = chosen;  // remplace toujours, jamais d'heritage

  // === 3. Adresse Chia ===
  title('3. Ton adresse Chia (xch1...)');
  info(`C'est l'adresse qui recevra tes paiements`);
  info(`Trouve-la dans Sage Wallet > onglet "Receive"`);

  let walletAddress = config.chiaWalletAddress;
  while (true) {
    const a = await ask(`\n  Adresse Chia [${walletAddress || ''}] : `);
    walletAddress = a || walletAddress;
    if (walletAddress?.startsWith('xch1') && walletAddress.length >= 32) break;
    console.log(`  ${c.red}Adresse invalide${c.reset} (doit commencer par xch1)`);
  }
  config.chiaWalletAddress = walletAddress;

  // === 4. JWT - flow simplifie ===
  title('4. Authentification (signe une fois dans Sage)');

  const platformUrl = config.platformUrl || (await ask(`\n  URL du backend [https://backend.chia-offer.com] : `)) || 'https://backend.chia-offer.com';
  config.platformUrl = platformUrl;

  console.log('');
  console.log(`  ${c.bold}Methode rapide (recommandee) :${c.reset}`);
  console.log(`  1. Va sur ${c.cyan}https://llm.chia-offer.com/provider/setup${c.reset} dans ton navigateur`);
  console.log(`  2. Clique ${c.bold}"Connecter Sage"${c.reset} et signe`);
  console.log(`  3. Une fois connecte, copie le JWT affiche`);
  console.log(`  4. Colle-le ci-dessous`);
  console.log('');

  let authToken = '';
  while (!authToken) {
    authToken = await ask(`  Token JWT : `);
    if (!authToken) continue;
    // Verif token semble valide
    const decoded = decodeJwtAddress(authToken);
    if (!decoded) {
      console.log(`  ${c.red}Token invalide${c.reset} (pas un JWT decodable)`);
      authToken = '';
      continue;
    }
    if (decoded !== walletAddress) {
      console.log(`  ${c.yellow}⚠ Le token est pour ${decoded} mais tu as donne ${walletAddress}${c.reset}`);
      const confirm = await ask(`  Continuer quand meme ? (y/N) : `);
      if (confirm.toLowerCase() !== 'y') { authToken = ''; continue; }
    }
    config.authToken = authToken;
    ok(`JWT valide`);
  }

  // === 5. Payout preference ===
  title('5. Devise de paiement');
  const payout = await ask(`\n  Recevoir en XCH ou BYC ? [XCH] : `);
  config.payoutPreference = (payout || 'XCH').toUpperCase();
  if (!['XCH', 'BYC'].includes(config.payoutPreference)) config.payoutPreference = 'XCH';

  saveConfig(config);

  // === 6. Benchmark de chaque modele ===
  if (chosen.length > 0) {
    title('6. Benchmark de tes modeles');
    info('On va lancer chaque .bat un par un pour mesurer tokens/s + cold-start.');
    info(`Duree estimee : ~1-2 min par modele (chargement VRAM + 1 prompt court).`);
    const skipBench = await ask(`\n  Skipper le benchmark (deconseille) ? (y/N) : `);

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
          ok(`Modele charge en ${((tLoaded - t0) / 1000).toFixed(1)}s`);

          const port = getCurrentPort();

          // Etape 1 : warm-up court pour amortir le premier prompt (cache chaud)
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
          } catch (_) { /* warm-up échec OK, on continue */ }

          // Etape 2 : mesure tokens/s en regime stable (200 tokens generes)
          info(`Mesure tokens/s (200 tokens)...`);
          const tMeasure0 = Date.now();
          const resBench = await axios.post(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            {
              model: m.name,
              messages: [{ role: 'user', content: BENCH_PROMPT }],
              max_tokens: 200,
              temperature: 0.3,
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

          // Etape 3 : validation correcte de la reponse (anti-fake-GPU)
          info(`Test validation...`);
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
          ok(`${m.benchmark.tokensPerSec} tok/s sur ${totalTokens} tokens · cold-start ${((tLoaded - t0) / 1000).toFixed(1)}s ${status}${c.reset}`);
        } catch (err) {
          warn(`Echec : ${err.message}`);
          m.benchmark = { passed: false, error: err.message, timestamp: new Date().toISOString() };
        }
      }

      info('\n  Liberation VRAM...');
      await stopLlamaServer();
      ok('VRAM liberee, benchmarks sauvegardes');
    }
  }

  config.models = chosen;
  saveConfig(config);

  // === 7. Register sur le backend ===
  title('7. Enregistrement sur la plateforme');
  try {
    const ratePerHourUsd = Math.max(...chosen.map(m => m.rateUsdPerHour || 0), 0.30);
    const { data: registration } = await axios.post(
      `${config.platformUrl}/api/gpus/register`,
      {
        gpuModel: gpus[0].model,
        vramGb: gpus[0].vramGb,
        availableModels: chosen,  // inclut les benchmarks
        ratePerHourUsd,
        payoutPreference: config.payoutPreference,
        tunnelUrl: null,
      },
      { headers: { Authorization: `Bearer ${config.authToken}` } },
    );
    config.gpuId = registration.gpu.id;
    saveConfig(config);
    ok(`Enregistre ! GPU ID = ${c.cyan}${registration.gpu.id}${c.reset}`);
    info(`Status : ${c.yellow}hors-ligne${c.reset} (deviendra "en ligne" quand tu lanceras npm start)`);
  } catch (err) {
    warn(`Register a echoue : ${err.response?.data?.error || err.message}`);
    warn('Tu peux relancer npm run setup-auto plus tard, ou ca se fera au 1er npm start.');
  }

  // === Recap ===
  console.log('');
  console.log(`${c.bold}${c.green}╭────────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.bold}${c.green}│  Setup termine !                           │${c.reset}`);
  console.log(`${c.bold}${c.green}╰────────────────────────────────────────────╯${c.reset}`);
  console.log('');
  console.log(`  Wallet         : ${config.chiaWalletAddress}`);
  console.log(`  Backend        : ${config.platformUrl}`);
  console.log(`  Payout         : ${config.payoutPreference}`);
  console.log(`  GPU            : ${gpus[0].model} (${gpus[0].vramGb} Go)`);
  console.log(`  llama-server   : ${config.llamaCppPath || c.yellow + 'a configurer dans config.json' + c.reset}`);
  console.log(`  Modeles (${chosen.length}) :`);
  for (const m of chosen) {
    const benchInfo = m.benchmark?.passed
      ? `${c.green}${m.benchmark.tokensPerSec} tok/s ✓${c.reset}`
      : m.benchmark
        ? `${c.yellow}bench KO${c.reset}`
        : `${c.dim}pas benchmarke${c.reset}`;
    console.log(`    · ${m.name.padEnd(35)} ${c.green}$${m.rateUsdPerHour.toFixed(2)}/h${c.reset} · ${benchInfo}`);
  }
  console.log('');
  console.log(`  Config sauvegardee : ${c.dim}${configPath}${c.reset}`);
  if (config.gpuId) {
    console.log(`  GPU enregistre, ID : ${c.cyan}${config.gpuId}${c.reset}`);
    console.log(`  Status actuel      : ${c.yellow}hors-ligne${c.reset}`);
  }
  console.log('');
  step(`Pour activer ton GPU sur le site : ${c.cyan}npm start${c.reset}`);
  step(`Pour le mettre hors-ligne : Ctrl+C`);
  console.log('');
  step(`Pour modifier ta config plus tard :`);
  console.log(`  · Rapide : edite ${c.cyan}config.json${c.reset} (notepad ou nano)`);
  console.log(`  · Visuel : va sur ${c.cyan}https://llm.chia-offer.com/dashboard${c.reset} et clique "Modifier"`);
  console.log(`  · Refaire ce wizard : ${c.cyan}npm run setup-auto${c.reset}`);
  console.log('');

  rl.close();
}

main().catch(err => {
  console.error(`\n${c.red}Erreur fatale :${c.reset}`, err.response?.data || err.message);
  rl.close();
  process.exit(1);
});
