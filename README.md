# firewatch · Detección de incendios en imágenes Sentinel-2

III Malackathon 2026 · Reto INDRA Espacio. **Iteración 1: motor de análisis (sin interfaz).**

Delimita el área quemada (reto básico) y detecta focos de fuego activo (reto avanzado) a partir de
las composiciones renderizadas de Sentinel-2 (PNG/JPG). No entrena ningún modelo: usa reglas basadas
en la física de la banda SWIR, con umbrales relativos a cada escena para generalizar a imágenes nuevas.

## Instalación

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

No necesita GPU.

## Uso

```bash
python -m firewatch --swir avila_swir.png --truecolor avila_tc.png --out resultados/avila
python -m firewatch --swir niebla_swir.png --truecolor niebla_tc.png --wildfire niebla_wildfire.png --out resultados/niebla
```

| Opción | Obligatoria | Para qué |
|---|---|---|
| `--swir` | sí | Composición SWIR (B12-B8A-B4). Es la que contiene la información clave. |
| `--truecolor` | recomendada | Detecta el humo y confirma agua y quemado. Mejora la precisión. |
| `--wildfire` | opcional | Añade los píxeles calientes de la composición Wildfire (experimental). |
| `--base swir\|truecolor\|wildfire` | no | Imagen sobre la que se dibuja el resultado (por defecto SWIR). |
| `--pixel-size 10` | no | Metros por píxel, para obtener hectáreas y km. |
| `--bbox LON_MIN LAT_MIN LON_MAX LAT_MAX` | no | Extensión geográfica: da hectáreas y coordenadas reales en el GeoJSON. |
| `--no-debug` | no | No genera el panel de diagnóstico. |

**Importante sobre la escala:** si la imagen se ha reescalado o es una captura de pantalla, el tamaño
de píxel ya no es 10/20 m. Sin `--pixel-size` ni `--bbox` el resultado se da en píxeles y % de la imagen.

## Salidas (en la carpeta `--out`)

| Fichero | Contenido |
|---|---|
| `resultado.png` | Imagen original con perímetro, área quemada (trama), agua excluida, humo y focos, más leyenda. |
| `diagnostico.png` | Panel de 6 vistas con cada paso intermedio. **Es el más útil para revisar y ajustar.** |
| `informe.json` | Todas las métricas, polígonos con confianza, focos aceptados y descartados (con motivo) y parámetros usados. |
| `descripcion.txt` | Resumen en lenguaje natural (base del texto alternativo accesible). |
| `resultado.geojson` | Área quemada (polígonos con islas) y focos (puntos). Abrible en QGIS o geojson.io. |
| `mascara_quemado.png`, `mascara_focos.png` | Máscaras binarias. |

## Tests

```bash
python -m pytest -q
```

19 tests sobre escenas sintéticas con verdad conocida, entre ellos:

- un lago y un río fuera del incendio **nunca** se marcan como quemados;
- un lago dentro del incendio queda dentro del perímetro pero **no** suma superficie;
- una isla sin quemar dentro del incendio se conserva;
- el frente activo en el borde se detecta con confianza alta;
- un tejado caliente aislado y una nube se rechazan como fuego;
- una escena sin incendio devuelve "no detectado";
- robustez frente a brillo ±20 %, compresión JPEG, reescalado ×0,5, marcos de captura y True Color de tamaño ligeramente distinto.

## Cómo funciona

```
SWIR (+ True Color, + Wildfire)
  │
  ├─ 0. Carga y zonas sin datos: transparencia y marcos uniformes en los bordes
  │     Autodetección del tipo de composición (aviso si los ficheros están cambiados)
  │
  ├─ 1. Máscaras de veto
  │     • Agua:  muy oscura en SWIR y SIN dominante roja (+ en True Color verde/azul oscura)
  │     • Humo:  en True Color, brillante, poco saturado y azulado (B ≥ R)
  │     • Nubes: blancas también en SWIR (el humo no lo es)
  │
  ├─ 2. Área quemada (BÁSICO)
  │     • Pseudo-NBR = (G−R)/(G+R) en SWIR ≈ NBR real (B8A vs B12); la ganancia se cancela
  │     • Puntuación = pseudo-NBR × (oscuridad relativa + saturación + oscuridad en True Color)
  │     • Histéresis: crecen solo regiones con un núcleo muy seguro
  │     • Limpieza morfológica y tamaño mínimo
  │     • Huecos: agua → dentro del perímetro, fuera del área; huecos grandes → islas sin quemar
  │
  ├─ 3. Fuego activo (AVANZADO)
  │     • Candidatos: rojo (B12) saturado y muy superior al verde (B8A), fuera de nubes
  │     • (+ píxeles calientes de la imagen Wildfire, si se aporta)
  │     • Contexto: en el borde del quemado → frente (alta); dentro → rescoldo (media);
  │       junto a un polígono pequeño y separado → media; aislado → descartado
  │     • Intensidad por cociente R/G (baja / media / alta)
  │
  └─ 4. Salidas: perímetro, superficie con rango (estricto–permisivo), confianza por polígono,
        aviso si el humo cubre el borde, imagen anotada accesible, GeoJSON, informe y descripción
```

Todos los umbrales están en `firewatch/config.py`, documentados. Son relativos a la escena o tienen
justificación física, y son los candidatos a sliders en la futura interfaz.

## Estructura

```
firewatch/
  config.py       parámetros
  io.py           carga, marcos, alineación de tamaños
  features.py     luminancia, saturación, pseudo-NBR
  composition.py  autodetección SWIR / True Color / Wildfire
  masks.py        agua, humo, nubes
  burned.py       área quemada (reto básico)
  fire.py         focos activos (reto avanzado)
  geometry.py     polígonos, perímetro, hectáreas, GeoJSON
  render.py       imagen anotada (Okabe-Ito, tramas, formas) y panel de diagnóstico
  pipeline.py     orquestación, informe y descripción textual
  cli.py          línea de comandos
tests/            escenas sintéticas y tests
```

## Limitaciones conocidas

- **Bajo humo denso** la propia composición SWIR queda contaminada (el humo eleva B4 y B8A), así que
  el quemado no se ve. El programa no inventa área ahí: marca la zona y avisa de que la superficie
  puede estar infraestimada.
- **Suelos rojizos y brillantes** (minería, como Riotinto cerca de Niebla) pueden aparecer como
  polígonos secundarios. Se marcan con confianza media.
- **La decodificación Wildfire** está implementada pero aún no se ha probado con una imagen real.
- **Las bandas crudas (GeoTIFF multibanda)** todavía no se aceptan; es la siguiente iteración ("modo experto").
