// src/auth.js
// Read JWT from config and build an authenticated HTTP client.
//
// The JWT is obtained manually by the provider (see README.md):
//   1. POST /api/auth/challenge { walletAddress }
//   2. The provider's wallet signs the challenge (Goby, chia CLI, etc.)
//   3. POST /api/auth/verify { walletAddress, pubkey, signature } -> { token }
//   4. Paste the token in config.json under `authToken`

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
      'authToken missing in config.json — complete the /api/auth/challenge + /api/auth/verify flow ' +
      'then paste the JWT obtained (see README.md)'
    );
  }

  const payload = decodeJwtPayload(config.authToken);
  if (payload?.exp && payload.exp * 1000 < Date.now()) {
    throw new Error('authToken expired — redo the auth flow and update config.json');
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
