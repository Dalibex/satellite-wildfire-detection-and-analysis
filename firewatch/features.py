"""Magnitudes por píxel derivadas de una imagen RGB."""
import numpy as np

EPS = 1e-3


def channels(rgb: np.ndarray):
    return rgb[..., 0], rgb[..., 1], rgb[..., 2]


def luma(rgb: np.ndarray) -> np.ndarray:
    """Luminancia simple (media de canales), 0-255."""
    return rgb.mean(axis=-1)


def saturation(rgb: np.ndarray) -> np.ndarray:
    """Saturación tipo HSV en [0, 1]: (max - min) / max."""
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    return (mx - mn) / (mx + EPS)


def pseudo_nbr(swir_rgb: np.ndarray) -> np.ndarray:
    """Pseudo-NBR a partir de la composición SWIR (R=B12, G=B8A, B=B4).

    NBR real = (NIR - SWIR2) / (NIR + SWIR2) = (B8A - B12) / (B8A + B12).
    En la composición renderizada, G ≈ k·B8A y R ≈ k·B12 con la misma ganancia k,
    así que (G - R) / (G + R) aproxima el NBR (salvo saturación y compresión).
    Valores negativos => quemado; positivos => vegetación.
    """
    r, g, _ = channels(swir_rgb)
    return (g - r) / (g + r + EPS)


def red_excess(rgb: np.ndarray) -> np.ndarray:
    """Cuánto domina el rojo sobre los otros dos canales (puede ser negativo)."""
    r, g, b = channels(rgb)
    return r - np.maximum(g, b)
