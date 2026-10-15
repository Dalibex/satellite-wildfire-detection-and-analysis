"""Utilidades morfológicas independientes de la versión de scikit-image."""
import numpy as np
from scipy import ndimage as ndi


def disk(r: int) -> np.ndarray:
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def remove_small(mask: np.ndarray, min_px: int) -> np.ndarray:
    """Elimina componentes conexas (8-vecindad) con menos de `min_px` píxeles."""
    if min_px <= 1 or not mask.any():
        return mask
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_px
    keep[0] = False
    return keep[lab]
