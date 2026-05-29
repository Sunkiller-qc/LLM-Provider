#!/usr/bin/env node
// provider-agent/src/mock.js
// Faux agent : utilise le vrai WS + auth + register, mais simule llama.cpp
// avec des reponses bidonnees. Permet de tester la plateforme end-to-end
// sans avoir besoin d'un GPU ni de llama.cpp.
//
// Usage : npm run mock

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

import { createAuthClient, buildWsUrl } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('config.json manquant. Run npm run setup d\'abord.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Fake GPU info
const mockGpuInfo = {
  model: 'MOCK GPU (no real hardware)',
  vramGb: 24,
};
const mockModels = config.models?.length > 0 ? config.models : [
  { name: 'Mock-Tiny-LLM', ctx: 8192 },
  { name: 'Mock-Big-LLM', ctx: 32768 },
];

let currentModelLoaded = null;

async function fakeLoad(modelName) {
  if (currentModelLoaded === modelName) return { swapped: false };
  console.log(`   [MOCK] chargement de ${modelName}...`);
  await new Promise(r => setTimeout(r, 1500));  // simule 1.5s de cold-start
  currentModelLoaded = modelName;
  return { swapped: true };
}

async function main() {
  console.log('==========================================');
  console.log('  MOCK Provider Agent');
  console.log('==========================================');
  console.log('  Aucun GPU/llama.cpp requis.');
  console.log('');

  const { client, jwtPayload } = createAuthClient(config);
  console.log(`Auth OK : ${jwtPayload?.walletAddress}`);

  console.log('Register...');
  const { data: registration } = await client.post('/api/gpus/register', {
    gpuModel: mockGpuInfo.model,
    vramGb: mockGpuInfo.vramGb,
    availableModels: mockModels,
    ratePerHourUsd: config.rateUsdPerHour ?? 0.1,
    payoutPreference: config.payoutPreference ?? 'XCH',
    tunnelUrl: 'http://mock.local:8080',
  });
  const gpuId = registration.gpu.id;
  console.log(`Enregistre : GPU ID = ${gpuId}`);

  const wsUrl = buildWsUrl(config, gpuId);
  const ws = new WebSocket(wsUrl);
  const sessions = new Map();

  function send(payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  ws.on('open', () => {
    console.log('WS connecte');
    setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), 30_000);
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.type === 'hello') return;

    if (msg.type === 'benchmark-start') {
      console.log(`[MOCK] benchmark-start pour ${msg.modelName}`);
      const t0 = Date.now();
      await fakeLoad(msg.modelName);
      const tLoaded = Date.now();
      await new Promise(r => setTimeout(r, 300));  // simule 300ms d'inference
      const tDone = Date.now();
      // On renvoie une reponse qui CONTIENT bien "GPU rental test ok" pour passer la validation
      send({
        type: 'benchmark-result',
        modelName: msg.modelName,
        loadTimeMs: tLoaded - t0,
        latencyMs: tDone - tLoaded,
        totalTokens: 8,
        tokensPerSec: 26.7,
        response: 'GPU rental test ok',
      });
      console.log('[MOCK] benchmark-result envoye');
      return;
    }

    if (msg.type === 'session-start') {
      console.log(`[MOCK] session-start ${msg.sessionId}, modele ${msg.payload?.modelName}`);
      sessions.set(msg.sessionId, { modelName: msg.payload?.modelName });
      const swap = currentModelLoaded !== msg.payload?.modelName;
      if (swap) {
        send({ type: 'session-loading', sessionId: msg.sessionId, modelName: msg.payload?.modelName });
      }
      await fakeLoad(msg.payload?.modelName);
      send({
        type: 'session-ready',
        sessionId: msg.sessionId,
        modelName: msg.payload?.modelName,
        coldStart: swap,
      });
      return;
    }

    if (msg.type === 'llm-request') {
      console.log(`[MOCK] llm-request session ${msg.sessionId}`);
      // Stream une reponse OpenAI SSE en 5 chunks
      const fakeReply = `Mock reply for "${msg.payload?.messages?.slice(-1)[0]?.content?.slice(0, 30) || ''}". Pas un vrai LLM.`;
      const words = fakeReply.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = {
          choices: [{ delta: { content: words[i] + ' ' } }],
        };
        send({
          type: 'llm-chunk',
          sessionId: msg.sessionId,
          data: `data: ${JSON.stringify(chunk)}\n\n`,
        });
        await new Promise(r => setTimeout(r, 100));
      }
      send({ type: 'llm-done', sessionId: msg.sessionId });
      return;
    }

    if (msg.type === 'session-end') {
      console.log(`[MOCK] session-end ${msg.sessionId}`);
      sessions.delete(msg.sessionId);
    }
  });

  ws.on('close', (code) => {
    console.log(`WS ferme (${code})`);
    if (code !== 1008) {
      setTimeout(() => main().catch(console.error), 3000);
    }
  });
  ws.on('error', err => console.error('WS err:', err.message));

  console.log('Mock agent pret. Ctrl-C pour stopper.');
}

main().catch(err => {
  console.error('Erreur fatale :', err.response?.data || err.message);
  process.exit(1);
});
