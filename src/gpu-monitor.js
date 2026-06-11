// provider-agent/src/gpu-monitor.js
// Détection GPU via nvidia-smi

import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Convertit la valeur memory.total de nvidia-smi en Go entiers.
 * nvidia-smi renvoie "[N/A]" / "[Not Supported]" pour les GPU a memoire
 * unifiee (NVIDIA GB10 / Grace Blackwell, DGX Spark...) -> parseInt = NaN.
 * Dans ce cas on retombe sur la RAM systeme (memoire unifiee partagee).
 */
function resolveVramGb(rawMemory) {
  const vramMb = parseInt(rawMemory, 10);
  if (Number.isFinite(vramMb) && vramMb > 0) {
    return Math.floor(vramMb / 1024);
  }
  // Fallback memoire unifiee : la VRAM = RAM systeme totale.
  const systemGb = Math.floor(os.totalmem() / 1024 ** 3);
  return systemGb > 0 ? systemGb : 0;
}

export async function detectGpu() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
    );
    const [name, memory] = stdout.trim().split(',').map(s => s.trim());
    return {
      model: name && name !== '[N/A]' ? name : 'NVIDIA GPU',
      vramGb: resolveVramGb(memory),
    };
  } catch (err) {
    throw new Error('nvidia-smi non disponible. Drivers NVIDIA installés ?');
  }
}

/**
 * Liste TOUS les GPUs detectes avec leur index (pour multi-GPU).
 */
export async function detectAllGpus() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,uuid --format=csv,noheader'
    );
    return stdout.trim().split('\n').map(line => {
      const [idx, name, memory, uuid] = line.split(',').map(s => s.trim());
      const vramMb = parseInt(memory, 10);
      return {
        index: parseInt(idx, 10),
        model: name && name !== '[N/A]' ? name : 'NVIDIA GPU',
        vramGb: resolveVramGb(memory),
        vramMb: Number.isFinite(vramMb) && vramMb > 0 ? vramMb : null,
        uuid,
      };
    });
  } catch (err) {
    throw new Error('nvidia-smi non disponible. Drivers NVIDIA installés ?');
  }
}

export async function getGpuUtilization() {
  const { stdout } = await execAsync(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits'
  );
  const [util, memUsed] = stdout.trim().split(',').map(s => parseInt(s.trim()));
  return { utilizationPercent: util, vramUsedMb: memUsed };
}
