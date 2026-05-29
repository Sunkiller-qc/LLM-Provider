// provider-agent/src/detect.js
// Helpers de detection auto pour le wizard : scan .bat, test port, check
// cloudflared, etc. Tout est best-effort, retourne null en cas d'echec.

import fs from 'fs';
import path from 'path';
import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Tente de detecter cloudflared dans le PATH.
 */
export async function detectCloudflared() {
  try {
    const { stdout } = await execAsync('cloudflared --version');
    const version = stdout.split('\n')[0].trim();
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: 'cloudflared introuvable dans le PATH' };
  }
}

/**
 * Verifie qu'un port TCP local est libre.
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
 * Trouve le 1er port libre dans la plage [start, start+50].
 */
export async function findFreePort(start = 8080) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

/**
 * Scan un dossier pour les .bat / .sh et tente de parser les commandes
 * llama-server pour extraire { model_path, ctx_size, n_gpu_layers, port }.
 *
 * Pas de pattern strict : on regarde les flags --model, --ctx-size,
 * --n-gpu-layers, --port. Le nom du modele = nom du fichier sans extension.
 */
export function scanLaunchScripts(folder) {
  if (!fs.existsSync(folder)) {
    return { ok: false, error: `Dossier introuvable : ${folder}` };
  }
  if (!fs.statSync(folder).isDirectory()) {
    return { ok: false, error: `Pas un dossier : ${folder}` };
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
      warnings.push(`${file} : pas de --model trouve`);
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
 * Verifie qu'un fichier GGUF semble valide (existe + taille raisonnable).
 */
export function validateModelFile(modelPath) {
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'Fichier introuvable' };
  const stat = fs.statSync(modelPath);
  if (!stat.isFile()) return { ok: false, error: 'Pas un fichier' };
  const sizeGb = stat.size / (1024 ** 3);
  if (sizeGb < 0.1) return { ok: false, error: `Trop petit (${sizeGb.toFixed(2)} Go), probablement pas un GGUF` };
  if (sizeGb > 500) return { ok: false, error: `Trop gros (${sizeGb.toFixed(2)} Go)` };
  return { ok: true, sizeGb: parseFloat(sizeGb.toFixed(2)) };
}

/**
 * Tente de detecter llama-server via 'which' / 'where' / 'whereis'.
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
  return { ok: false, error: `${binName} introuvable dans le PATH` };
}
