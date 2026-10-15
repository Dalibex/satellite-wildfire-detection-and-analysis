import { assetUrl } from './api';
import type { AnalysisResult } from './domain';
import { decodeImageResource } from './layer-rendering';

const compass = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export interface SmokeArrow {
  origin: [number, number];
  target: [number, number];
  direction: typeof compass[number];
}

function centroid(image: HTMLImageElement, width: number, height: number): [number, number] | null {
  const canvas = document.createElement('canvas');
  const ratio = Math.min(1, 512 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas_unavailable');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let weight = 0;
  let xSum = 0;
  let ySum = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const value = pixels[(y * canvas.width + x) * 4] ?? 0;
      weight += value;
      xSum += (x + 0.5) * value;
      ySum += (y + 0.5) * value;
    }
  }
  return weight ? [xSum / weight * width / canvas.width, ySum / weight * height / canvas.height] : null;
}

/**
 * Estimates image-space smoke direction from burn and high-confidence smoke masks.
 * Returns null without both regions or when their centroids are too close to distinguish direction.
 * @throws If either mask cannot be downloaded or decoded, or the operation is aborted.
 */
export async function estimateSmokeArrow(jobId: string, result: AnalysisResult, signal: AbortSignal): Promise<SmokeArrow | null> {
  const { report } = result;
  if (!report.burned_pixels || !report.smoke_pixels) return null;
  const resources = await Promise.allSettled(['mask-burned.png', 'mask-smoke.png'].map(file => decodeImageResource(assetUrl(jobId, file), signal)));
  try {
    const burned = resources[0];
    const smoke = resources[1];
    if (burned?.status !== 'fulfilled') throw burned?.reason ?? new Error('burn_mask_missing');
    if (smoke?.status !== 'fulfilled') throw smoke?.reason ?? new Error('smoke_mask_missing');
    signal.throwIfAborted();
    const origin = centroid(burned.value.image, report.width, report.height);
    const target = centroid(smoke.value.image, report.width, report.height);
    if (!origin || !target) return null;
    const dx = target[0] - origin[0];
    const dy = target[1] - origin[1];
    if (Math.hypot(dx, dy) < Math.hypot(report.width, report.height) * 0.02) return null;
    const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    return { origin, target, direction: compass[Math.round(angle / 45) % 8]! };
  } finally {
    for (const resource of resources) if (resource.status === 'fulfilled') resource.value.dispose();
  }
}

/**
 * Draws an outlined arrow with coordinates in analysis pixels.
 */
export function smokeArrowSvg(arrow: SmokeArrow, width: number, height: number): string {
  const [x, y] = arrow.origin;
  const [endX, endY] = arrow.target;
  const dx = endX - x;
  const dy = endY - y;
  const length = Math.hypot(dx, dy);
  const head = Math.min(length / 3, Math.max(12, Math.hypot(width, height) * 0.014));
  const ux = dx / length;
  const uy = dy / length;
  const path = `M${x},${y}L${endX},${endY}M${endX - ux * head - uy * head * 0.55},${endY - uy * head + ux * head * 0.55}L${endX},${endY}L${endX - ux * head + uy * head * 0.55},${endY - uy * head - ux * head * 0.55}`;
  const thickness = Math.max(2, Math.hypot(width, height) / 600);
  const strokes = [['#000000', thickness + 4], ['#FFFFFF', thickness + 2], ['#56B4E9', thickness]] as const;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + strokes.map(([color, size]) => `<path d="${path}" fill="none" stroke="${color}" stroke-width="${size}" stroke-linecap="round" stroke-linejoin="round"/>`).join('') + '</svg>';
}
