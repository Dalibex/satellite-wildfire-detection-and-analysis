import { useEffect, useRef, useState } from 'react';
import { scaleLayerSvg } from '../layer-rendering';
import { smokeArrowSvg } from '../smoke-direction';
import type { SmokeArrow } from '../smoke-direction';

interface Props { arrow: SmokeArrow; width: number; height: number; lineScale: number }

export default function SmokeDirectionLayer({ arrow, width, height, lineScale }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const objectUrls = useRef(new Set<string>());
  const latestSource = useRef<string | null>(null);
  useEffect(() => () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, []);
  useEffect(() => {
    const svg = scaleLayerSvg(smokeArrowSvg(arrow, width, height), lineScale);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    objectUrls.current.add(url);
    latestSource.current = url;
    setSource(url);
  }, [arrow, width, height, lineScale]);
  return source ? <img className="image-layer" data-layer="smoke_direction" src={source} alt="" aria-hidden="true" draggable={false} onLoad={event => {
    if (event.currentTarget.getAttribute('src') !== latestSource.current) return;
    for (const url of objectUrls.current) {
      if (url !== event.currentTarget.src) { URL.revokeObjectURL(url); objectUrls.current.delete(url); }
    }
  }} /> : null;
}
