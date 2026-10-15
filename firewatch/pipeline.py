"""Orquestación del análisis completo de una escena."""
from __future__ import annotations

import json
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from . import __version__
from .burned import BurnResult, burn_score, segment_burned
from .composition import guess_composition
from .config import Params
from .fire import FireResult, detect_fire, wildfire_hot_pixels
from .geometry import GeoRef, mask_polygons, polygon_length, to_geojson
from .io import border_mask, load_rgb, match_size
from .masks import cloud_mask, smoke_mask_swir, smoke_mask_tc, water_mask
from .render import render_debug, render_overlay


@dataclass
class Analysis:
    swir: np.ndarray
    truecolor: np.ndarray | None
    wildfire: np.ndarray | None
    valid: np.ndarray
    water: np.ndarray
    smoke: np.ndarray | None
    cloud: np.ndarray
    burn: BurnResult
    fire: FireResult
    report: dict
    burn_polygons: list
    geojson: dict


def analyze(swir_path, truecolor_path=None, wildfire_path=None, params: Params | None = None,
            geo: GeoRef | None = None) -> Analysis:
    params = params or Params()
    geo = geo or GeoRef()

    swir, transp = load_rgb(swir_path)
    shape = swir.shape[:2]
    geo = geo.resolve(shape)
    valid = ~(transp | border_mask(swir))

    kind, kmetrics = guess_composition(swir, valid)
    comp_info = {"swir": {"detectado": kind, **kmetrics}}
    if kind != "swir":
        warnings.warn(f"La imagen indicada como SWIR parece '{kind}'. Revisa el orden de los ficheros.")

    tc = wf = None
    if truecolor_path:
        tc, tr2 = load_rgb(truecolor_path)
        tc = match_size(tc, shape, "imagen True Color")
        k2, m2 = guess_composition(tc)
        comp_info["truecolor"] = {"detectado": k2, **m2}
    if wildfire_path:
        wf, _ = load_rgb(wildfire_path)
        wf = match_size(wf, shape, "imagen Wildfire")
        k3, m3 = guess_composition(wf)
        comp_info["wildfire"] = {"detectado": k3, **m3}

    # --- 1. Vetos -------------------------------------------------------
    water = water_mask(swir, params.water, tc=tc, valid=valid)
    cloud = cloud_mask(swir, params.cloud, valid=valid)
    smoke_tc = smoke_mask_tc(tc, params.smoke, valid=valid) if tc is not None else None
    smoke = smoke_tc if smoke_tc is not None else smoke_mask_swir(swir, params.smoke, valid=valid)
    smoke = smoke & ~water & ~cloud

    # --- 2. Área quemada (reto básico) ---------------------------------
    score = burn_score(swir, valid & ~cloud, params.burn, tc=tc, smoke_tc=smoke_tc)
    burn = segment_burned(score, valid & ~cloud, water, params.burn)

    # --- 3. Fuego activo (reto avanzado) --------------------------------
    extra = None
    if wf is not None:
        extra, _levels = wildfire_hot_pixels(wf, valid, tc)
    fire = detect_fire(swir, valid, cloud, burn.footprint, smoke, params.fire, extra_candidates=extra)

    # --- 4. Métricas e informe ------------------------------------------
    polys = mask_polygons(burn.footprint)
    report = _build_report(shape, valid, water, smoke, cloud, burn, fire, polys, geo, comp_info,
                           params, bool(tc is not None), bool(wf is not None))
    gj = to_geojson(polys, [c for c in fire.clusters if c.confidence != "baja"], shape, geo,
                    {"generador": f"firewatch {__version__}"})
    return Analysis(swir, tc, wf, valid, water, smoke, cloud, burn, fire, report, polys, gj)


def _direction(x, y, w, h) -> str:
    col = 0 if x < w / 3 else (1 if x < 2 * w / 3 else 2)
    row = 0 if y < h / 3 else (1 if y < 2 * h / 3 else 2)
    names = [["noroeste", "norte", "noreste"], ["oeste", "centro", "este"], ["suroeste", "sur", "sureste"]]
    return names[row][col]


