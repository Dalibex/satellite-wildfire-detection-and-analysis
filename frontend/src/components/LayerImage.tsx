import { useEffect, useRef, useState } from 'react';
import { scaleLayerSvg } from '../layer-rendering';
import type { LayerKey } from '../domain';

interface Props {
  url: string;
  layer: LayerKey;
  lineScale: number;
  onError: (failed: boolean) => void;
}

export default function LayerImage({ url, layer, lineScale, onError }: Props) {
  const [document, setDocument] = useState<{ url: string; svg: string } | null>(null);
  const [source, setSource] = useState<{ url: string; href: string } | null>(null);
  const objectUrls = useRef(new Set<string>());
  const latestSource = useRef(url);
  useEffect(() => () => {
    for (const href of objectUrls.current) URL.revokeObjectURL(href);
    objectUrls.current.clear();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('layer_download_failed');
      const svg = await response.text();
      if (!controller.signal.aborted) setDocument({ url, svg });
    }).catch(() => { if (!controller.signal.aborted) onError(true); });
    return () => controller.abort();
  }, [url, onError]);

  useEffect(() => {
    if (lineScale === 1) { latestSource.current = url; setSource({ url, href: url }); return; }
    if (document?.url !== url) return;
    const href = URL.createObjectURL(new Blob([scaleLayerSvg(document.svg, lineScale)], { type: 'image/svg+xml' }));
    objectUrls.current.add(href);
    latestSource.current = href;
    setSource({ url, href });
  }, [url, document, lineScale]);

  return <img className="image-layer" data-layer={layer} src={source?.url === url ? source.href : url}
    alt="" aria-hidden="true" draggable={false} onError={() => onError(true)} onLoad={event => {
      if (event.currentTarget.getAttribute('src') !== latestSource.current) return;
      for (const href of objectUrls.current) {
        if (href !== event.currentTarget.src) { URL.revokeObjectURL(href); objectUrls.current.delete(href); }
      }
    }} />;
}
