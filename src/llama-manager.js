// provider-agent/src/llama-manager.js
// Gestion du serveur llama.cpp avec lazy loading et swap de modele.
//
// 2 modes supportes par modele dans config.json :
//
//   Mode A — .bat existant (RECOMMANDE pour Windows) :
//     {
//       "name": "Qwen3-30B-Q4",
//       "scriptPath": "D:\\bats\\qwen3-30b.bat",  // ton .bat avec --model, --port, etc.
//       "port": 8080,                              // optionnel, sinon parse depuis le .bat
//       "rateUsdPerHour": 0.50
//     }
//
//   Mode B — chemin GGUF direct (necessite llamaCppPath global) :
//     {
//       "name": "Qwen3-30B-Q4",
//       "path": "D:\\models\\qwen3.gguf",
//       "ctx": 32768, "nGpuLayers": 99,
//       "rateUsdPerHour": 0.50
//     }

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

let llamaProcess = null;
let currentModelName = null;
let currentPort = null;
let loadPromise = null;

async function waitForReady(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(url, { timeout: 1500 });
      if (res.status === 200) return true;
    } catch (_) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`llama.cpp pas pret apres ${timeoutMs}ms sur ${url}`);
}

function findModel(config, modelName) {
  const model = (config.models || []).find(m => m.name === modelName);
  if (!model) {
    const known = (config.models || []).map(m => m.name).join(', ');
    throw new Error(`Modele "${modelName}" inconnu dans config.models (connus: ${known})`);
  }
  return model;
}

function parsePortFromBatFile(scriptPath) {
  try {
    const content = fs.readFileSync(scriptPath, 'utf8');
    const m = content.match(/--port\s+(\d+)/i);
    return m ? parseInt(m[1]) : null;
  } catch (_) { return null; }
}

/**
 * Mode A : lance un .bat (ou .sh sur Linux) qui s'occupe de tout.
 * On extrait le port soit du config soit en parsant le contenu du .bat.
 */
function startViaScript(model, defaultPort) {
  const scriptPath = model.scriptPath;
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script introuvable : ${scriptPath}`);
  }

  const port = model.port || parsePortFromBatFile(scriptPath) || defaultPort || 8080;

  // Sur Windows : cmd /c lance le .bat dans une fenetre. Le binaire llama-server
  // sera un sous-process (grand-fils du cmd). Pour le killer plus tard on
  // utilisera taskkill /T /PID <pid du cmd>.
  // cwd : le dossier du .bat — sinon les chemins relatifs (./llama-server.exe,
  // .\models\xxx.gguf) ne resolvent pas, comme si on lancait depuis ailleurs.
  const isWin = process.platform === 'win32';
  const scriptCwd = path.dirname(path.resolve(scriptPath));
  const proc = isWin
    ? spawn('cmd', ['/c', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: false, cwd: scriptCwd })
    : spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: false, cwd: scriptCwd });

  return { proc, port };
}

/**
 * Mode B : lance directement le binaire llama-server avec args calcules.
 */
function startViaBinary(config, model) {
  if (!config.llamaCppPath || !fs.existsSync(config.llamaCppPath)) {
    throw new Error(`llamaCppPath invalide : ${config.llamaCppPath} (utilise scriptPath dans tes models[] pour eviter cette config)`);
  }
  if (!model.path || !fs.existsSync(model.path)) {
    throw new Error(`Fichier GGUF introuvable : ${model.path}`);
  }
  const port = config.localLlamaPort || 8080;
  const args = [
    '--model', model.path,
    '--ctx-size', (model.ctx ?? 8192).toString(),
    '--n-gpu-layers', (model.nGpuLayers ?? 99).toString(),
    '--port', port.toString(),
    '--host', '127.0.0.1',
  ];
  const proc = spawn(config.llamaCppPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, port };
}

/**
 * S'assure que llama.cpp tourne avec le modele demande.
 * No-op si deja le bon modele. Stop + start sinon.
 * Serialise : si deux sessions arrivent en meme temps, le 2e await le 1er.
 */
export async function ensureModelLoaded(config, modelName) {
  if (loadPromise) await loadPromise;

  if (currentModelName === modelName && llamaProcess) {
    return { swapped: false, modelName, port: currentPort };
  }

  loadPromise = (async () => {
    const model = findModel(config, modelName);

    if (llamaProcess) {
      console.log(`   🔄 Swap modele : ${currentModelName} -> ${modelName}`);
      await stopLlamaServer();
    } else {
      console.log(`   🚀 Chargement initial du modele ${modelName}`);
    }

    const { proc, port } = model.scriptPath
      ? startViaScript(model, config.localLlamaPort)
      : startViaBinary(config, model);

    proc.stderr.on('data', d => process.stderr.write(`[llama err] ${d}`));
    proc.stdout.on('data', d => process.stdout.write(`[llama] ${d}`));
    proc.on('exit', (code) => {
      console.log(`llama.cpp arrete (code ${code}, modele ${currentModelName})`);
      if (llamaProcess === proc) {
        llamaProcess = null;
        currentModelName = null;
        currentPort = null;
      }
    });

    llamaProcess = proc;
    currentPort = port;
    try {
      await waitForReady(port);
    } catch (err) {
      try { proc.kill('SIGKILL'); } catch (_) {}
      llamaProcess = null;
      currentModelName = null;
      currentPort = null;
      throw err;
    }
    currentModelName = modelName;
    console.log(`   ✅ llama.cpp pret avec ${modelName} sur port ${port}`);
  })();

  try {
    await loadPromise;
    return { swapped: true, modelName, port: currentPort };
  } finally {
    loadPromise = null;
  }
}

export async function stopLlamaServer() {
  if (!llamaProcess) return;
  const proc = llamaProcess;
  const pid = proc.pid;
  llamaProcess = null;
  currentModelName = null;
  currentPort = null;

  // Sur Windows, si on a lance via "cmd /c .bat", il faut killer l'arbre
  // entier sinon llama-server.exe reste vivant en orphelin.
  if (process.platform === 'win32' && pid) {
    try {
      await execAsync(`taskkill /F /T /PID ${pid}`);
    } catch (_) { /* peut deja etre mort */ }
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 5000);
    proc.once('exit', () => { clearTimeout(timeout); resolve(); });
  });

  // Securite : si llama-server.exe traine encore (cas Windows orphelin)
  if (process.platform === 'win32') {
    try { await execAsync('taskkill /F /IM llama-server.exe /T'); } catch (_) {}
  }
}

export function getCurrentModel() {
  return currentModelName;
}

export function getCurrentPort() {
  return currentPort;
}

export function isLlamaRunning() {
  return llamaProcess !== null;
}
