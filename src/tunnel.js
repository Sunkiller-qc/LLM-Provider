// src/tunnel.js
// Optional Cloudflare Tunnel startup to expose llama.cpp.
// The tunnel is NOT required: client<->agent routing goes through the WS
// that the agent opens to the backend. We keep the tunnel as a
// debug tool (to test llama directly via the public URL).

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
 * Start a cloudflared Quick Tunnel. Returns the public URL
 * (https://*.trycloudflare.com) or null if cloudflared is not installed.
 *
 * Never throws — the agent must be able to run without cloudflared.
 */
export async function startTunnel(localPort) {
  if (!isCloudflaredInstalled()) {
    console.log('   ℹ  cloudflared not installed — tunnel skipped (agent still works via WS)');
    return null;
  }

  if (tunnelProcess) {
    console.warn('   Tunnel already active — call stopTunnel() first');
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
        console.warn(`   ⚠ cloudflared error: ${err.message} (continuing without tunnel)`);
        resolve(null);
      }
    });

    proc.on('exit', (code) => {
      if (tunnelProcess === proc) tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.warn(`   ⚠ cloudflared exited (code ${code}) — continuing without tunnel`);
        resolve(null);
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
        console.warn('   ⚠ Tunnel timeout (30s) — continuing without');
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
