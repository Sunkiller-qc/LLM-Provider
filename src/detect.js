// src/detect.js
// Auto-detection helpers for the wizard: scan .bat, test port, check
// cloudflared, etc. All best-effort, returns null on failure.

import fs from 'fs';
import path from 'path';
import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Try to detect cloudflared in PATH.
 */
export async function detectCloudflared() {
  try {
    const { stdout } = await execAsync('cloudflared --version');
    const version = stdout.split('\n')[0].trim();
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: 'cloudflared not found in PATH' };
  }
}

/**
 * Check that a local TCP port is free.
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Find the first free port in range [start, start+50].
 */
export async function findFreePort(start = 8080) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

/**
 * Scan a folder for .bat / .sh and try to parse llama-server commands
 * to extract { model_path, ctx_size, n_gpu_layers, port }.
 *
 * No strict pattern: we look for --model, --ctx-size,
 * --n-gpu-layers, --port flags. Model name = filename without extension.
 */
export function scanLaunchScripts(folder) {
  if (!fs.existsSync(folder)) {
    return { ok: false, error: `Folder not found: ${folder}` };
  }
  if (!fs.statSync(folder).isDirectory()) {
    return { ok: false, error: `Not a folder: ${folder}` };
  }

  const entries = fs.readdirSync(folder);
  const scripts = entries.filter(f => /\.(bat|cmd|sh|ps1)$/i.test(f));
  const detected = [];
  const warnings = [];

  for (const file of scripts) {
    const filepath = path.join(folder, file);
    let content;
    try { content = fs.readFileSync(filepath, 'utf8'); }
    catch (_) { continue; }

    const model = extractFlag(content, ['--model', '-m']);
    if (!model) {
      warnings.push(`${file}: no --model found`);
      continue;
    }
    const ctx = parseInt(extractFlag(content, ['--ctx-size', '--ctx', '-c'])) || 4096;
    const ngl = parseInt(extractFlag(content, ['--n-gpu-layers', '-ngl'])) || 99;
    const port = parseInt(extractFlag(content, ['--port'])) || null;

    detected.push({
      name: path.basename(file, path.extname(file)),
      scriptPath: filepath,
      path: model,
      ctx,
      nGpuLayers: ngl,
      port,
      modelExists: fs.existsSync(model),
    });
  }

  return { ok: true, detected, scripts: scripts.length, warnings };
}

function extractFlag(content, flagNames) {
  for (const flag of flagNames) {
    // Match: --flag value  OR --flag=value  OR --flag "value with spaces"
    const re = new RegExp(`${escapeRegex(flag)}(?:\\s+|=)("[^"]+"|'[^']+'|\\S+)`);
    const m = content.match(re);
    if (m) {
      let v = m[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v.trim();
    }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check that a GGUF file looks valid (exists + reasonable size).
 */
export function validateModelFile(modelPath) {
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'File not found' };
  const stat = fs.statSync(modelPath);
  if (!stat.isFile()) return { ok: false, error: 'Not a file' };
  const sizeGb = stat.size / (1024 ** 3);
  if (sizeGb < 0.1) return { ok: false, error: `Too small (${sizeGb.toFixed(2)} GB), probably not a GGUF` };
  if (sizeGb > 500) return { ok: false, error: `Too large (${sizeGb.toFixed(2)} GB)` };
  return { ok: true, sizeGb: parseFloat(sizeGb.toFixed(2)) };
}

/**
 * Try to detect llama-server via 'which' / 'where' / 'whereis'.
 */
export async function detectLlamaServer(hintPath) {
  if (hintPath && fs.existsSync(hintPath)) {
    return { ok: true, path: hintPath };
  }
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'llama-server.exe' : 'llama-server';
  const cmd = isWin ? `where ${binName}` : `which ${binName}`;
  try {
    const { stdout } = await execAsync(cmd);
    const found = stdout.trim().split('\n')[0].trim();
    if (found && fs.existsSync(found)) return { ok: true, path: found };
  } catch (_) {}
  return { ok: false, error: `${binName} not found in PATH` };
}
