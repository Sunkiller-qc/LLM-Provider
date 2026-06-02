// Pool membership flow for provider setup and runtime verification.

import fs from 'fs';
import axios from 'axios';
import { sha256File, formatBytes } from './gguf-hash.js';
import { parseGgufPathFromScript } from './detect.js';
import { DEFAULT_PLATFORM_URL, normalizePlatformUrl, isLocalPlatformUrl } from './defaults.js';

const FRONTEND_URL = 'https://llm.chia-offer.com';

export async function fetchPoolByNumber(platformUrl, poolNumber) {
  const { data } = await axios.get(`${platformUrl}/api/pools/lookup/${poolNumber}`, { timeout: 15_000 });
  return data.pool;
}

/** Numero seul (10001), UUID, ou URL https://llm.chia-offer.com/pools/... */
export function parsePoolReference(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return { poolNumber: parseInt(s, 10) };
  const urlMatch = s.match(/pools\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (urlMatch) return { poolId: urlMatch[1] };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return { poolId: s };
  const leading = parseInt(s, 10);
  if (Number.isFinite(leading) && leading >= 1) return { poolNumber: leading };
  return null;
}

function formatLookupError(err, platformUrl) {
  const apiMsg = err.response?.data?.error;
  if (apiMsg) return `${apiMsg} (HTTP ${err.response.status})`;
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    return `Backend injoignable : ${platformUrl} — verifie platformUrl dans config.json`;
  }
  return err.message || 'Erreur reseau';
}

export async function resolvePoolFromInput(platformUrl, raw) {
  const ref = parsePoolReference(raw);
  if (!ref) {
    throw new Error('Entree invalide — tape 10001 ou colle l\'URL https://llm.chia-offer.com/pools/...');
  }
  if (ref.poolNumber) {
    return fetchPoolByNumber(platformUrl, ref.poolNumber);
  }
  const { data } = await axios.get(`${platformUrl}/api/pools/${ref.poolId}`, { timeout: 15_000 });
  const p = data.pool;
  if (!p) throw new Error('Pool introuvable (id invalide)');
  if (p.poolNumber == null) {
    throw new Error('Cette pool n\'a pas encore de numero public — utilise le createur pour l\'ouvrir une fois sur le site');
  }
  return {
    poolNumber: p.poolNumber,
    id: p.id,
    displayName: p.displayName,
    name: p.name,
    description: p.description,
    modelSha256: p.modelSha256,
    ctx: p.ctx,
    ratePerHourUsd: p.ratePerHourUsd,
    modelSourceUrl: p.modelSourceUrl,
    isOpen: p.isOpen,
    modelName: p.modelName,
  };
}

export async function joinPoolByNumber({ platformUrl, authToken, gpuId, poolNumber, modelSha256 }) {
  const { data } = await axios.post(
    `${platformUrl}/api/pools/join`,
    { poolNumber, gpuId, modelSha256: modelSha256.toLowerCase() },
    { headers: { Authorization: `Bearer ${authToken}` }, timeout: 30_000 },
  );
  return data;
}

/** True when user chose pool (before or after join finalized). */
export function isPoolMode(config) {
  return config?.servingMode === 'pool' || !!config?._pendingPool || !!config?.poolMembership;
}

function isPoolChoice(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return m === '2' || m === 'pool' || m === 'p';
}

function printStepTitle(log, text) {
  if (log?.title) log.title(text);
  else console.log(`\n=== ${text} ===\n`);
}

/** Resolve GGUF path for hashing (direct path, config path, or --model in .bat). */
export function getGgufPathForModel(model) {
  if (model?.ggufPath && fs.existsSync(model.ggufPath)) return model.ggufPath;
  if (model?.path && fs.existsSync(model.path)) return model.path;
  if (model?.scriptPath) {
    const fromScript = parseGgufPathFromScript(model.scriptPath);
    if (fromScript && fs.existsSync(fromScript)) return fromScript;
  }
  return null;
}

export async function hashModelFile(model, log) {
  const filePath = getGgufPathForModel(model);
  if (!filePath) return null;
  log?.info?.(`Hashing ${filePath} …`);
  const hash = await sha256File(filePath, (done, total) => {
    if (total && done % (512 * 1024 * 1024) < 65536) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      process.stdout.write(`\r  Progress: ${pct}% (${formatBytes(done)} / ${formatBytes(total)})   `);
    }
  });
  process.stdout.write('\n');
  return hash;
}

