"""Línea de comandos.

Ejemplo:
    python -m firewatch --swir swir.png --truecolor tc.png --out resultados/avila
"""
from __future__ import annotations

import argparse
import time

from .geometry import GeoRef
from .pipeline import analyze, save_outputs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="firewatch",
                                 description="Delimita el área quemada y detecta focos activos.")
    ap.add_argument("--swir", required=True, help="Composición SWIR (B12-B8A-B4). Obligatoria.")
    ap.add_argument("--truecolor", help="Composición True Color de la misma escena (recomendada).")
    ap.add_argument("--wildfire", help="Composición Wildfire de la misma escena (opcional).")
    ap.add_argument("--out", required=True, help="Carpeta de salida.")
    ap.add_argument("--base", choices=["swir", "truecolor", "wildfire"], default="swir",
                    help="Imagen sobre la que se dibuja el resultado.")
    ap.add_argument("--pixel-size", type=float, help="Tamaño de píxel en metros (p. ej. 10 o 20).")
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("LON_MIN", "LAT_MIN", "LON_MAX", "LAT_MAX"),
                    help="Extensión geográfica WGS84 de la imagen.")
    ap.add_argument("--no-debug", action="store_true", help="No generar el panel de diagnóstico.")
    a = ap.parse_args(argv)

    t0 = time.time()
    an = analyze(a.swir, a.truecolor, a.wildfire,
                 geo=GeoRef(pixel_size_m=a.pixel_size, bbox=tuple(a.bbox) if a.bbox else None))
    files = save_outputs(an, a.out, base=a.base, debug=not a.no_debug)
    r = an.report
    print(r["descripcion"])
    for w in r["avisos"]:
        print("AVISO:", w)
    print(f"Focos aceptados: {len(r['focos_activos'])} | descartados: {len(r['focos_descartados'])}")
    print(f"Tiempo: {time.time() - t0:.1f} s")
    for k, v in files.items():
        print(f"  {k}: {v}")
    return 0
