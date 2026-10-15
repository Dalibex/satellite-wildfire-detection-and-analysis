"""Identificación automática del tipo de composición (SWIR / True Color / Wildfire).

Heurística sencilla y explicable; el usuario siempre puede indicarlo a mano.
"""
from __future__ import annotations

import numpy as np

from .features import pseudo_nbr, saturation


def guess_composition(rgb: np.ndarray, valid: np.ndarray | None = None) -> tuple[str, dict]:
    """Devuelve ('swir' | 'truecolor' | 'wildfire', métricas usadas).

    - SWIR (B12-B8A-B4): la vegetación (mayoría del territorio) sale verde
      intenso => (G - R)/(G + R) mediano claramente positivo y saturación alta.
    - True Color: tonos ocres/olivas poco saturados, G ≈ R.
    - Wildfire: aspecto de True Color + píxeles naranja/amarillo muy saturados.
    """
    if valid is None:
        valid = np.ones(rgb.shape[:2], dtype=bool)
    v = rgb[valid]
    if v.size == 0:
        return "truecolor", {}
    sub = v[:: max(1, len(v) // 200_000)]
    pn = pseudo_nbr(sub[None])[0]
    sat = saturation(sub[None])[0]
    r, b = sub[:, 0], sub[:, 2]
    hot = (r >= 220) & (sat >= 0.6) & (r - b >= 120)
    metrics = {
        "median_pseudo_nbr": round(float(np.median(pn)), 3),
        "median_saturation": round(float(np.median(sat)), 3),
        "hot_fraction": round(float(hot.mean()), 6),
    }
    if metrics["median_pseudo_nbr"] > 0.04 and metrics["median_saturation"] > 0.3:
        kind = "swir"
    elif metrics["hot_fraction"] > 2e-5:
        kind = "wildfire"
    else:
        kind = "truecolor"
    return kind, metrics