/**
 * Early setup step: solo vs pool + pool lookup (before model pricing).
 * @returns {'solo'|'pool'}
 */
/** Confirme l'URL API (avant pool lookup — evite localhost par defaut). */
export async function promptPlatformUrl(config, ask, log) {
  const current = normalizePlatformUrl(config.platformUrl);
  if (isLocalPlatformUrl(current)) {
    log.warn?.(`Backend actuel : ${current} — pas la production chia-offer.com`);
  }
  const suggested = isLocalPlatformUrl(current) ? DEFAULT_PLATFORM_URL : (current || DEFAULT_PLATFORM_URL);
  const entered = await ask(`  URL du backend API [${suggested}] : `);
  config.platformUrl = normalizePlatformUrl(entered || suggested);
  log.ok?.(`Backend API : ${config.platformUrl}`);
  log.info?.(`Frontend (wallet/JWT) : ${FRONTEND_URL.replace(/^https?:\/\//, '')}`);
}

export async function askServingModeEarly({ config, ask, log }) {
  await promptPlatformUrl(config, ask, log);

  printStepTitle(log, '2. Mode de service');
  console.log('  Comment veux-tu proposer ton GPU ?\n');
  console.log('    1) Solo — location directe, tu fixes ton tarif $/h');
  console.log('    2) Pool — rejoindre une pool existante (tarif fixe par la pool, SHA256 GGUF identique)\n');

  const mode = await ask('  Choix : tape 2 pour POOL, 1 pour solo [1] : ');
  if (!isPoolChoice(mode)) {
    delete config.poolMembership;
    delete config._pendingPool;
    config.servingMode = 'solo';
    log.ok?.('Mode solo — tu definiras ton tarif a l\'etape modeles.');
    return 'solo';
  }

  config.servingMode = 'pool';
  delete config.poolMembership;

  const platformUrl = config.platformUrl;

  console.log('  Ex. numero : 10001');
  console.log('  Ex. URL    : https://llm.chia-offer.com/pools/54c8772e-...\n');
  const rawRef = await ask('  Numero de pool OU URL de la page pool : ');
  let pool;
  try {
    pool = await resolvePoolFromInput(platformUrl, rawRef);
  } catch (err) {
    log.err?.(err.message || formatLookupError(err, platformUrl));
    log.info?.(`Backend utilise : ${platformUrl}`);
    config.servingMode = 'solo';
    delete config._pendingPool;
    return 'solo';
  }

  if (!pool.isOpen) {
    log.err?.('Cette pool est fermee aux nouveaux membres.');
    config.servingMode = 'solo';
    delete config._pendingPool;
    return 'solo';
  }

  config._pendingPool = pool;
  log.ok?.(`Pool #${pool.poolNumber} — ${pool.displayName}`);
  log.info?.(`Tarif pool : $${pool.ratePerHourUsd}/h (pas de tarif solo a saisir)`);
  log.info?.(`GGUF requis (SHA256) : ${pool.modelSha256.slice(0, 16)}…${pool.modelSha256.slice(-8)}`);
  if (pool.modelSourceUrl) log.info?.(`Telechargement : ${pool.modelSourceUrl}`);
  log.info?.('Etape suivante : selectionne le modele qui correspond a ce GGUF.');
  return 'pool';
}

/** POST /api/pools/join when SHA256 was already verified during setup. */
export async function registerPoolOnServer({ config, gpuId, authToken, platformUrl, log }) {
  const pm = config.poolMembership;
  if (!pm?.poolNumber || !pm.requiredSha256 || !gpuId || !authToken) return false;
  try {
    await joinPoolByNumber({
      platformUrl,
      authToken,
      gpuId,
      poolNumber: pm.poolNumber,
      modelSha256: pm.requiredSha256,
    });
    log.ok?.(`Inscrit sur la pool #${pm.poolNumber} (serveur).`);
    return true;
  } catch (err) {
    if (err.response?.status === 409) {
      log.ok?.('Deja membre de cette pool.');
      return true;
    }
    log.warn?.(err.response?.data?.error || err.message || 'Join API echoue — retry au start.bat');
    return false;
  }
}

/** SHA256 verify (early) or API join (after GPU register). */
export async function finalizePoolJoin({ config, models, gpuId, authToken, platformUrl, ask, log }) {
  if (config.poolMembership?.requiredSha256) {
    const ok = await registerPoolOnServer({ config, gpuId, authToken, platformUrl, log });
    return ok ? 'pool' : null;
  }
  const pool = config._pendingPool;
  if (!pool || config.servingMode !== 'pool') return null;
  return runPoolJoinFlow({
    config, models, gpuId, authToken, platformUrl, ask, log, pool,
  });
}

