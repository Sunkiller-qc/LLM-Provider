// Pool membership flow for provider setup and runtime verification.

import fs from 'fs';
import axios from 'axios';
import { sha256File, formatBytes } from './gguf-hash.js';

export async function fetchPoolByNumber(platformUrl, poolNumber) {
  const { data } = await axios.get(`${platformUrl}/api/pools/lookup/${poolNumber}`, { timeout: 15_000 });
  return data.pool;
}

export async function joinPoolByNumber({ platformUrl, authToken, gpuId, poolNumber, modelSha256 }) {
  const { data } = await axios.post(
    `${platformUrl}/api/pools/join`,
    { poolNumber, gpuId, modelSha256: modelSha256.toLowerCase() },
    { headers: { Authorization: `Bearer ${authToken}` }, timeout: 30_000 },
  );
  return data;
}

/** Resolve GGUF path for hashing (direct path or user-provided path for .bat models). */
export function getGgufPathForModel(model) {
  if (model?.ggufPath && fs.existsSync(model.ggufPath)) return model.ggufPath;
  if (model?.path && fs.existsSync(model.path)) return model.path;
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
 * Interactive pool setup step. Mutates config.
 * @returns {'solo'|'pool'|null}
 */
export async function runPoolSetupStep({ config, models, gpuId, authToken, platformUrl, ask, log }) {
  log.title('Serving mode');
  console.log('  How do you want to serve your model?\n');
  console.log('    1) Solo — rent your GPU directly to clients');
  console.log('    2) Pool — join an existing model pool (SHA256 must match exactly)\n');

  const mode = await ask('  Choice [1/2] (default 1): ');
  if (mode === '2') {
    return runPoolJoinFlow({ config, models, gpuId, authToken, platformUrl, ask, log });
  }
  delete config.poolMembership;
  config.servingMode = 'solo';
  log.ok('Solo mode — your GPU will appear in the public catalog.');
  return 'solo';
}

async function runPoolJoinFlow({ config, models, gpuId, authToken, platformUrl, ask, log }) {
  if (!gpuId) {
    log.warn('GPU not registered yet — pool join will run after registration.');
  }

  const rawNum = await ask('\n  Enter pool number (shown on the pool page): ');
  const poolNumber = parseInt(rawNum, 10);
  if (!Number.isFinite(poolNumber) || poolNumber < 1) {
    log.err('Invalid pool number.');
    return null;
  }

  let pool;
  try {
    pool = await fetchPoolByNumber(platformUrl, poolNumber);
  } catch (err) {
    log.err(err.response?.data?.error || err.message || 'Pool lookup failed');
    return null;
  }

  log.ok(`Pool #${pool.poolNumber} — ${pool.displayName}`);
  log.info(`Required GGUF SHA256: ${pool.modelSha256.slice(0, 16)}…${pool.modelSha256.slice(-8)}`);
  if (pool.modelSourceUrl) log.info(`Download: ${pool.modelSourceUrl}`);
  log.info(`Pool rate: $${pool.ratePerHourUsd}/h · ctx ${pool.ctx.toLocaleString()}`);
  if (!pool.isOpen) {
    log.err('This pool is closed to new members.');
    return null;
  }

  console.log('\n  Select which local model file to verify:\n');
  models.forEach((m, i) => {
    const p = getGgufPathForModel(m) || m.scriptPath || '(no path)';
    console.log(`    ${i + 1}) ${m.name} — ${p}`);
  });

  let pickIdx = 0;
  if (models.length > 1) {
    const pick = await ask(`  Model to verify [1-${models.length}] (default 1): `);
    pickIdx = Math.max(0, Math.min(models.length - 1, (parseInt(pick, 10) || 1) - 1));
  }
  const model = models[pickIdx];

  if (!getGgufPathForModel(model)) {
    const ggufPath = await ask('  Path to the GGUF file used by this model: ');
    if (!ggufPath || !fs.existsSync(ggufPath)) {
      log.err('GGUF file not found — pool join requires the exact file path.');
      return null;
    }
    model.ggufPath = ggufPath;
  }

  log.info('Computing SHA256 (this may take a minute for large files)…');
  const localHash = await hashModelFile(model, log);
  if (!localHash) {
    log.err('Could not hash GGUF file.');
    return null;
  }

  if (localHash !== pool.modelSha256.toLowerCase()) {
    log.err('SHA256 mismatch — this file is NOT the same GGUF as the pool requires.');
    log.info(`  Expected: ${pool.modelSha256}`);
    log.info(`  Got:      ${localHash}`);
    return null;
  }

  log.ok('SHA256 match — authorized to join this pool.');
  model.sha256 = localHash;

  config.servingMode = 'pool';
  config.poolMembership = {
    poolNumber: pool.poolNumber,
    poolId: pool.id,
    requiredSha256: pool.modelSha256.toLowerCase(),
    localModelName: model.name,
    ggufPath: getGgufPathForModel(model),
    joinedAt: new Date().toISOString(),
  };

  if (gpuId && authToken) {
    try {
      await joinPoolByNumber({
        platformUrl,
        authToken,
        gpuId,
        poolNumber: pool.poolNumber,
        modelSha256: localHash,
      });
      log.ok(`Joined pool #${pool.poolNumber} on the platform.`);
    } catch (err) {
      if (err.response?.status === 409) {
        log.ok('Already a member of this pool.');
      } else {
        log.warn(err.response?.data?.error || err.message || 'Join API failed — will retry on agent start.');
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
