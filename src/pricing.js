// src/pricing.js
// Same logic as backend/src/lib/pricing.js (standalone agent)

export const DEFAULT_UTILIZATION = 0.95;

export function millionsPerHour(tokensPerSec, utilization = 1) {
  if (!tokensPerSec || tokensPerSec <= 0) return 0;
  return (tokensPerSec * 3600) / 1_000_000 * utilization;
}

export function hourlyFromUsdPerM(usdPerM, tokensPerSec, utilization = DEFAULT_UTILIZATION) {
  return usdPerM * millionsPerHour(tokensPerSec, utilization);
}

export function printRateHints(tokensPerSec, log) {
  if (!tokensPerSec || tokensPerSec <= 0) return;
  const cheap = hourlyFromUsdPerM(0.1, tokensPerSec);
  const composer = hourlyFromUsdPerM(2.5, tokensPerSec);
  const sonnet = hourlyFromUsdPerM(15, tokensPerSec);
  log.info(`Rate hint (${tokensPerSec} tok/s, ${Math.round(DEFAULT_UTILIZATION * 100)}% utilization):`);
  console.log(`      ≈ cheap API (0.10 $/M)     → ${cheap.toFixed(3)} $/h min`);
  console.log(`      ≈ Composer 2 out (2.50 $/M) → ${composer.toFixed(3)} $/h`);
  console.log(`      ≈ Sonnet out (15 $/M)       → ${sonnet.toFixed(3)} $/h`);
}
