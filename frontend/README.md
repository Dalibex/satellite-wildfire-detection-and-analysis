# FireSentinel · frontend

Desde esta carpeta:

```bash
npm ci
npm run dev
npm run build
npm test
```

El desarrollo usa `http://127.0.0.1:5173` y el proxy `/api` definido en `vite.config.ts`.
Las pruebas de navegador arrancan su propia API en el puerto 8001 y Vite en el 5174.

## Contrato de entrada

- La interfaz acepta al menos una composición asignada, sin exigir SWIR ni True Color.
- Cada composición conserva su tipo en la petición. True Color nunca se envía como SWIR.
- La única opción editable es `max_side`. Las peticiones siempre incluyen `smoke_recovery: true` y omiten `sensitivity`.
- La API Python actual todavía exige SWIR. El flujo solo con True Color necesita compatibilidad en esa API.
  La prueba de envío solo con True Color sustituye esa respuesta para comprobar el contrato del frontend.

## Descargas

- El selector junto al título de exportación elige el idioma de los archivos sin cambiar la pantalla.
- El ZIP incluye los informes localizados, PNG, PDF, CSV, TXT y todos los recursos disponibles del análisis.
- `compositions/` contiene las bases a resolución de análisis. `layers/` incluye también las capas ocultas en el visor.
- `masks/` contiene PNG binarios: blanco (255) identifica la categoría y negro (0) identifica el resto.
- El PNG del resultado conserva la base y las capas visibles al iniciar la descarga.
- Si falta un recurso, la descarga ZIP falla completa. Se puede reintentar desde el mismo botón.
