"""Reto avanzado: detección de focos de fuego activo.

Física: las llamas (800-1200 K) emiten muchísima radiación a 2,2 µm (B12) y,
si son intensas, también a 1,6 µm (B11). En la composición SWIR (R=B12)
eso aparece como canal rojo saturado, muy por encima del verde (B8A).
Ninguna superficie natural "fría" refleja tanto en B12 sin subir también B8A.

Después, cada candidato se valida por contexto espacial: el fuego vive en el
borde del área quemada (el frente) o, como rescoldo, dentro de ella.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi

from .config import FireParams
from .features import channels, saturation
from .morph import disk


@dataclass
class FireCluster:
    id: int
    centroid_xy: tuple[float, float]
    bbox_xywh: tuple[int, int, int, int]
    n_pixels: int
    peak_red: float
    mean_ratio: float          # R/G medio: proxy de intensidad
    intensity: str             # "baja" | "media" | "alta"
    location: str              # "frente" | "interior" | "aislado"
    near_smoke: bool
    confidence: str            # "alta" | "media" | "baja"
    reasons: list = field(default_factory=list)


@dataclass
class FireResult:
    candidates: np.ndarray          # píxeles calientes (antes del contexto)
    accepted: np.ndarray            # píxeles de focos aceptados
    clusters: list                  # todos los focos, aceptados y descartados
    edge_ring: np.ndarray


def hot_pixels(swir: np.ndarray, valid: np.ndarray, cloud: np.ndarray, p: FireParams) -> np.ndarray:
    r, g, b = channels(swir)
    m = (r >= p.min_red) & (r / (g + 1.0) >= p.min_red_green_ratio) & ((r - b) >= p.min_red_minus_blue)
    m &= saturation(swir) >= p.min_sat
    m &= valid & ~cloud
    return m


def _intensity(ratio: float, peak: float) -> str:
    if ratio >= 2.5 and peak >= 245:
        return "alta"
    if ratio >= 1.8:
        return "media"
    return "baja"


def detect_fire(swir: np.ndarray, valid: np.ndarray, cloud: np.ndarray, footprint: np.ndarray,
                smoke: np.ndarray | None, p: FireParams,
                extra_candidates: np.ndarray | None = None) -> FireResult:
    """Detecta focos y los valida por contexto.

    extra_candidates: píxeles calientes de otra fuente (p. ej. la imagen Wildfire),
    que se suman a los detectados en SWIR antes del análisis de contexto.
    """
    h, w = swir.shape[:2]
    diag = float(np.hypot(h, w))
    cand = hot_pixels(swir, valid, cloud, p)
    if extra_candidates is not None:
        cand |= extra_candidates & valid & ~cloud

    ring_px = max(p.edge_ring_min_px, int(round(p.edge_ring_frac * diag)))
    if footprint.any():
        dist_out = ndi.distance_transform_edt(~footprint)   # distancia desde fuera hasta el quemado
        dist_in = ndi.distance_transform_edt(footprint)     # distancia desde dentro hasta el borde
        edge_ring = (dist_out <= ring_px) & (dist_in <= ring_px)
    else:
        dist_out = np.full((h, w), np.inf)
        dist_in = np.zeros((h, w))
        edge_ring = np.zeros((h, w), dtype=bool)

    if smoke is not None and smoke.any():
        smoke_near = ndi.distance_transform_edt(~smoke) <= max(3, p.smoke_near_frac * diag)
    else:
        smoke_near = np.zeros((h, w), dtype=bool)

    merge_px = max(p.cluster_merge_min_px, int(round(p.cluster_merge_frac * diag)))
    grouped = ndi.binary_dilation(cand, structure=disk(merge_px)) if cand.any() else cand

    # Polígonos quemados principales vs. secundarios (pequeños respecto al mayor)
    main_burn = footprint
    if footprint.any():
        blab, bn = ndi.label(footprint, structure=np.ones((3, 3)))
        bsizes = np.bincount(blab.ravel()); bsizes[0] = 0
        main_burn = bsizes[blab] >= p.secondary_frac * bsizes.max()
        main_burn &= footprint
        dist_main = ndi.distance_transform_edt(~main_burn)
    else:
        dist_main = np.full((h, w), np.inf)
    lab, n = ndi.label(grouped, structure=np.ones((3, 3)))
    lab = np.where(cand, lab, 0)

    r, g, _ = channels(swir)
    ratio = r / (g + 1.0)
    clusters = []
    accepted = np.zeros((h, w), dtype=bool)
    objs = ndi.find_objects(lab)
    cid = 0
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        sub = lab[sl] == i
        if not sub.any():
            continue
        ys, xs = np.nonzero(sub)
        ys = ys + sl[0].start
        xs = xs + sl[1].start
        cid += 1
        on_edge = bool(edge_ring[ys, xs].any())
        inside = bool(footprint[ys, xs].mean() > 0.5) if footprint.any() else False
        near_burn = float(dist_out[ys, xs].min()) <= ring_px
        nsmoke = bool(smoke_near[ys, xs].any())
        peak = float(r[ys, xs].max())
        mratio = float(ratio[ys, xs].mean())
        reasons = []
        near_main = float(dist_main[ys, xs].min()) <= ring_px
        if on_edge or near_burn:
            location = "frente"
            reasons.append("en el borde del área quemada")
            conf = "alta" if near_main else "media"
            if not near_main:
                reasons.append("junto a un polígono quemado pequeño y separado")
        elif inside:
            location, conf = "interior", "media"
            reasons.append("dentro del área quemada (posible rescoldo)")
        else:
            location = "aislado"
            reasons.append("lejos de cualquier área quemada")
            # Un punto caliente aislado solo se acepta si es muy intenso y está junto a humo
            conf = "media" if (nsmoke and mratio >= 2.5) else "baja"
        if nsmoke:
            reasons.append("junto a humo")
            if conf == "media" and location == "interior":
                conf = "alta"
        intensity = _intensity(mratio, peak)
        clusters.append(FireCluster(
            id=cid,
            centroid_xy=(float(xs.mean()), float(ys.mean())),
            bbox_xywh=(int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)),
            n_pixels=int(len(xs)), peak_red=peak, mean_ratio=round(mratio, 3),
            intensity=intensity, location=location, near_smoke=nsmoke,
            confidence=conf, reasons=reasons,
        ))
        if conf != "baja":
            accepted[ys, xs] = True
    return FireResult(candidates=cand, accepted=accepted, clusters=clusters, edge_ring=edge_ring)


def wildfire_hot_pixels(wf: np.ndarray, valid: np.ndarray, tc: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Decodifica la imagen "Wildfire" (script de Pierre Markuse, Sentinel Hub).

    El script pinta encima del color natural los píxeles con B12+B11 > {1.0, 1.25, 1.5, 2.0}
    en rojo -> naranja -> amarillo según intensidad. Devuelve (máscara, nivel 1-3).

    EXPERIMENTAL: no se ha podido probar aún con una imagen Wildfire real.
    """
    r, g, b = channels(wf)
    sat = saturation(wf)
    hot = (r >= 200) & (sat >= 0.5) & (r - b >= 100) & valid
    if tc is not None:
        # Debe ser claramente más rojo/brillante que el mismo píxel en True Color
        hot &= (r - tc[..., 0]) >= 40
    hue_ratio = g / (r + 1.0)          # 0 = rojo puro, ~1 = amarillo
    level = np.zeros(r.shape, dtype=np.uint8)
    level[hot & (hue_ratio < 0.45)] = 1
    level[hot & (hue_ratio >= 0.45) & (hue_ratio < 0.75)] = 2
    level[hot & (hue_ratio >= 0.75)] = 3
    return hot, level
