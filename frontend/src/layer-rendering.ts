export const MIN_LINE_SCALE = 0.5;
export const MAX_LINE_SCALE = 3;

/**
 * Scales layer contours and symbol outlines while retaining fills and hatching.
 * @throws If the scale is outside the supported 50–300% range.
 */
export function scaleLayerSvg(source: string, scale: number): string {
  if (!Number.isFinite(scale) || scale < MIN_LINE_SCALE || scale > MAX_LINE_SCALE) {
    throw new RangeError('invalid_line_scale');
  }
  if (scale === 1) return source;
  return source.split(/(<pattern\b[\s\S]*?<\/pattern>)/gi).map(fragment => {
    if (/^<pattern\b/i.test(fragment)) return fragment;
    return fragment.replace(/\bstroke-width\s*=\s*(["'])([\d.e+-]+)\1/gi, (match, quote: string, width: string) => {
      const value = Number(width);
      if (!Number.isFinite(value)) return match;
      return `stroke-width=${quote}${Number((value * scale).toFixed(3))}${quote}`;
    });
  }).join('');
}

export interface DecodedImage {
  image: HTMLImageElement;
  dispose: () => void;
}

/**
 * Keeps the image resource alive until its final canvas draw is complete.
 * @throws If loading, decoding, or SVG conversion fails, or the request is aborted.
 */
export async function decodeImageResource(url: string, signal: AbortSignal, lineScale = 1): Promise<DecodedImage> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`image_download_failed: ${response.status}`);
  let blob = await response.blob();
  if (lineScale !== 1 && (blob.type.includes('svg') || /\.svg(?:[?#]|$)/i.test(url))) {
    blob = new Blob([scaleLayerSvg(await blob.text(), lineScale)], { type: 'image/svg+xml' });
  }
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; URL.revokeObjectURL(objectUrl); } };
  const cancel = () => { image.src = ''; dispose(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    image.src = objectUrl;
    await image.decode();
    signal.throwIfAborted();
    return { image, dispose };
  } catch (error) {
    dispose();
    signal.throwIfAborted();
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}