/**
 * Interactive pool join (full or finalize). Mutates config.
 * @returns {'solo'|'pool'|null}
 */
export async function runPoolSetupStep({ config, models, gpuId, authToken, platformUrl, ask, log }) {
  if (config._pendingPool && config.servingMode === 'pool') {
    const result = await finalizePoolJoin({ config, models, gpuId, authToken, platformUrl, ask, log });
    if (!result) {
      delete config.poolMembership;
      config.servingMode = 'solo';
      log.err?.('Echec join pool — mode solo. Relance : npm run join-pool');
    }
    return result;
  }

  printStepTitle(log, 'Mode de service');
  console.log('    1) Solo — catalogue public, tarif perso');
  console.log('    2) Pool — SHA256 GGUF identique\n');

  const mode = await ask('  Choix : tape 2 pour POOL, 1 pour solo [1] : ');
  if (isPoolChoice(mode)) {
    const early = await askServingModeEarly({ config, ask, log });
    if (early !== 'pool') return null;
    const result = await runPoolJoinFlow({
      config, models, gpuId, authToken, platformUrl, ask, log, pool: config._pendingPool,
    });
    if (!result) {
      delete config.poolMembership;
      config.servingMode = 'solo';
      log.err?.('Pool join failed — GPU stays in solo mode.');
      log.info?.('Fix SHA256 / GGUF path, then run: npm run join-pool');
    }
    return result;
  }
  delete config.poolMembership;
  delete config._pendingPool;
  config.servingMode = 'solo';
  log.ok?.('Solo mode — your GPU will appear in the public catalog.');
  return 'solo';
}

export async function runPoolJoinFlow({
  config, models, gpuId, authToken, platformUrl, ask, log, pool: poolIn, skipApiJoin = false,
}) {
  if (!skipApiJoin && !gpuId) {
    log.info?.('GPU pas encore enregistre — inscription serveur juste apres.');
  }

  let pool = poolIn;
  if (!pool) {
    const rawRef = await ask('\n  Numero de pool OU URL de la page : ');
    try {
      pool = await resolvePoolFromInput(platformUrl, rawRef);
    } catch (err) {
      log.err?.(err.message || formatLookupError(err, platformUrl));
      return null;
    }
  }

  log.ok?.(`Pool #${pool.poolNumber} — ${pool.displayName}`);
  log.info?.(`SHA256 requis : ${pool.modelSha256.slice(0, 16)}…${pool.modelSha256.slice(-8)}`);
  if (pool.modelSourceUrl) log.info?.(`Download: ${pool.modelSourceUrl}`);
  log.info?.(`Tarif pool : $${pool.ratePerHourUsd}/h · ctx ${pool.ctx.toLocaleString()}`);
  if (!pool.isOpen) {
    log.err?.('Cette pool est fermee aux nouveaux membres.');
    return null;
  }

  console.log('\n  Quel modele local verifier ?\n');
  models.forEach((m, i) => {
    const p = getGgufPathForModel(m) || m.scriptPath || '(no path)';
    console.log(`    ${i + 1}) ${m.name} — ${p}`);
  });

  let pickIdx = 0;
  if (models.length > 1) {
    const pick = await ask(`  Modele [1-${models.length}] (defaut 1) : `);
    pickIdx = Math.max(0, Math.min(models.length - 1, (parseInt(pick, 10) || 1) - 1));
  }
  const model = models[pickIdx];

  let ggufPath = getGgufPathForModel(model);
  if (!ggufPath && model.scriptPath) {
    const hinted = parseGgufPathFromScript(model.scriptPath);
    if (hinted) {
      log.info?.(`GGUF depuis le .bat : ${hinted}`);
      if (fs.existsSync(hinted)) {
        ggufPath = hinted;
        model.ggufPath = hinted;
        if (!model.path) model.path = hinted;
      } else {
        log.warn?.(`Fichier .bat introuvable : ${hinted}`);
      }
    }
  }
  if (!ggufPath) {
    const entered = await ask('  Chemin du fichier .gguf utilise par ce modele : ');
    if (!entered || !fs.existsSync(entered)) {
      log.err?.('Fichier GGUF introuvable — obligatoire pour la pool.');
      return null;
    }
    ggufPath = entered;
    model.ggufPath = entered;
    if (!model.path) model.path = entered;
  }

  log.info?.('Calcul SHA256 (peut prendre 1–2 min sur gros fichiers)…');
  const localHash = await hashModelFile(model, log);
  if (!localHash) {
    log.err?.('Impossible de hasher le GGUF.');
    return null;
  }

  if (localHash !== pool.modelSha256.toLowerCase()) {
    log.err?.('SHA256 different — ce n\'est pas le meme GGUF que la pool.');
    log.info?.(`  Attendu : ${pool.modelSha256}`);
    log.info?.(`  Obtenu  : ${localHash}`);
    return null;
  }

  log.ok?.('SHA256 OK — autorise a rejoindre la pool.');
  model.sha256 = localHash;
  model.rateUsdPerHour = pool.ratePerHourUsd;

  config.servingMode = 'pool';
  config.poolMembership = {
    poolNumber: pool.poolNumber,
    poolId: pool.id,
    requiredSha256: pool.modelSha256.toLowerCase(),
    localModelName: model.name,
    ggufPath: getGgufPathForModel(model),
    joinedAt: new Date().toISOString(),
  };
  delete config._pendingPool;

  if (skipApiJoin) {
    log.ok?.('Config pool sauvegardee — inscription serveur a l\'etape suivante.');
    return 'pool';
  }

  if (gpuId && authToken) {
    try {
      await joinPoolByNumber({
        platformUrl,
        authToken,
        gpuId,
        poolNumber: pool.poolNumber,
        modelSha256: localHash,
      });
      log.ok?.(`Inscrit sur la pool #${pool.poolNumber}.`);
    } catch (err) {
      if (err.response?.status === 409) {
        log.ok?.('Deja membre de cette pool.');
      } else {
        log.warn?.(err.response?.data?.error || err.message || 'Join API failed — retry au demarrage agent.');
      }
    }
  }

  return 'pool';
}

