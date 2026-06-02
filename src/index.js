// provider-agent/src/index.js
// Agent a lancer sur la machine GPU du fournisseur

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
  console.error('❌ config.json manquant. Copie config.example.json en config.json et edite-le.');
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
  console.log('\n🛑 Arret en cours...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (proxyHandle?.stop) proxyHandle.stop();

  // Marque le GPU offline cote backend (au lieu d'attendre le timeout heartbeat)
  if (authClient && registeredGpuId) {
    try {
      await authClient.patch(`/api/gpus/${registeredGpuId}`, { isOnline: false });
      console.log('   GPU marque hors-ligne sur le site');
    } catch (_) {}
  }

  await Promise.allSettled([
    stopLlamaServer(),
    stopTunnel(),
  ]);

  console.log('   Cleanup termine');
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

async function main() {
  console.log('🖥  GPU Rental Provider Agent — demarrage');

  const { client, jwtPayload } = createAuthClient(config);
  authClient = client;
  console.log(`   Auth OK — wallet ${jwtPayload?.walletAddress || '(inconnu)'}`);

  const gpuInfo = await detectGpu();
  console.log(`   GPU detecte: ${gpuInfo.model} (${gpuInfo.vramGb} Go VRAM)`);

  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error(
      'config.models est vide. Relance npm run setup-auto (ou install.bat) et selectionne au moins un modele.'
    );
  }

  // Verif chaque modele a un script valide OU un GGUF valide
  const fsCheck = await import('fs');
  const issues = [];
  for (const m of config.models) {
    if (m.scriptPath) {
      if (!fsCheck.existsSync(m.scriptPath)) {
        issues.push(`${m.name} : script introuvable -> ${m.scriptPath}`);
      }
    } else if (m.path) {
      if (!fsCheck.existsSync(m.path)) {
        issues.push(`${m.name} : GGUF introuvable -> ${m.path}`);
      }
    } else {
      issues.push(`${m.name} : ni scriptPath ni path defini`);
    }
  }

  // llamaCppPath n'est requis QUE pour les modeles en mode GGUF direct (sans scriptPath)
  const needsLlamaPath = config.models.some(m => !m.scriptPath);
  if (needsLlamaPath) {
    if (!config.llamaCppPath || !fsCheck.existsSync(config.llamaCppPath)) {
      issues.push(`llamaCppPath requis (au moins un modele utilise GGUF direct) mais introuvable : ${config.llamaCppPath}`);
    }
  }

  if (issues.length > 0) {
    console.error('');
    console.error('❌ Problemes de config :');
    for (const i of issues) console.error(`   · ${i}`);
    console.error('');
    console.error('Solutions :');
    console.error('  1. Edite config.json (notepad) pour corriger');
    console.error('  2. Ou relance install.bat / npm run setup-auto');
    throw new Error(`${issues.length} probleme(s) de config`);
  }

  console.log(`   Modeles dispo : ${config.models.map(m => m.name).join(', ')}`);
  console.log('   (llama.cpp sera charge a la demande lors de la 1ere session)');

  console.log('   Demarrage tunnel Cloudflare (optionnel)...');
  const tunnelUrl = await startTunnel(config.localLlamaPort);
  if (tunnelUrl) {
    console.log(`   ✅ Tunnel actif: ${tunnelUrl}`);
  } else {
    console.log('   (sans tunnel — le WS suffit pour le routing client<->agent)');
  }

  let gpuId = config.gpuId;
  const ratePerHourUsd = config.rateUsdPerHour
    ?? Math.max(...config.models.map(m => m.rateUsdPerHour || 0))
    ?? 0.30;

  if (gpuId) {
    // Deja enregistre lors du setup, on met juste a jour la config + status
    console.log(`   GPU deja enregistre (${gpuId}), mise a jour...`);
    try {
      await client.patch(`/api/gpus/${gpuId}`, {
        availableModels: config.models,
        ratePerHourUsd,
        payoutPreference: config.payoutPreference || 'XCH',
        tunnelUrl,
        isOnline: true,
      });
      console.log(`   ✅ GPU en ligne sur le site`);
    } catch (err) {
      // Si PATCH echoue (ex: GPU supprime du backend), on retombe sur un register
      if (err.response?.status === 404) {
        console.log(`   GPU ${gpuId} introuvable cote backend, re-enregistrement...`);
        gpuId = null;
      } else {
        throw err;
      }
    }
  }

  if (!gpuId) {
    console.log('   Enregistrement aupres de la plateforme...');
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
    // Sauvegarde pour la prochaine fois
    try {
      const fsMod = await import('fs');
      fsMod.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (_) {}
    console.log(`   ✅ Enregistre: GPU ID = ${gpuId}`);
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
      // Si le GPU n'existe plus cote backend (DB reset), on se re-enregistre
      if (err.response?.status === 404) {
        console.log('   GPU disparu cote backend (DB reset ?), re-enregistrement...');
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
          console.log(`   ✅ Re-enregistre, nouveau GPU ID = ${gpuId}`);
          // Reconnecte le WS sur le nouveau gpuId
          if (proxyHandle?.stop) proxyHandle.stop();
          proxyHandle = startSessionProxy({ gpuId, config });
        } catch (regErr) {
          console.error('   Re-register echoue:', regErr.response?.data?.error || regErr.message);
        }
      } else {
        console.error('Heartbeat failed:', err.response?.status, err.message);
      }
    }
  }, 30_000);

  console.log('✅ Agent pret — en attente de sessions');
}

function formatFatalError(err) {
  const body = err.response?.data;
  if (body && typeof body === 'object') {
    const msg = body.error || body.message || JSON.stringify(body);
    if (err.response?.status) return `[HTTP ${err.response.status}] ${msg}`;
    return msg;
  }
  if (body) return String(body);
  if (err.message) return err.message;
  if (err.code) return `${err.code} — verifie platformUrl dans config.json (backend joignable ?)`;
  return String(err);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', formatFatalError(err));
  cleanup(1);
});
