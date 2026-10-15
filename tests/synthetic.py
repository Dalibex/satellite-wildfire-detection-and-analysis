"""Generador de escenas SWIR/True Color sintéticas con verdad conocida.

Los colores imitan los medidos en imágenes Sentinel-2 reales (composición
SWIR B12-B8A-B4 de Sentinel Hub):
  vegetación ~(95,162,56) · quemado ~(120,80,45) · agua ~(5,8,15)
  fuego activo ~(255,90,60) · urbano/suelo rosado ~(200,150,140)
"""
from __future__ import annotations

import numpy as np

VEG = (95, 162, 56)
BURN = (120, 80, 45)
WATER = (5, 8, 15)
FIRE = (255, 90, 60)
URBAN_HOT = (225, 140, 115)
CLOUD = (240, 240, 238)

TC_VEG = (85, 88, 60)
TC_BURN = (95, 80, 60)
TC_WATER = (50, 80, 60)


def _disk(h, w, cy, cx, r):
    yy, xx = np.mgrid[:h, :w]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r


def make_scene(h=400, w=600, seed=0, burned=True, lake_inside=True, lake_outside=True,
               edge_fire=True, isolated_hot=True, cloud=False, border_rows=0):
    rng = np.random.default_rng(seed)
    swir = np.zeros((h, w, 3), np.float32) + VEG
    tc = np.zeros((h, w, 3), np.float32) + TC_VEG
    truth = {}

    # Área quemada con una isla interior sin quemar
    burn = (_disk(h, w, 200, 230, 110) & ~_disk(h, w, 200, 285, 25)) if burned else np.zeros((h, w), bool)
    swir[burn] = BURN
    tc[burn] = TC_BURN
    truth["burned"] = burn.copy()

    lake_in = _disk(h, w, 200, 200, 22) if (burned and lake_inside) else np.zeros((h, w), bool)
    lake_out = _disk(h, w, 90, 500, 35) if lake_outside else np.zeros((h, w), bool)
    # Río: franja fina y larga, típica fuente de falsos positivos
    river = np.zeros((h, w), bool)
    if lake_outside:
        river[300:304, 380:590] = True
    water = lake_in | lake_out | river
    swir[water] = WATER
    tc[water] = TC_WATER
    truth["burned"] &= ~water
    truth["water"] = water

    fire_px = np.zeros((h, w), bool)
    if burned and edge_fire:
        # Arco de fuego en el borde oeste del área quemada
        ang = np.linspace(np.pi * 0.8, np.pi * 1.2, 40)
        for a in ang:
            y, x = int(200 + 110 * np.sin(a)), int(230 + 110 * np.cos(a))
            fire_px[y - 1:y + 2, x - 1:x + 2] = True
    swir[fire_px] = FIRE
    truth["fire"] = fire_px

    iso = np.zeros((h, w), bool)
    if isolated_hot:
        iso[60:63, 120:123] = True   # tejado / industria lejos de cualquier quemado
        swir[iso] = URBAN_HOT
    truth["isolated_hot"] = iso

    if cloud:
        c = _disk(h, w, 340, 520, 25)
        swir[c] = CLOUD
        tc[c] = CLOUD
        truth["cloud"] = c

    swir += rng.normal(0, 6, swir.shape)
    tc += rng.normal(0, 5, tc.shape)
    if border_rows:
        swir[:border_rows] = (40, 40, 38)
        swir[-border_rows:] = (40, 40, 38)
        tc[:border_rows] = (40, 40, 38)
        tc[-border_rows:] = (40, 40, 38)
    return np.clip(swir, 0, 255).astype(np.uint8), np.clip(tc, 0, 255).astype(np.uint8), truth
