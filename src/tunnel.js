// provider-agent/src/tunnel.js
// Démarrage optionnel d'un Cloudflare Tunnel pour exposer llama.cpp.
// Le tunnel n'est PAS requis : le routing client<->agent passe par le WS
// que l'agent ouvre vers le backend. On garde le tunnel comme outil de
// debug (pouvoir tester llama directement via l'URL publique).

import { spawn, execSync } from 'child_process';

let tunnelProcess = null;

function isCloudflaredInstalled() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Demarre un Quick Tunnel cloudflared. Retourne l'URL publique
 * (https://*.trycloudflare.com) ou null si cloudflared n'est pas installe.
 *
 * Ne throw JAMAIS — l'agent doit pouvoir tourner sans cloudflared.
 */
export async function startTunnel(localPort) {
  if (!isCloudflaredInstalled()) {
    console.log('   ℹ  cloudflared non installe — tunnel skip (l\'agent marche quand meme via WS)');
    return null;
  }

  if (tunnelProcess) {
    console.warn('   Tunnel deja actif — stopTunnel() d\'abord');
    return null;
  }

  return new Promise((resolve) => {
    const proc = spawn('cloudflared', [
      'tunnel',
      '--url', `http://localhost:${localPort}`,
      '--no-autoupdate',
    ]);

    let resolved = false;

    const onData = (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        tunnelProcess = proc;
        resolve(match[0]);
      }
    };

    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.warn(`   ⚠ cloudflared erreur : ${err.message} (continue sans tunnel)`);
        resolve(null);
      }
    });

    proc.on('exit', (code) => {
      if (tunnelProcess === proc) tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.warn(`   ⚠ cloudflared a quitte (code ${code}) — continue sans tunnel`);
        resolve(null);
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
        console.warn('   ⚠ Timeout tunnel (30s) — continue sans');
        resolve(null);
      }
    }, 30_000);
  });
}

export async function stopTunnel() {
  if (!tunnelProcess) return;
  const proc = tunnelProcess;
  tunnelProcess = null;
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 3000);
    proc.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
