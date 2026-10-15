import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'react-bootstrap';
import { Download, FileJson, FileText, ImageDown, Sheet, LoaderCircle } from 'lucide-react';
import regularFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import boldFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';
import { assetUrl } from '../api';
import { layerKeys } from '../domain';
import type { AnalysisResult, Composition, LayerKey, LayerVisibility } from '../domain';
import { canvasBlob, composeResult, createPdf, downloadBlob, hotspotCsv } from '../exports';

interface Props {
  jobId: string; result: AnalysisResult; base: Composition; visible: LayerVisibility;
  opacity: number; description: string; notify: (key: string, error?: boolean) => void;
}

export default function ExportPanel({ jobId, result, base, visible, opacity, description, notify }: Props) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function save(format: string) {
    if (busy) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true);
    try {
      let blob: Blob;
      let extension = format;
      if (format === 'csv') blob = new Blob([hotspotCsv(result.report, t)], { type: 'text/csv;charset=utf-8' });
      else if (format === 'json') blob = new Blob([JSON.stringify({ ...result.report, options: result.options, language: i18n.language, description }, null, 2)], { type: 'application/json' });
      else if (format === 'txt') blob = new Blob([description + '\n\n' + result.report.notes.map(note => t(`notes.${note}`)).join('\n')], { type: 'text/plain;charset=utf-8' });
      else if (format.startsWith('mask-')) {
        const response = await fetch(assetUrl(jobId, format), { signal: request.signal });
        if (!response.ok) throw new Error('mask_failed');
        blob = await response.blob(); extension = 'png';
      } else {
        const canvas = await composeResult(jobId, result, base, visible, opacity, t, request.signal);
        if (format === 'png') blob = await canvasBlob(canvas);
        else {
          const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
          const report = result.report;
          const fonts = await Promise.all([regularFontUrl, boldFontUrl].map(async url => {
            const response = await fetch(url, { signal: request.signal });
            if (!response.ok) throw new Error('font_failed');
            return response.arrayBuffer();
          }));
          blob = await createPdf({
            language: i18n.language, title: t('export.pdfTitle'),
            generated: t('export.date', { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long', timeStyle: 'short' }).format(new Date()) }),
            descriptionTitle: t('description.title'), description, metricsTitle: t('metrics.title'),
            metrics: [
              `${t('metrics.burned')}: ${nf.format(report.burned_pixels)} px (${nf.format(report.burned_percent)}%).`,
              `${t('metrics.range')}: ${nf.format(report.strict_pixels)}–${nf.format(report.burned_pixels + report.probable_pixels)} px.`,
              `${t('metrics.perimeter')}: ${nf.format(report.perimeter_pixels)} px.`,
              `${t('metrics.water')}: ${nf.format(report.water_inside_pixels)} px.`,
              t('metrics.islands', { count: report.islands }), t('result.resolution', report),
            ],
            notesTitle: t('notes.title'), notes: report.notes.map(note => t(`notes.${note}`)),
            hotspotsTitle: t('hotspots.title'), noHotspots: t('hotspots.empty'),
            hotspots: report.hotspots.map(hotspot => [
              `#${hotspot.id}`, `${t('hotspots.position')}: ${hotspot.centroid_xy.map(value => nf.format(value)).join(' / ')}`,
              `${t('hotspots.confidence')}: ${t(`hotspots.${hotspot.confidence}`)}`,
              `${t('hotspots.intensity')}: ${t(`hotspots.${hotspot.intensity}`)}`,
              t(`hotspots.${hotspot.location}`), `${nf.format(hotspot.n_pixels)} px`,
              hotspot.reasons.map(reason => t(`reasons.${reason}`)).join(', '),
            ].join(' · ')),
            imageTitle: t('export.pdfImage'), imageAlt: description,
            layerCaption: `${t('export.visibleLayers')}: ${layerKeys.filter(key => visible[key]).map(key => t(`layers.${key}`)).join(', ') || t('export.noLayers')}.`,
            footer: t('export.resolutionNote'), image: canvas.toDataURL('image/png'),
            regularFont: fonts[0]!, boldFont: fonts[1]!,
          }, request.signal);
        }
      }
      if (!request.signal.aborted) {
        downloadBlob(blob, `firewatch-${format.startsWith('mask-') ? format.replace('.png', '') : 'result'}-${i18n.language}.${extension}`);
        notify('export.ready');
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) { console.error(error); notify('errors.export_failed', true); }
    } finally { if (!request.signal.aborted) setBusy(false); }
  }

  const exports = [
    { key: 'png', label: 'png', icon: ImageDown }, { key: 'pdf', label: 'pdf', icon: FileText },
    { key: 'json', label: 'json', icon: FileJson }, { key: 'csv', label: 'csv', icon: Sheet }, { key: 'txt', label: 'text', icon: FileText },
  ];
  return <section className="surface export-panel" aria-labelledby="export-title"><div className="section-heading"><h3 id="export-title"><Download size={21} aria-hidden="true" />{t('export.title')}</h3></div><p className="small muted">{t('export.help')}</p>
    <div className="export-buttons">{exports.map(({ key, label, icon: Icon }) => <Button key={key} variant="outline-secondary" disabled={busy} onClick={() => { void save(key); }}><Icon size={17} aria-hidden="true" />{t(`export.${label}`)}</Button>)}</div>
    <p role="status" aria-live="polite" className="small export-status">{busy && <><LoaderCircle size={15} className="spin" aria-hidden="true" /> {t('export.busy')}</>}</p>
    <details><summary>{t('export.masks')}</summary><div className="mask-downloads">{result.files.filter(file => file.startsWith('mask-')).map(file => {
      const key = file.replace('mask-', '').replace('.png', '') as LayerKey;
      return <Button variant="link" disabled={busy} key={file} onClick={() => { void save(file); }}><Download size={14} aria-hidden="true" />{t('export.mask', { name: t(`layers.${key}`) })}</Button>;
    })}</div></details>
  </section>;
}
