"""Línea de comandos.

Ejemplos:
    python -m firewatch --imagenes escena/*.jpg --out resultados/escena        (tipo detectado solo)
    python -m firewatch --swir swir.png --truecolor tc.png --out resultados/avila   (mejor resultado)
    python -m firewatch --truecolor tc.png --out resultados/avila                   (solo True Color)
    python -m firewatch --swir swir.png --out resultados/avila                      (solo SWIR)
    python -m firewatch --swir swir.jpg --truecolor tc.jpg --validar-con wildfire.jpg --out resultados/x
        (la Wildfire NO se usa para detectar: solo se compara después con lo detectado)
    python -m firewatch --lote images/ --out resultados/                       (todas las escenas)
"""
from __future__ import annotations

import argparse
import csv
import time
import warnings
from pathlib import Path

from .config import Params
from .geometry import GeoRef
from .pipeline import analyze, save_outputs

IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}


def _images_in(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT)


def _run_one(a, params, swir=None, tc=None, ref=None, extra=(), out=None, quiet=False):
    t0 = time.time()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")     # los avisos ya van al informe y se imprimen abajo
        an = analyze(swir, tc, params=params, extra_paths=[str(p) for p in extra], reference_path=ref,
                     geo=GeoRef(pixel_size_m=a.pixel_size, bbox=tuple(a.bbox) if a.bbox else None),
                     max_side=a.max_side or None)
    files = save_outputs(an, out, base=a.base, debug=not a.no_debug)
    dt = time.time() - t0
    if not quiet:
        r = an.report
        print(r["descripcion"])
        for wmsg in r["avisos"]:
            print("AVISO:", wmsg)
        print(f"Focos aceptados: {len(r['focos_activos'])} | descartados: {len(r['focos_descartados'])}")
        if r.get("validacion"):
            print(r["validacion"]["resumen"])
        print(f"Tiempo: {dt:.1f} s")
        for k, v in files.items():
            print(f"  {k}: {v}")
    return an, dt


