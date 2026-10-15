import regularFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import boldFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';
import { assetUrl } from './api';
import { createArchive } from './archive';
import { compositionNames, layerKeys } from './domain';
import type { AnalysisResult, Composition, LayerVisibility } from './domain';
import { canvasBlob, composeResult, createPdf, describeReport, hotspotCsv } from './exports';
import i18n from './i18n';
import { scaleLayerSvg } from './layer-rendering';
import { smokeArrowSvg } from './smoke-direction';
import type { SmokeArrow } from './smoke-direction';

export type ExportLanguage = 'es' | 'en';
export type ExportFormat = 'png' | 'pdf' | 'json' | 'csv' | 'txt' | 'zip';
export interface ExportSettings {
  jobId: string;
  result: AnalysisResult;
  base: Composition;
  visible: LayerVisibility;
  opacity: number;
  lineScale: number;
  smokeArrow: SmokeArrow | null;
  showSmokeArrow: boolean;
  language: ExportLanguage;
}

/**
 * Reads an available analysis asset and rejects incomplete downloads.
 * @throws If the request fails, the file is missing, or the request is aborted.
 */
export async function fetchResource(jobId: string, file: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(assetUrl(jobId, file), { signal });
  if (!response.ok) throw new Error('resource_download_failed');
  return response.blob();
}

/**
 * Freezes the output language and includes hidden resources in complete ZIP exports.
 * @throws If any required resource, image, font, or export cannot be generated.
 */
export async function generateExport(settings: ExportSettings, format: ExportFormat, signal: AbortSignal): Promise<Blob> {
  const { jobId, result, base, visible, opacity, language, lineScale, smokeArrow, showSmokeArrow } = settings;
  const t = i18n.getFixedT(language);
  const nf = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const report = result.report;
  const smokeDescription = showSmokeArrow && smokeArrow
    ? `${t('viewerControls.smokeDirectionValue', { direction: t(`smokeDirections.${smokeArrow.direction}`) })} ${t('viewerControls.smokeDirectionHelp')}`
    : '';
  const description = [describeReport(report, t, nf), smokeDescription].filter(Boolean).join(' ');
  const notes = report.notes.map(note => t(`notes.${note}`));
  const json = new Blob([JSON.stringify({
    ...report, options: result.options, language, description, notes_text: notes,
    view: { base, visible_layers: layerKeys.filter(key => visible[key]), opacity, line_scale: lineScale, smoke_direction: showSmokeArrow ? smokeArrow : null },
  }, null, 2)], { type: 'application/json' });
  const text = new Blob([description + '\n\n' + notes.join('\n')], { type: 'text/plain;charset=utf-8' });
  const csv = new Blob([hotspotCsv(report, t)], { type: 'text/csv;charset=utf-8' });
  if (format === 'json') return json;
  if (format === 'txt') return text;
  if (format === 'csv') return csv;

  const canvas = await composeResult(jobId, result, base, visible, opacity, t, signal, lineScale, showSmokeArrow ? smokeArrow : null);
  const png = await canvasBlob(canvas);
  if (format === 'png') return png;
  const fonts = await Promise.all([regularFontUrl, boldFontUrl].map(async url => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('font_download_failed');
    return response.arrayBuffer();
  }));
  const visibleNames = layerKeys.filter(key => visible[key]).map(key => t(`layers.${key}`));
  if (showSmokeArrow && smokeArrow) visibleNames.push(t('viewerControls.smokeDirection'));
  const layerCaption = `${t('export.visibleLayers')}: ${visibleNames.join(', ') || t('export.noLayers')}. ${t('viewerControls.lineThickness')}: ${nf.format(lineScale * 100)}%.`;
  const pdf = await createPdf({
    language, title: t('export.pdfTitle'),
    generated: t('export.date', { date: new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(new Date()) }),
    descriptionTitle: t('description.title'), description, metricsTitle: t('metrics.title'),
    metrics: [
      `${t('metrics.burned')}: ${nf.format(report.burned_pixels)} px (${nf.format(report.burned_percent)}%).`,
      `${t('metrics.range')}: ${nf.format(report.strict_pixels)}–${nf.format(report.burned_pixels + report.probable_pixels)} px.`,
      `${t('metrics.perimeter')}: ${nf.format(report.perimeter_pixels)} px.`,
      `${t('metrics.water')}: ${nf.format(report.water_inside_pixels)} px.`,
      t('metrics.islands', { count: report.islands }), t('result.resolution', report),
    ],
    notesTitle: t('notes.title'), notes,
    hotspotsTitle: t('hotspots.title'), noHotspots: t('hotspots.empty'),
    hotspots: report.hotspots.map(hotspot => [
      `#${hotspot.id}`, `${t('hotspots.position')}: ${hotspot.centroid_xy.map(value => nf.format(value)).join(' / ')}`,
      `${t('hotspots.confidence')}: ${t(`hotspots.${hotspot.confidence}`)}`,
      `${t('hotspots.intensity')}: ${t(`hotspots.${hotspot.intensity}`)}`,
      t(`hotspots.${hotspot.location}`), `${nf.format(hotspot.n_pixels)} px`,
      hotspot.reasons.map(reason => t(`reasons.${reason}`)).join(', '),
    ].join(' · ')),
    imageTitle: t('export.pdfImage'), imageAlt: description, layerCaption,
    footer: t('export.resolutionNote'), image: canvas.toDataURL('image/png'),
    regularFont: fonts[0]!, boldFont: fonts[1]!,
  }, signal);
  if (format === 'pdf') return pdf;

  const prefix = `firesentinel-result-${language}`;
  const files: Record<string, Blob> = {
    [`${prefix}.png`]: png, [`${prefix}.pdf`]: pdf, [`${prefix}.json`]: json,
    [`${prefix}.csv`]: csv, [`${prefix}.txt`]: text,
    [`README-${language}.txt`]: new Blob([[
      'FireSentinel', t('export.zipHelp'), t('result.resolution', report),
      `${t('result.base')}: ${compositionNames[base]}`, layerCaption,
      ...(smokeArrow ? [t('viewerControls.smokeDirectionValue', { direction: t(`smokeDirections.${smokeArrow.direction}`) }), t('viewerControls.smokeDirectionHelp')] : []),
      t('export.masks'), t('export.masksHelp'), t('export.masksValues'),
      t('export.masksResolution'), t('export.resolutionNote'),
    ].join('\n\n')], { type: 'text/plain;charset=utf-8' }),
  };
  // Bound concurrent downloads while retaining every asset, including hidden layers.
  for (let offset = 0; offset < result.files.length; offset += 4) {
    await Promise.all(result.files.slice(offset, offset + 4).map(async file => {
      if (!/^[\w-]+\.[\w]+$/.test(file)) throw new Error('invalid_resource_name');
      const folder = file.startsWith('mask-') ? 'masks' : file.startsWith('base-') ? 'compositions' : file.startsWith('layer-') ? 'layers' : 'analysis';
      const resource = await fetchResource(jobId, file, signal);
      files[`${folder}/${file}`] = file.endsWith('.svg')
        ? new Blob([scaleLayerSvg(await resource.text(), lineScale)], { type: 'image/svg+xml' })
        : resource;
    }));
  }
  if (smokeArrow) files['layers/layer-smoke-direction.svg'] = new Blob([
    scaleLayerSvg(smokeArrowSvg(smokeArrow, report.width, report.height), lineScale),
  ], { type: 'image/svg+xml' });
  return createArchive(files, signal);
}
