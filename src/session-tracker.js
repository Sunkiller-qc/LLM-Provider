// provider-agent/src/session-tracker.js
// Proxy LLM + tracking d'usage par session via WebSocket avec la plateforme.

import WebSocket from 'ws';
import axios from 'axios';
import { buildWsUrl } from './auth.js';
import { ensureModelLoaded, getCurrentModel, getCurrentPort, stopLlamaServer } from './llama-manager.js';

// Timer d'unload — partage module-level pour qu'une nouvelle session-start
// puisse annuler l'unload programme par la session-end precedente.
let idleUnloadTimer = null;

function cancelIdleUnload() {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function scheduleIdleUnload(config) {
  cancelIdleUnload();
  const seconds = Number(config?.idleUnloadSeconds);
  // 0 ou negatif = on garde le modele en VRAM indefiniment (ancien comportement)
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  console.log(`   💤 Aucune session active — unload de llama-server dans ${seconds}s pour liberer la VRAM`);
  idleUnloadTimer = setTimeout(async () => {
    idleUnloadTimer = null;
    try {
      await stopLlamaServer();
      console.log(`   🧹 llama-server unload — VRAM liberee`);
    } catch (err) {
      console.error(`   ⚠️  Erreur unload llama-server : ${err.message}`);
    }
  }, seconds * 1000);
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

export function startSessionProxy({ gpuId, config }) {
  let reconnectDelay = RECONNECT_BASE_MS;
  let heartbeatTimer = null;
  let ws = null;
  let stopped = false;

  const sessions = new Map();  // sessionId -> { modelName, tokensIn, tokensOut, startedAt, ready }

  function safeSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function connect() {
    const wsUrl = buildWsUrl(config, gpuId);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`   ✅ WS plateforme connecte (gpu ${gpuId})`);
      reconnectDelay = RECONNECT_BASE_MS;
      heartbeatTimer = setInterval(() => safeSend({ type: 'heartbeat', ts: Date.now() }), 30_000);
    });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (_) { return; }

      if (msg.type === 'hello') return;

      if (msg.type === 'session-start') {
        const modelName = msg.payload?.modelName;
        // Une session redemarre : annule l'unload programme (si y'en a un)
        cancelIdleUnload();
        sessions.set(msg.sessionId, {
          modelName,
          tokensIn: 0,
          tokensOut: 0,
          startedAt: Date.now(),
          ready: false,
        });

        const alreadyLoaded = getCurrentModel() === modelName;
        if (!alreadyLoaded) {
          safeSend({ type: 'session-loading', sessionId: msg.sessionId, modelName });
          console.log(`   ⏳ Session ${msg.sessionId} : chargement ${modelName}...`);
        }

        try {
          const { swapped } = await ensureModelLoaded(config, modelName);
          const s = sessions.get(msg.sessionId);
          if (s) s.ready = true;
          safeSend({
            type: 'session-ready',
            sessionId: msg.sessionId,
            modelName,
            coldStart: swapped,
          });
          console.log(`   ▶️  Session ${msg.sessionId} prete (${modelName}${swapped ? ', cold' : ', warm'})`);
        } catch (err) {
          sessions.delete(msg.sessionId);
          safeSend({
            type: 'session-error',
            sessionId: msg.sessionId,
            error: `Chargement modele : ${err.message}`,
          });
          console.error(`   ❌ Session ${msg.sessionId} : ${err.message}`);
        }
        return;
      }

      if (msg.type === 'llm-request') {
        const s = sessions.get(msg.sessionId);
        if (!s || !s.ready) {
          safeSend({ type: 'llm-error', sessionId: msg.sessionId, error: 'session pas prete' });
          return;
        }
        try {
          const response = await axios.post(
            `http://127.0.0.1:${getCurrentPort() || config.localLlamaPort}/v1/chat/completions`,
            msg.payload,
            { responseType: 'stream', timeout: 120_000 },
          );

          response.data.on('data', chunk => {
            safeSend({ type: 'llm-chunk', sessionId: msg.sessionId, data: chunk.toString() });
          });
          response.data.on('end', () => {
            safeSend({ type: 'llm-done', sessionId: msg.sessionId });
          });
          response.data.on('error', err => {
            safeSend({ type: 'llm-error', sessionId: msg.sessionId, error: err.message });
          });
        } catch (err) {
          safeSend({ type: 'llm-error', sessionId: msg.sessionId, error: err.message });
        }
        return;
      }

      if (msg.type === 'benchmark-start') {
        const { modelName, prompt, maxTokens = 150 } = msg;
        console.log(`   🧪 Benchmark demande pour : ${modelName}`);

        // Si benchmark deja fait au setup, on le re-utilise (gagne 1-2 min)
        const localModel = (config.models || []).find(m => m.name === modelName);
        if (localModel?.benchmark?.passed) {
          console.log(`   ♻️  Re-utilise benchmark du setup : ${localModel.benchmark.tokensPerSec} tok/s`);
          safeSend({
            type: 'benchmark-result',
            modelName,
            loadTimeMs: localModel.benchmark.loadTimeMs || 0,
            latencyMs: localModel.benchmark.inferenceMs || 0,
            totalTokens: 0,
            tokensPerSec: localModel.benchmark.tokensPerSec,
            response: localModel.benchmark.response || 'GPU rental test ok',
          });
          return;
        }

        const t0 = Date.now();
        try {
          await ensureModelLoaded(config, modelName);
          const tLoaded = Date.now();
          const res = await axios.post(
            `http://127.0.0.1:${getCurrentPort() || config.localLlamaPort}/v1/chat/completions`,
            {
              model: modelName,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: maxTokens,
              temperature: 0,
              stream: false,
              // Desactive le thinking au niveau du template (Qwen 3+) — sans
              // ca le template injecte <think>...</think> et le modele brule
              // tous ses tokens en reflexion avant de repondre.
              chat_template_kwargs: { enable_thinking: false },
            },
            { timeout: 90_000 },
          );
          const tDone = Date.now();
          const msg = res.data?.choices?.[0]?.message || {};
          const text = [msg.reasoning_content, msg.content].filter(Boolean).join(' ');
          const totalTokens = res.data?.usage?.completion_tokens || text.split(/\s+/).length;
          const inferenceMs = tDone - tLoaded;
          // Use llama-server's internal timing when available — it measures pure
          // generation speed and is unaffected by TTFT or token count.
          const tokensPerSec = res.data?.timings?.predicted_per_second
            ?? (totalTokens / (inferenceMs / 1000));

          // Recupere le n_ctx reellement charge par llama-server (peut differer
          // de la valeur configuree si le modele a un n_ctx_train plus petit).
          let actualCtx = null;
          try {
            const port = getCurrentPort() || config.localLlamaPort;
            const props = await axios.get(`http://127.0.0.1:${port}/props`, { timeout: 5000 });
            const d = props.data || {};
            actualCtx = d.default_generation_settings?.n_ctx
              ?? d.n_ctx_per_seq
              ?? d.default_generation_settings?.params?.n_ctx
              ?? null;
          } catch (_) { /* /props peut ne pas etre dispo selon la version */ }

          safeSend({
            type: 'benchmark-result',
            modelName,
            loadTimeMs: tLoaded - t0,
            latencyMs: inferenceMs,
            totalTokens,
            tokensPerSec: Math.round(tokensPerSec * 10) / 10,
            response: text,
            actualCtx,
          });
          console.log(`   ✅ Benchmark OK : ${tokensPerSec.toFixed(1)} tok/s, ${inferenceMs}ms`);
        } catch (err) {
          safeSend({ type: 'benchmark-error', modelName, error: err.message });
          console.error(`   ❌ Benchmark KO : ${err.message}`);
        }
        return;
      }

      if (msg.type === 'session-end') {
        const s = sessions.get(msg.sessionId);
        if (s) {
          const durationSec = Math.floor((Date.now() - s.startedAt) / 1000);
          console.log(`   ⏹  Session ${msg.sessionId} terminee (${durationSec}s)`);
          sessions.delete(msg.sessionId);
        }
        // Plus aucune session : programme un unload de llama-server pour
        // liberer la VRAM. Annule par toute nouvelle session-start qui arrive
        // dans la fenetre. Defaut : 5 minutes (config.idleUnloadSeconds).
        if (sessions.size === 0) {
          scheduleIdleUnload(config);
        }
        return;
      }
    });

    ws.on('close', (code, reason) => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (stopped) return;

      const reasonStr = reason?.toString() || '';
      console.log(`   ⚠️  WS ferme (${code} ${reasonStr}), reconnexion dans ${reconnectDelay}ms`);

      if (code === 1008) {
        console.error('   ❌ Auth WS refusee — verifie authToken et que le GPU est bien enregistre');
        return;
      }

      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    ws.on('error', (err) => {
      console.error('   WS erreur:', err.message);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (ws) try { ws.close(1000, 'shutdown'); } catch (_) {}
    },
  };
}