def _fmt(x: float, nd: int = 0) -> str:
    s = f"{x:,.{nd}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def _build_report(shape, valid, water, smoke, cloud, burn, fire, polys, geo, comp_info, params,
                  has_tc, has_wf) -> dict:
    h, w = shape
    n_valid = int(valid.sum())
    px_burn = int(burn.burned.sum())
    px_strict = int(burn.burned_strict.sum())
    perim_px = sum(polygon_length(p["outer"]) for p in polys)

    # Parte del perímetro que linda con humo => posible infraestimación
    smoke_border_frac = 0.0
    if smoke is not None and smoke.any() and burn.footprint.any():
        edge = burn.footprint & ~ndi.binary_erosion(burn.footprint)
        near_smoke = ndi.binary_dilation(smoke, iterations=3)
        smoke_border_frac = float((edge & near_smoke).sum() / max(edge.sum(), 1))

    m = geo.pixel_size_m
    area = {
        "pixeles": px_burn,
        "pixeles_estricto": px_strict,
        "porcentaje_imagen": round(100 * px_burn / max(n_valid, 1), 3),
    }
    perimeter = {"pixeles": round(perim_px, 1)}
    if m:
        area["hectareas"] = round(px_burn * m * m / 1e4, 1)
        area["hectareas_rango"] = [round(px_strict * m * m / 1e4, 1), area["hectareas"]]
        perimeter["km"] = round(perim_px * m / 1000, 2)

    # Confianza por polígono: puntuación media y tamaño relativo al mayor
    poly_info = []
    blab, bn = ndi.label(burn.footprint, structure=np.ones((3, 3)))
    if bn:
        sizes = np.bincount(blab.ravel())[1:]
        means = ndi.mean(burn.score, blab, index=np.arange(1, bn + 1))
        for i in np.argsort(-sizes):
            rel = sizes[i] / sizes.max()
            conf = "alta" if (means[i] >= 0.55 and rel >= 0.05) else ("media" if means[i] >= 0.4 else "baja")
            poly_info.append({"pixeles": int(sizes[i]), "puntuacion_media": round(float(means[i]), 3),
                              "tipo": "principal" if rel >= 0.05 else "secundario", "confianza": conf})

    accepted = [c for c in fire.clusters if c.confidence != "baja"]
    discarded = [c for c in fire.clusters if c.confidence == "baja"]

    has_fire_area = px_burn > 0
    centroid = None
    if has_fire_area:
        ys, xs = np.nonzero(burn.burned)
        centroid = (float(xs.mean()), float(ys.mean()))

    warnings_out = []
    if not m:
        warnings_out.append("Sin escala: superficie en píxeles y % de la imagen. "
                            "Indica --pixel-size o --bbox para obtener hectáreas.")
    if smoke_border_frac > 0.15:
        warnings_out.append(f"El {round(100 * smoke_border_frac)}% del perímetro linda con humo: "
                            "el área puede estar infraestimada en esa zona.")
    if not has_tc:
        warnings_out.append("Sin imagen True Color: el humo se estima solo desde SWIR (menos fiable).")

    report = {
        "version": __import__("firewatch").__version__,
        "imagen": {"ancho": w, "alto": h, "pixeles_validos": n_valid,
                   "tamano_pixel_m": round(m, 2) if m else None,
                   "composiciones": comp_info},
        "incendio_detectado": has_fire_area,
        "area_quemada": area,
        "perimetro": perimeter,
        "poligonos": poly_info,
        "islas_no_quemadas": int(ndi.label(burn.islands)[1]),
        "agua_dentro_perimetro_px": int(burn.water_inside.sum()),
        "agua_total_px": int(water.sum()),
        "humo_px": int(smoke.sum()) if smoke is not None else 0,
        "nubes_px": int(cloud.sum()),
        "fraccion_perimetro_con_humo": round(smoke_border_frac, 3),
        "focos_activos": [asdict(c) for c in accepted],
        "focos_descartados": [asdict(c) for c in discarded],
        "avisos": warnings_out,
        "parametros": params.to_dict(),
        "usa_wildfire": has_wf,
    }
    report["descripcion"] = describe(report, centroid, (w, h), accepted)
    return report


