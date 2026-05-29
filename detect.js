// provider-agent/src/auth.js
// Lecture du JWT depuis la config et construction d'un client HTTP authentifie.
//
// Le JWT est obtenu manuellement par le fournisseur (cf README.md) :
//   1. POST /api/auth/challenge { walletAddress }
//   2. Le wallet du fournisseur signe le challenge (Goby, chia CLI, etc.)
//   3. POST /api/auth/verify { walletAddress, pubkey, signature } -> { token }
//   4. Coller le token dans config.json sous `authToken`

import axios from 'axios';

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

export function createAuthClient(config) {
  if (!config.authToken) {
    throw new Error(
      'authToken manquant dans config.json — fais le flow /api/auth/challenge + /api/auth/verify ' +
      'puis colle le JWT obtenu (cf README.md)'
    );
  }

  const payload = decodeJwtPayload(config.authToken);
  if (payload?.exp && payload.exp * 1000 < Date.now()) {
    throw new Error('authToken expire — refais le flow d\'auth et mets a jour config.json');
  }

  const client = axios.create({
    baseURL: config.platformUrl,
    headers: { Authorization: `Bearer ${config.authToken}` },
    timeout: 15_000,
  });

  return { client, jwtPayload: payload };
}

export function buildWsUrl(config, gpuId) {
  const wsBase = config.platformUrl.replace(/^http/, 'ws');
  return `${wsBase}/api/gpus/ws/provider/${gpuId}?token=${encodeURIComponent(config.authToken)}`;
}
