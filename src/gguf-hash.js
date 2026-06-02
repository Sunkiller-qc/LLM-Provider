// Stream SHA256 of a GGUF file (used for pool membership verification).

import fs from 'fs';
import crypto from 'crypto';

/**
 * @param {string} filePath
 * @param {(bytes: number, totalBytes: number|null) => void} [onProgress]
 */
export async function sha256File(filePath, onProgress) {
  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (onProgress) onProgress(bytes, totalBytes);
    });
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

export function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
