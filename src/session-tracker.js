// provider-agent/src/session-tracker.js
// Proxy LLM + tracking d'usage par session via WebSocket avec la plateforme.

import WebSocket from 'ws';
import axios from 'axios';
import { buildWsUrl } from './auth.js';
import { ensureModelLoaded, getCurrentModel, getCurrentPort, stopLlamaServer, setOnLlamaCrash } from './llama-manager.js';
import { resolveModelForPoolSession } from './pool-setup.js';

// Timer d'unload — partage module-level pour qu'une nouvelle session-start
// puisse annuler l'unload programme par la session-end precedente.
let idleUnloadTimer = null;

// Capacity tracking : combien de requetes LLM tournent en parallele en ce moment.
// Le backend l'utilise pour router intelligemment les nouvelles requetes vers
// le membre le moins occupe d'une pool.
let concurrentRequests = 0;
const recentDurations = [];      // dernieres 10 durees en ms (moyenne mobile)
const recentRequestsStarted = []; // pour debit / throughput stats

function avgRecentDurationMs() {
  if (recentDurations.length === 0) return null;
  return Math.round(recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length);
}

// Best-effort detection of the real n_ctx loaded by llama-server. Different
// llama.cpp versions expose it under different keys ; we try the lot.
export async function fetchLlamaCtx(port) {
  try {
    const r = await axios.get(`http://127.0.0.1:${port}/props`, { timeout: 5000 });
    const d = r.data || {};
    const candidates = [
      d.default_generation_settings?.n_ctx,
      d.default_generation_settings?.params?.n_ctx,
      d.default_generation_settings?.n_ctx_per_seq,
      d.n_ctx_per_seq,
      d.n_ctx,
      d.props?.n_ctx,
      d.params?.n_ctx,
      d.model?.n_ctx,
      d.context_size,
    ];
    for (const v of candidates) {
      if (typeof v === 'number' && v > 0) return v;
    }
  } catch (_) {}
  return null;
}

function sendCapacityStatus(safeSend, config) {
  const maxConcurrent = parseInt(config?.maxConcurrent, 10) || 1;
  const free = Math.max(0, maxConcurrent - concurrentRequests);
  const avgMs = avgRecentDurationMs();
  safeSend({
    type: 'capacity-status',
    concurrentRequests,
    maxConcurrent,
    freeSlots: free,
    avgRequestMs: avgMs,
    ts: Date.now(),
  });
}

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

  // When llama-server dies unexpectedly (OOM, segfault, killed externally),
  // tell the backend so the in-flight sessions can be cleanly errored out
  // instead of hanging until the WS heartbeat catches up.
  setOnLlamaCrash(({ modelName, exitCode }) => {
    console.error(`   ❌ llama-server crashed (model=${modelName}, exitCode=${exitCode})`);
    const affected = Array.from(sessions.keys());
    safeSend({ type: 'model-crashed', modelName, exitCode, affectedSessionIds: affected });
    for (const sid of affected) {
      safeSend({
        type: 'session-error',
        sessionId: sid,
        error: `llama-server crashed (exit ${exitCode}) — likely out-of-memory or external kill`,
        code: 'model-crashed',
      });
      sessions.delete(sid);
    }
    concurrentRequests = 0;
    sendCapacityStatus(safeSend, config);
  });

  function connect() {
    const wsUrl = buildWsUrl(config, gpuId);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`   ✅ WS plateforme connecte (gpu ${gpuId})`);
      reconnectDelay = RECONNECT_BASE_MS;
      heartbeatTimer = setInterval(() => {
        safeSend({ type: 'heartbeat', ts: Date.now() });
        sendCapacityStatus(safeSend, config);
      }, 10_000);
    });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (_) { return; }

      if (msg.type === 'hello') return;

      if (msg.type === 'session-start') {
        const requestedName = msg.payload?.modelName;
        const modelName = resolveModelForPoolSession(config, requestedName);
        if (modelName !== requestedName) {
          console.log(`   🔀 Pool session: loading local model "${modelName}" (SHA256 match, not "${requestedName}")`);
        }
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
          // Report the real n_ctx llama-server is running with so the catalog
          // reflects what's actually loaded, not what's in config.json.
          try {
            const actualCtx = await fetchLlamaCtx(getCurrentPort() || config.localLlamaPort);
            if (actualCtx) {
              safeSend({ type: 'model-info', modelName, actualCtx });
            }
          } catch (_) {}
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
        // Track concurrent in-flight requests so the backend can route smartly.
        concurrentRequests += 1;
        recentRequestsStarted.push(Date.now());
        sendCapacityStatus(safeSend, config);
        let durationMs = 0;
        const reqStartedAt = Date.now();
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
            durationMs = Date.now() - reqStartedAt;
            recentDurations.push(durationMs);
            if (recentDurations.length > 10) recentDurations.shift();
            concurrentRequests = Math.max(0, concurrentRequests - 1);
            sendCapacityStatus(safeSend, config);
            safeSend({ type: 'llm-done', sessionId: msg.sessionId });
          });
          response.data.on('error', err => {
            concurrentRequests = Math.max(0, concurrentRequests - 1);
            sendCapacityStatus(safeSend, config);
            safeSend({ type: 'llm-error', sessionId: msg.sessionId, error: err.message });
          });
        } catch (err) {
          concurrentRequests = Math.max(0, concurrentRequests - 1);
          sendCapacityStatus(safeSend, config);
          safeSend({ type: 'llm-error', sessionId: msg.sessionId, error: err.message });
        }
        return;
      }

      if (msg.type === 'benchmark-start') {
        const { modelName, prompt, maxTokens = 30 } = msg;
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
          const tokensPerSec = totalTokens / (inferenceMs / 1000);

          const actualCtx = await fetchLlamaCtx(getCurrentPort() || config.localLlamaPort);

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