def describe(report: dict, centroid, size, accepted) -> str:
    """Texto alternativo / resumen en lenguaje natural (determinista)."""
    w, h = size
    if not report["incendio_detectado"]:
        return ("No se ha detectado ninguna zona quemada en la imagen. "
                + (f"Se han encontrado {len(accepted)} puntos calientes que conviene revisar." if accepted else ""))
    a = report["area_quemada"]
    if "hectareas" in a:
        lo, hi = a["hectareas_rango"]
        sup = f"de unas {_fmt(hi)} ha (rango {_fmt(lo)}–{_fmt(hi)} ha)"
    else:
        sup = f"que ocupa el {_fmt(a['porcentaje_imagen'], 1)} % de la imagen"
    parts = [f"Área quemada {sup}, situada al {_direction(*centroid, w, h)} de la imagen."]
    if "km" in report["perimetro"]:
        parts.append(f"Perímetro aproximado de {_fmt(report['perimetro']['km'], 1)} km.")
    if report["islas_no_quemadas"]:
        parts.append(f"Contiene {report['islas_no_quemadas']} islas interiores sin quemar.")
    if report["agua_dentro_perimetro_px"]:
        parts.append("Hay masas de agua dentro del perímetro, excluidas de la superficie.")
    if accepted:
        front = sum(1 for c in accepted if c.location == "frente")
        strong = sum(1 for c in accepted if c.intensity == "alta")
        dirs = sorted({_direction(*c.centroid_xy, w, h) for c in accepted})
        medium = sum(1 for c in accepted if c.confidence == "media")
        parts.append(f"{len(accepted)} focos activos ({front} en el frente"
                     + (f", {medium} de confianza media" if medium else "")
                     + ""
                     + (f", {strong} de intensidad alta" if strong else "")
                     + f"), en la zona {', '.join(dirs)}.")
    else:
        parts.append("No se detectan focos activos.")
    if report["fraccion_perimetro_con_humo"] > 0.15:
        parts.append("Parte del borde está cubierta por humo.")
    return " ".join(parts)


def save_outputs(an: Analysis, out_dir, base: str = "swir", debug: bool = True) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    base_img = {"swir": an.swir, "truecolor": an.truecolor, "wildfire": an.wildfire}.get(base)
    if base_img is None:
        base_img = an.swir
    r = an.report
    a = r["area_quemada"]
    lines = []
    if "hectareas" in a:
        lines.append(f"Superficie: {_fmt(a['hectareas_rango'][0])}–{_fmt(a['hectareas'])} ha")
    else:
        lines.append(f"Superficie: {_fmt(a['porcentaje_imagen'], 1)} % de la imagen")
    lines.append(f"Focos activos: {len(r['focos_activos'])}")
    overlay = render_overlay(base_img, an.burn, an.fire, an.smoke, lines)
    files = {}
    p = out / "resultado.png"; Image.fromarray(overlay).save(p); files["overlay"] = str(p)
    p = out / "mascara_quemado.png"; Image.fromarray((an.burn.burned * 255).astype(np.uint8)).save(p); files["mask_burned"] = str(p)
    p = out / "mascara_focos.png"; Image.fromarray((an.fire.accepted * 255).astype(np.uint8)).save(p); files["mask_fire"] = str(p)
    p = out / "resultado.geojson"; p.write_text(json.dumps(an.geojson, ensure_ascii=False)); files["geojson"] = str(p)
    p = out / "informe.json"; p.write_text(json.dumps(r, ensure_ascii=False, indent=2)); files["report"] = str(p)
    p = out / "descripcion.txt"; p.write_text(r["descripcion"] + "\n", encoding="utf-8"); files["alt_text"] = str(p)
    if debug:
        p = out / "diagnostico.png"
        render_debug(p, an.swir, an.burn.score, an.water, an.smoke, an.cloud, an.burn, an.fire, overlay)
        files["debug"] = str(p)
    return files