def _batch(a, params) -> int:
    root = Path(a.lote)
    scenes = [d for d in sorted(root.iterdir()) if d.is_dir() and _images_in(d)]
    if _images_in(root):
        scenes.insert(0, root)
    if not scenes:
        print(f"No hay imágenes en {root} ni en sus subcarpetas.")
        return 1
    out_root = Path(a.out)
    out_root.mkdir(parents=True, exist_ok=True)
    rows = []
    for d in scenes:
        name = d.name if d != root else "raiz"
        imgs = _images_in(d)
        print(f"== {name} ({len(imgs)} imágenes)")
        try:
            an, dt = _run_one(a, params, extra=imgs, out=out_root / name, quiet=True)
            r = an.report
            comp = r["imagen"]["composiciones"]
            fa = r.get("fuego_activo") or {}
            ar = r["area_quemada"]
            rows.append({
                "escena": name,
                "entradas": r["modo"],
                "composiciones": " + ".join(sorted(comp)),
                "incendio_detectado": r["incendio_detectado"],
                "area_%": ar.get("porcentaje_imagen"),
                "area_ha": ar.get("hectareas", ""),
                "bajo_humo_ha": ar.get("hectareas_bajo_humo_probable", ""),
                "focos": len(r["focos_activos"]),
                "frente_km": fa.get("frente_activo_km", ""),
                "frente_%_perimetro": round(100 * fa.get("fraccion_perimetro_activo", 0), 1),
                "humo_hacia": fa.get("direccion_humo") or "",
                "val_focos_reales": (r.get("validacion") or {}).get("focos_reales_referencia", ""),
                "val_aciertos": (r.get("validacion") or {}).get("aciertos", ""),
                "val_falsos_positivos": (r.get("validacion") or {}).get("falsos_positivos", ""),
                "val_recall": (r.get("validacion") or {}).get("recall", ""),
                "val_precision": (r.get("validacion") or {}).get("precision", ""),
                "val_recall_candidatos": (r.get("validacion") or {}).get("recall_candidatos", ""),
                "avisos": len(r["avisos"]),
                "segundos": round(dt, 1),
                "error": "",
            })
            print("   " + r["descripcion"][:220] + ("…" if len(r["descripcion"]) > 220 else ""))
        except Exception as e:  # una escena mala no detiene el lote
            rows.append({"escena": name, "error": f"{type(e).__name__}: {e}"})
            print(f"   ERROR: {e}")
    fields = ["escena", "entradas", "composiciones", "incendio_detectado", "area_%", "area_ha", "bajo_humo_ha",
              "focos", "frente_km", "frente_%_perimetro", "humo_hacia",
              "val_focos_reales", "val_aciertos", "val_falsos_positivos", "val_recall", "val_precision",
              "val_recall_candidatos", "avisos", "segundos", "error"]
    p = out_root / "resumen.csv"
    with open(p, "w", newline="", encoding="utf-8-sig") as f:       # utf-8-sig: se abre bien en Excel
        w = csv.DictWriter(f, fieldnames=fields, delimiter=";")
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in fields})
    print(f"\nResumen de {len(rows)} escenas: {p}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="firewatch",
                                 description="Delimita el área quemada y detecta focos activos.")
    ap.add_argument("--imagenes", nargs="+", metavar="IMG",
                    help="Imágenes de UNA escena en cualquier orden: el tipo (SWIR / True Color / Wildfire) "
                         "se detecta automáticamente. Una Wildfire detectada se usa solo para validar.")
    ap.add_argument("--swir", help="ENTRADA: composición SWIR (B12-B8A-B4).")
    ap.add_argument("--truecolor", help="ENTRADA: composición True Color. Sirve SWIR, True Color o ambas "
                                        "(con ambas el resultado es el mejor); es decisión del usuario.")
    ap.add_argument("--validar-con", "--wildfire", dest="validar_con", metavar="WILDFIRE",
                    help="SOLO VALIDACIÓN (opcional): composición Wildfire de la misma escena. No interviene en "
                         "la detección; después se compara lo detectado con sus llamas y se calcula "
                         "recall / precisión.")
    ap.add_argument("--lote", metavar="CARPETA",
                    help="Analiza todas las escenas: cada subcarpeta de CARPETA es una escena con sus imágenes. "
                         "Genera un resultado por escena y un resumen.csv.")
    ap.add_argument("--out", required=True, help="Carpeta de salida.")
    ap.add_argument("--base", choices=["swir", "truecolor", "wildfire"], default="swir",
                    help="Imagen sobre la que se dibuja el resultado.")
    ap.add_argument("--pixel-size", type=float, help="Tamaño de píxel en metros de la imagen original (p. ej. 10).")
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("LON_MIN", "LAT_MIN", "LON_MAX", "LAT_MAX"),
                    help="Extensión geográfica WGS84 de la imagen.")
    ap.add_argument("--max-side", type=int, default=2500,
                    help="Lado mayor máximo en px para el análisis (por defecto 2500; 0 = tamaño original, lento).")
    ap.add_argument("--no-smoke-recovery", action="store_true",
                    help="No estimar el área quemada probable bajo el humo.")
    ap.add_argument("--no-debug", action="store_true", help="No generar el panel de diagnóstico.")
    a = ap.parse_args(argv)
    if not (a.imagenes or a.swir or a.truecolor or a.lote):
        ap.error("indica al menos una imagen de entrada: --swir y/o --truecolor, --imagenes, o --lote. "
                 "La Wildfire no es una entrada: va en --validar-con.")

    params = Params()
    if a.no_smoke_recovery:
        params.burn.smoke_recovery = False
    if a.lote:
        return _batch(a, params)
    try:
        _run_one(a, params, swir=a.swir, tc=a.truecolor, ref=a.validar_con, extra=a.imagenes or (), out=a.out)
    except ValueError as e:
        ap.error(str(e))
    return 0
