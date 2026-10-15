"""Carga de imágenes y detección de zonas sin datos."""
from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # las escenas Sentinel-2 completas superan el límite por defecto de PIL


def load_rgb(path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    """Carga una imagen como RGB float32 [0-255] y devuelve también la máscara de transparencia.

    Returns:
        rgb: array (H, W, 3) float32
        transparent: array (H, W) bool, True donde el canal alfa es 0
    """
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        arr = np.asarray(im)
        return arr[..., :3].astype(np.float32), arr[..., 3] == 0
    if im.mode not in ("RGB",):
        im = im.convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    return arr, np.zeros(arr.shape[:2], dtype=bool)


def load_rgb_scaled(path: str | Path, max_side: int | None = None,
                    size: tuple[int, int] | None = None):
    """Como load_rgb, pero reduce la imagen mientras la lee (ahorra tiempo y memoria).

    - max_side: si el lado mayor lo supera, se reduce proporcionalmente.
    - size: (ancho, alto) exacto de destino (para alinear con otra composición).

    Returns: rgb, transparent, (ancho_original, alto_original)
    """
    im = Image.open(path)
    ow, oh = im.size
    target = size
    if target is None and max_side and max(ow, oh) > max_side:
        f = max_side / max(ow, oh)
        target = (max(1, round(ow * f)), max(1, round(oh * f)))
    resized = False
    if target is not None and tuple(target) != (ow, oh):
        if im.format == "JPEG":
            im.draft("RGB", target)  # descodificación parcial: mucho más rápida
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB").resize(target, Image.BOX)
        resized = True
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        arr = np.asarray(im.convert("RGBA"))
        return arr[..., :3].astype(np.float32), arr[..., 3] < (128 if resized else 1), (ow, oh)
    arr = np.asarray(im.convert("RGB")).astype(np.float32)
    return arr, np.zeros(arr.shape[:2], dtype=bool), (ow, oh)


def match_size(img: np.ndarray, shape: tuple[int, int], name: str = "imagen") -> np.ndarray:
    """Redimensiona `img` a `shape` (H, W) si hace falta.

    Las composiciones de una misma escena vienen alineadas, pero pueden
    exportarse con tamaños ligeramente distintos (capturas, recortes).
    """
    h, w = shape
    if img.shape[:2] == (h, w):
        return img
    ar_ref, ar_img = w / h, img.shape[1] / img.shape[0]
    if abs(ar_ref - ar_img) / ar_ref > 0.02:
        warnings.warn(
            f"La {name} tiene una proporción distinta ({img.shape[1]}x{img.shape[0]}) "
            f"a la de referencia ({w}x{h}); la alineación puede no ser exacta."
        )
    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    return np.asarray(pil.resize((w, h), Image.BILINEAR)).astype(np.float32)


def border_mask(rgb: np.ndarray, max_std: float = 4.0, max_frac: float = 0.1) -> np.ndarray:
    """Marca filas/columnas uniformes en los bordes (marcos, barras de captura, relleno).

    Una fila real de imagen satelital nunca es de color uniforme; un marco sí.
    Solo se recorre desde cada borde hacia dentro y como máximo `max_frac` de la imagen.
    """
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), dtype=bool)
    row_std = rgb.std(axis=1).max(axis=1)  # (H,)
    col_std = rgb.std(axis=0).max(axis=1)  # (W,)

    def run(std, limit):
        n = 0
        while n < limit and std[n] < max_std:
            n += 1
        return n

    t = run(row_std, int(h * max_frac))
    b = run(row_std[::-1], int(h * max_frac))
    lft = run(col_std, int(w * max_frac))
    rgt = run(col_std[::-1], int(w * max_frac))
    if t:
        mask[:t] = True
    if b:
        mask[h - b:] = True
    if lft:
        mask[:, :lft] = True
    if rgt:
        mask[:, w - rgt:] = True
    return mask
