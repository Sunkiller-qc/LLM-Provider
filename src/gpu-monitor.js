// provider-agent/src/gpu-monitor.js
// Détection GPU via nvidia-smi

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function detectGpu() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'
    );
    const [name, memory] = stdout.trim().split(',').map(s => s.trim());
    const vramMb = parseInt(memory);
    return {
      model: name,
      vramGb: Math.floor(vramMb / 1024)
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
      const vramMb = parseInt(memory);
      return {
        index: parseInt(idx),
        model: name,
        vramGb: Math.floor(vramMb / 1024),
        vramMb,
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
