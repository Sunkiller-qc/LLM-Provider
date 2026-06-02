// src/index.js
// Agent to run on the provider's GPU machine

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { detectGpu } from './gpu-monitor.js';
import { stopLlamaServer } from './llama-manager.js';
import { startTunnel, stopTunnel } from './tunnel.js';
import { startSessionProxy } from './session-tracker.js';
import { createAuthClient } from './auth.js';
import { verifyPoolMembershipOnStart } from './pool-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('❌ config.json missing. Copy config.example.json to config.json and edit it.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

let proxyHandle = null;
let heartbeatTimer = null;
let shuttingDown = false;
let authClient = null;
let registeredGpuId = null;

async function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n🛑 Shutting down...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (proxyHandle?.stop) proxyHandle.stop();

  // Mark GPU offline on backend (instead of waiting for heartbeat timeout)
  if (authClient && registeredGpuId) {
    try {
      await authClient.patch(`/api/gpus/${registeredGpuId}`, { isOnline: false });
      console.log('   GPU marked offline on the platform');
    } catch (_) {}
  }

  await Promise.allSettled([
    stopLlamaServer(),
    stopTunnel(),
  ]);

  console.log('   Cleanup complete');
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

async function main() {
  console.log('🖥  GPU Rental Provider Agent — starting');

  const { client, jwtPayload } = createAuthClient(config);
  authClient = client;
  console.log(`   Auth OK — wallet ${jwtPayload?.walletAddress || '(unknown)'}`);

  const gpuInfo = await detectGpu();
  console.log(`   GPU detected: ${gpuInfo.model} (${gpuInfo.vramGb} GB VRAM)`);

  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error(
      'config.models is empty. Re-run npm run setup-auto (or install.bat) and select at least one model.'
    );
  }

  // Verify each model has a valid script OR a valid GGUF
  const fsCheck = await import('fs');
  const issues = [];
  for (const m of config.models) {
    if (m.scriptPath) {
      if (!fsCheck.existsSync(m.scriptPath)) {
        issues.push(`${m.name}: script not found -> ${m.scriptPath}`);
      }
    } else if (m.path) {
      if (!fsCheck.existsSync(m.path)) {
        issues.push(`${m.name}: GGUF not found -> ${m.path}`);
      }
    } else {
      issues.push(`${m.name}: neither scriptPath nor path defined`);
    }
  }

  // llamaCppPath is required ONLY for models in direct GGUF mode (without scriptPath)
  const needsLlamaPath = config.models.some(m => !m.scriptPath);
  if (needsLlamaPath) {
    if (!config.llamaCppPath || !fsCheck.existsSync(config.llamaCppPath)) {
      issues.push(`llamaCppPath required (at least one model uses direct GGUF) but not found: ${config.llamaCppPath}`);
    }
  }

  if (issues.length > 0) {
    console.error('');
    console.error('❌ Config issues:');
    for (const i of issues) console.error(`   · ${i}`);
    console.error('');
    console.error('Solutions:');
    console.error('  1. Edit config.json (notepad) to fix');
    console.error('  2. Or re-run install.bat / npm run setup-auto');
    throw new Error(`${issues.length} config issue(s)`);
  }

  console.log(`   Available models: ${config.models.map(m => m.name).join(', ')}`);
  console.log('   (llama.cpp will be loaded on demand on first session)');

  console.log('   Starting Cloudflare tunnel (optional)...');
  const tunnelUrl = await startTunnel(config.localLlamaPort);
  if (tunnelUrl) {
    console.log(`   ✅ Tunnel active: ${tunnelUrl}`);
  } else {
    console.log('   (no tunnel — WS is enough for client<->agent routing)');
  }

  let gpuId = config.gpuId;
  const ratePerHourUsd = config.rateUsdPerHour
    ?? Math.max(...config.models.map(m => m.rateUsdPerHour || 0))
    ?? 0.30;

  if (gpuId) {
    // Already registered during setup, just update config + status
    console.log(`   GPU already registered (${gpuId}), updating...`);
    try {
      await client.patch(`/api/gpus/${gpuId}`, {
        availableModels: config.models,
        ratePerHourUsd,
        payoutPreference: config.payoutPreference || 'XCH',
        tunnelUrl,
        isOnline: true,
      });
      console.log(`   ✅ GPU online on the platform`);
    } catch (err) {
      // If PATCH fails (e.g. GPU deleted from backend), fall back to register
      if (err.response?.status === 404) {
        console.log(`   GPU ${gpuId} not found on backend, re-registering...`);
        gpuId = null;
      } else {
        throw err;
      }
    }
  }

  if (!gpuId) {
    console.log('   Registering with the platform...');
    const { data: registration } = await client.post('/api/gpus/register', {
      gpuModel: gpuInfo.model,
      vramGb: gpuInfo.vramGb,
      availableModels: config.models,
      ratePerHourUsd,
      payoutPreference: config.payoutPreference || 'XCH',
      tunnelUrl,
    });
    gpuId = registration.gpu.id;
    config.gpuId = gpuId;
    // Save for next time
    try {
      const fsMod = await import('fs');
      fsMod.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (_) {}
    console.log(`   ✅ Registered: GPU ID = ${gpuId}`);
  }

  registeredGpuId = gpuId;

  if (config.poolMembership?.poolNumber) {
    try {
      await verifyPoolMembershipOnStart({ config, client, gpuId, configPath });
    } catch (err) {
      console.error(`❌ Pool verification failed: ${err.message}`);
      process.exit(1);
    }
  }

  proxyHandle = startSessionProxy({ gpuId, config });

  heartbeatTimer = setInterval(async () => {
    try {
      await client.post(`/api/gpus/${gpuId}/heartbeat`, {});
    } catch (err) {
      // If GPU no longer exists on backend (DB reset), re-register
      if (err.response?.status === 404) {
        console.log('   GPU gone on backend (DB reset?), re-registering...');
        try {
          const { data } = await client.post('/api/gpus/register', {
            gpuModel: gpuInfo.model,
            vramGb: gpuInfo.vramGb,
            availableModels: config.models,
            ratePerHourUsd,
            payoutPreference: config.payoutPreference || 'XCH',
            tunnelUrl,
          });
          gpuId = data.gpu.id;
          registeredGpuId = gpuId;
          config.gpuId = gpuId;
          const fsMod = await import('fs');
          fsMod.writeFileSync(configPath, JSON.stringify(config, null, 2));
          console.log(`   ✅ Re-registered, new GPU ID = ${gpuId}`);
          // Reconnect WS on new gpuId
          if (proxyHandle?.stop) proxyHandle.stop();
          proxyHandle = startSessionProxy({ gpuId, config });
        } catch (regErr) {
          console.error('   Re-register failed:', regErr.response?.data?.error || regErr.message);
        }
      } else {
        console.error('Heartbeat failed:', err.response?.status, err.message);
      }
    }
  }, 30_000);

  console.log('✅ Agent ready — waiting for sessions');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.response?.data || err.message);
  cleanup(1);
});
