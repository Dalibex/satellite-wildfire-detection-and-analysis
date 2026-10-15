import type { TFunction } from 'i18next';
import { assetUrl } from './api';
import { layerColors, layerKeys } from './domain';
import type { AnalysisResult, Composition, LayerVisibility, Report } from './domain';
import { decodeImageResource } from './layer-rendering';
import { smokeArrowSvg } from './smoke-direction';
import type { SmokeArrow } from './smoke-direction';

export function describeReport(report: Report, t: TFunction, nf: Intl.NumberFormat): string {
  const parts = [report.detected ? t('description.detected', {
    pixels: nf.format(report.burned_pixels), percent: nf.format(report.burned_percent), direction: t(`directions.${report.direction}`),
  }) : t('description.none'), t('description.fire', { count: report.hotspots.length })];
  if (report.probable_pixels) parts.push(t('description.probable', { pixels: nf.format(report.probable_pixels) }));
  if (report.water_inside_pixels || report.islands) parts.push(t('description.water'));
  return parts.join(' ');
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.hidden = true;
  document.body.append(anchor); anchor.click();
  setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 60_000);
}

export function hotspotCsv(report: Report, t: TFunction): string {
  const header = ['id', 'position', 'confidence', 'intensity', 'location', 'pixels', 'reasons'].map(key => t(`hotspots.${key}`));
  const rows = report.hotspots.map(hotspot => [
    hotspot.id, hotspot.centroid_xy.map(value => value.toFixed(1)).join(' / '),
    t(`hotspots.${hotspot.confidence}`), t(`hotspots.${hotspot.intensity}`),
    t(`hotspots.${hotspot.location}`), hotspot.n_pixels,
    hotspot.reasons.map(reason => t(`reasons.${reason}`)).join(' / '),
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
}

export async function composeResult(jobId: string, result: AnalysisResult, base: Composition,
  visible: LayerVisibility, opacity: number, t: TFunction, signal: AbortSignal,
  lineScale = 1, smokeArrow: SmokeArrow | null = null): Promise<HTMLCanvasElement> {
  const chosen = layerKeys.filter(key => visible[key]);
  const files = [result.bases[base] ?? result.bases.swir ?? result.bases.truecolor ?? result.bases.wildfire ?? '', ...chosen.map(key => result.layers[key].file)];
  const urls = files.map(filename => assetUrl(jobId, filename));
  let arrowUrl: string | null = null;
  if (smokeArrow) {
    arrowUrl = URL.createObjectURL(new Blob([smokeArrowSvg(smokeArrow, result.report.width, result.report.height)], { type: 'image/svg+xml' }));
    urls.push(arrowUrl);
  }
  const decoded = await Promise.allSettled(urls.map(url => decodeImageResource(url, signal, lineScale)));
  const resources = decoded.flatMap(resource => resource.status === 'fulfilled' ? [resource.value] : []);
  try {
    const failed = decoded.find(resource => resource.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    signal.throwIfAborted();
    const legends = [
      ...chosen.map(key => ({ key, name: t(`layers.${key}`), color: layerColors[key] })),
      ...(smokeArrow ? [{ key: 'smoke_direction', name: t('viewerControls.smokeDirection'), color: '#56B4E9' }] : []),
    ];
    const canvas = document.createElement('canvas');
    const preferredWidth = Math.max(900, Math.min(result.report.width, 1800));
    const scale = Math.min(preferredWidth / result.report.width, 1800 / result.report.height);
    const imageWidth = Math.max(1, Math.round(result.report.width * scale));
    const height = Math.max(1, Math.round(result.report.height * scale));
    canvas.width = Math.max(900, imageWidth);
    const imageLeft = (canvas.width - imageWidth) / 2;
    const rows = Math.ceil(legends.length / 2);
    canvas.height = height + 100 + Math.max(1, rows) * 36;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    resources.forEach(({ image }, index) => { context.globalAlpha = index === 0 ? 1 : opacity; context.drawImage(image, imageLeft, 0, imageWidth, height); });
    context.globalAlpha = 1;
    context.fillStyle = '#123e34'; context.font = 'bold 24px sans-serif';
    context.fillText('FireSentinel · ' + t('result.title'), 24, height + 36);
    context.fillStyle = '#343c3a'; context.font = '16px sans-serif';
    context.fillText(t('result.resolution', result.report), 24, height + 64);
    if (!legends.length) context.fillText(t('export.noLayers'), 24, height + 100);
    legends.forEach(({ key, name, color }, index) => {
      const x = 24 + (index % 2) * canvas.width / 2;
      const y = height + 90 + Math.floor(index / 2) * 36;
      context.save();
      context.fillStyle = color; context.strokeStyle = '#000000'; context.lineWidth = 2;
      if (key === 'fire') {
        context.beginPath(); context.moveTo(x + 11, y); context.lineTo(x, y + 18); context.lineTo(x + 22, y + 18); context.closePath(); context.fill(); context.stroke();
      } else if (key === 'smoke_direction') {
        context.beginPath(); context.moveTo(x, y + 9); context.lineTo(x + 24, y + 9); context.moveTo(x + 15, y + 2); context.lineTo(x + 24, y + 9); context.lineTo(x + 15, y + 16); context.stroke();
      } else if (key === 'perimeter' || key === 'front' || key === 'smoke' || key === 'smoke_low') {
        if (key === 'smoke' || key === 'smoke_low') context.setLineDash(key === 'smoke' ? [6, 4] : [2, 4]);
        for (const [stroke, thickness] of [['#000000', 7], ['#FFFFFF', 5], [color, 3]] as const) {
          context.strokeStyle = stroke; context.lineWidth = thickness;
          context.beginPath(); context.moveTo(x, y + 9); context.lineTo(x + 24, y + 9); context.stroke();
        }
      } else {
        context.fillRect(x, y, 22, 18); context.strokeRect(x, y, 22, 18);
        if (key === 'burned' || key === 'under_smoke') {
          context.beginPath(); context.moveTo(x, y + 14); context.lineTo(x + 14, y); context.moveTo(x + 8, y + 18); context.lineTo(x + 22, y + 4);
          if (key === 'under_smoke') { context.moveTo(x, y + 4); context.lineTo(x + 14, y + 18); context.moveTo(x + 8, y); context.lineTo(x + 22, y + 14); }
          context.stroke();
        }
      }
      context.restore();
      context.fillStyle = '#17221f'; context.font = '17px sans-serif';
      context.fillText(`${index + 1}. ${name}`, x + 34, y + 15);
    });
    return canvas;
  } finally {
    for (const resource of resources) resource.dispose();
    if (arrowUrl) URL.revokeObjectURL(arrowUrl);
  }
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('png_failed')), 'image/png'));
}

export interface PdfPayload {
  language: string;
  title: string;
  generated: string;
  descriptionTitle: string;
  description: string;
  metricsTitle: string;
  metrics: string[];
  notesTitle: string;
  notes: string[];
  hotspotsTitle: string;
  hotspots: string[];
  noHotspots: string;
  imageTitle: string;
  imageAlt: string;
  layerCaption: string;
  footer: string;
  image: string;
  regularFont: ArrayBuffer;
  boldFont: ArrayBuffer;
}

export async function createPdf(payload: PdfPayload, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { worker.terminate(); clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ buffer?: ArrayBuffer; error?: string }>) => {
      finish();
      if (event.data.buffer) resolve(new Blob([event.data.buffer], { type: 'application/pdf' }));
      else reject(new Error(event.data.error ?? 'pdf_failed'));
    };
    worker.onerror = event => { finish(); reject(new Error(event.message)); };
    worker.onmessageerror = () => { finish(); reject(new Error('pdf_message_failed')); };
    timer = setTimeout(() => { finish(); reject(new Error('pdf_timeout')); }, 60_000);
    try { worker.postMessage(payload, [payload.regularFont, payload.boldFont]); }
    catch (error) { finish(); reject(error); }
  });
}
