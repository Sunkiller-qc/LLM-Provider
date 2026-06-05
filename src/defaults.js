// URLs par defaut (production). Override via config.json → platformUrl.

export const DEFAULT_PLATFORM_URL = 'https://backend.chia-offer.com';
export const DEFAULT_FRONTEND_URL = 'https://llm.chia-offer.com';

export function normalizePlatformUrl(url) {
  const s = String(url || '').trim();
  if (!s) return DEFAULT_PLATFORM_URL;
  return s.replace(/\/+$/, '');
}

export function isLocalPlatformUrl(url) {
  return /localhost|127\.0\.0\.1/i.test(String(url || ''));
}

/** Normalise platformUrl et remplace localhost par la prod chia-offer.com. */
export function resolvePlatformUrl(url, { warn } = {}) {
  const normalized = normalizePlatformUrl(url);
  if (isLocalPlatformUrl(normalized)) {
    warn?.(`platformUrl local (${normalized}) — bascule sur ${DEFAULT_PLATFORM_URL}`);
    return DEFAULT_PLATFORM_URL;
  }
  return normalized;
}
