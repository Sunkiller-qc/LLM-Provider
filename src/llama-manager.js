// src/llama-manager.js
// llama.cpp server management with lazy loading and model swap.
//
// 2 modes supported per model in config.json:
//
//   Mode A — existing .bat (RECOMMENDED for Windows):
//     {
//       "name": "Qwen3-30B-Q4",
//       "scriptPath": "D:\\bats\\qwen3-30b.bat",  // your .bat with --model, --port, etc.
//       "port": 8080,                              // optional, otherwise parsed from .bat
//       "rateUsdPerHour": 0.50
//     }
//
//   Mode B — direct GGUF path (requires global llamaCppPath):
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
let onCrashCallback = null;
let expectingExit = false;  // true while stopLlamaServer is in progress

export function setOnLlamaCrash(fn) { onCrashCallback = fn; }

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
  throw new Error(`llama.cpp not ready after ${timeoutMs}ms at ${url}`);
}

function findModel(config, modelName) {
  const model = (config.models || []).find(m => m.name === modelName);
  if (!model) {
    const known = (config.models || []).map(m => m.name).join(', ');
    throw new Error(`Model "${modelName}" unknown in config.models (known: ${known})`);
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
 * Mode A: run a .bat (or .sh on Linux) that handles everything.
 * Extract port from config or by parsing .bat content.
 */
function startViaScript(model, defaultPort) {
  const scriptPath = model.scriptPath;
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }

  const port = model.port || parsePortFromBatFile(scriptPath) || defaultPort || 8080;

  // On Windows: cmd /c runs the .bat in a window. The llama-server binary
  // will be a child process (grandchild of cmd). To kill it later we
  // use taskkill /T /PID <cmd pid>.
  // cwd: the .bat folder — otherwise relative paths (./llama-server.exe,
  // .\models\xxx.gguf) won't resolve, as if launched from elsewhere.
  const isWin = process.platform === 'win32';
  const scriptCwd = path.dirname(path.resolve(scriptPath));
  const proc = isWin
    ? spawn('cmd', ['/c', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: false, cwd: scriptCwd })
    : spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: false, cwd: scriptCwd });

  return { proc, port };
}

/**
 * Mode B: launch llama-server binary directly with computed args.
 */
function startViaBinary(config, model) {
  if (!config.llamaCppPath || !fs.existsSync(config.llamaCppPath)) {
    throw new Error(`Invalid llamaCppPath: ${config.llamaCppPath} (use scriptPath in your models[] to avoid this config)`);
  }
  if (!model.path || !fs.existsSync(model.path)) {
    throw new Error(`GGUF file not found: ${model.path}`);
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
 * Ensure llama.cpp is running with the requested model.
 * No-op if already the right model. Stop + start otherwise.
 * Serialized: if two sessions arrive at once, the 2nd awaits the 1st.
 */
export async function ensureModelLoaded(config, modelName) {
  if (loadPromise) await loadPromise;

  if (currentModelName === modelName && llamaProcess) {
    return { swapped: false, modelName, port: currentPort };
  }

  loadPromise = (async () => {
    const model = findModel(config, modelName);

    if (llamaProcess) {
      console.log(`   🔄 Model swap: ${currentModelName} -> ${modelName}`);
      await stopLlamaServer();
    } else {
      console.log(`   🚀 Initial load of model ${modelName}`);
    }

    const { proc, port } = model.scriptPath
      ? startViaScript(model, config.localLlamaPort)
      : startViaBinary(config, model);

    proc.stderr.on('data', d => process.stderr.write(`[llama err] ${d}`));
    proc.stdout.on('data', d => process.stdout.write(`[llama] ${d}`));
    proc.on('exit', (code) => {
      const wasModel = currentModelName;
      console.log(`llama.cpp stopped (code ${code}, model ${wasModel})`);
      if (llamaProcess === proc) {
        llamaProcess = null;
        currentModelName = null;
        currentPort = null;
      }
      // Unexpected crash (not a graceful stopLlamaServer): signal the
      // backend so the in-flight sessions can be ended with a clear error.
      if (!expectingExit && wasModel && onCrashCallback) {
        try {
          onCrashCallback({ modelName: wasModel, exitCode: code });
        } catch (_) {}
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
    console.log(`   ✅ llama.cpp ready with ${modelName} on port ${port}`);
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
  expectingExit = true;
  setTimeout(() => { expectingExit = false; }, 5000);
  llamaProcess = null;
  currentModelName = null;
  currentPort = null;

  // On Windows, if launched via "cmd /c .bat", kill the entire tree
  // otherwise llama-server.exe stays alive as an orphan.
  if (process.platform === 'win32' && pid) {
    try {
      await execAsync(`taskkill /F /T /PID ${pid}`);
    } catch (_) { /* may already be dead */ }
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

  // Safety: if llama-server.exe is still lingering (Windows orphan case)
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