/** Re-verify SHA256 and refresh pool membership every agent start. */
export async function verifyPoolMembershipOnStart({ config, client, gpuId, configPath, log = console }) {
  const pm = config.poolMembership;
  if (!pm?.poolNumber || !pm.requiredSha256) return;

  const model = (config.models || []).find(m => m.name === pm.localModelName)
    || (config.models || []).find(m => m.sha256?.toLowerCase() === pm.requiredSha256.toLowerCase())
    || config.models?.[0];

  if (!model) {
    log.warn?.('Pool membership configured but no local model found — clearing pool config.');
    delete config.poolMembership;
    config.servingMode = 'solo';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return;
  }

  const ggufPath = pm.ggufPath || getGgufPathForModel(model);
  if (!ggufPath || !fs.existsSync(ggufPath)) {
    throw new Error(`Pool GGUF file missing: ${ggufPath || '(not set)'}`);
  }

  log.log?.('   Verifying pool GGUF SHA256…');
  const hash = await sha256File(ggufPath);
  if (hash !== pm.requiredSha256.toLowerCase()) {
    throw new Error(
      `Pool GGUF SHA256 mismatch on startup.\n`
      + `  Expected: ${pm.requiredSha256}\n`
      + `  Got:      ${hash}\n`
      + `  Fix the file or re-run setup — pool membership blocked.`,
    );
  }

  model.sha256 = hash;
  pm.ggufPath = ggufPath;

  try {
    await joinPoolByNumber({
      platformUrl: config.platformUrl,
      authToken: config.authToken,
      gpuId,
      poolNumber: pm.poolNumber,
      modelSha256: hash,
    });
    log.log?.(`   Pool #${pm.poolNumber} membership verified`);
  } catch (err) {
    if (err.response?.status === 409) {
      log.log?.(`   Pool #${pm.poolNumber} membership OK (already joined)`);
    } else {
      throw new Error(err.response?.data?.error || err.message || 'Pool join verification failed');
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Map pool session-start modelName to local config model name (SHA256-based). */
export function resolveModelForPoolSession(config, requestedModelName) {
  const pm = config.poolMembership;
  if (!pm?.requiredSha256) return requestedModelName;

  const bySha = (config.models || []).find(m =>
    m.sha256?.toLowerCase() === pm.requiredSha256.toLowerCase(),
  );
  if (bySha) return bySha.name;

  if (pm.localModelName) {
    const local = (config.models || []).find(m => m.name === pm.localModelName);
    if (local) return local.name;
  }

  return requestedModelName;
}
