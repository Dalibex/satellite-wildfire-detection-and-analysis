import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

async function analyze(page: Page, clear = false) {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(clear ? resolve('../out/browser-tests/clear.png') : [resolve('../out/browser-tests/swir.png'), resolve('../out/browser-tests/truecolor.png')]);
  if (!clear) await expect(page.getByRole('combobox', { name: 'Tipo de composición de truecolor.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Analizar imágenes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible();
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('narrow portrait scenes export PNG, PDF, and complete ZIP without oversized canvases', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 2500;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#718264'; context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'true_color.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: 'Analizar imágenes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible();
  for (const name of ['Imagen PNG', 'Informe PDF', 'Descargar todo (.zip)']) {
    const waiting = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name, exact: true }).click();
    const download = await waiting;
    const content = await downloadBytes(download);
    expect(content.length).toBeGreaterThan(0);
    if (name === 'Imagen PNG') {
      const height = content.readUInt32BE(20);
      expect(height).toBeLessThan(2200);
    }
    if (name === 'Descargar todo (.zip)') {
      const files = unzipSync(content);
      expect(files['firesentinel-result-es.png']!.length).toBeGreaterThan(0);
      expect(files['firesentinel-result-es.pdf']!.length).toBeGreaterThan(0);
    }
  }
});

test('line thickness and smoke-direction toggle update live and persist in exported resources', async ({ page }) => {
  let analyses = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/analyses')) analyses++; });
  await analyze(page);
  const arrow = page.getByRole('checkbox', { name: 'Dirección estimada del humo', exact: true });
  await expect(arrow).toBeEnabled();
  await expect(arrow).toBeChecked();
  await expect(page.locator('[data-layer="smoke_direction"]')).toBeVisible();
  await arrow.uncheck();
  await expect(page.locator('[data-layer="smoke_direction"]')).toHaveCount(0);
  await arrow.check();
  const line = page.getByRole('slider', { name: /Grosor de líneas/ });
  await line.fill('200');
  const perimeter = page.locator('[data-layer="perimeter"]');
  await expect(perimeter).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => perimeter.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const updated = await perimeter.evaluate(async (image: HTMLImageElement) => (await fetch(image.src)).text());
  expect(updated).toContain('stroke-width="9"');
  const burned = await page.locator('[data-layer="burned"]').evaluate(async (image: HTMLImageElement) => (await fetch(image.src)).text());
  expect(burned).toContain('stroke-width="2"');
  expect(burned).toContain('fill-opacity="0.22"');
  await page.screenshot({ path: 'test-results/viewer-controls.png', fullPage: true });
  const waiting = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Descargar todo (.zip)', exact: true }).click();
  const files = unzipSync(await downloadBytes(await waiting));
  const report = JSON.parse(strFromU8(files['firesentinel-result-es.json']!));
  expect(report.view.line_scale).toBe(2);
  expect(report.view.smoke_direction.direction).toBe('s');
  expect(strFromU8(files['layers/layer-smoke-direction.svg']!)).toContain('stroke-width="12"');
  expect(strFromU8(files['layers/layer-perimeter.svg']!)).toBe(updated);
  await page.getByRole('button', { name: 'Restablecer grosor', exact: true }).click();
  await expect(line).toHaveValue('100');
  expect(analyses).toBe(1);
});

test('image can be dragged with the mouse and still supports keyboard and comparison controls', async ({ page }) => {
  await analyze(page);
  const viewport = page.getByRole('region', { name: 'Visor de imagen analizada', exact: true });
  await page.getByRole('button', { name: 'Ampliar imagen', exact: true }).click();
  await page.getByRole('button', { name: 'Ampliar imagen', exact: true }).click();
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + Math.min(box!.height / 2, 200));
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(50);
  const before = await viewport.evaluate(element => element.scrollLeft);
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(before);
  await page.getByRole('switch', { name: 'Comparar original y resultado', exact: true }).check();
  const comparison = page.getByRole('slider', { name: /Posición del comparador/ });
  await comparison.focus(); await page.keyboard.press('ArrowRight');
  await expect(comparison).toHaveValue('51');
  await page.getByRole('button', { name: 'Ajustar imagen', exact: true }).click();
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0);
});

test('a scene without smoke does not invent a direction arrow', async ({ page }) => {
  await analyze(page, true);
  await expect(page.getByRole('checkbox', { name: 'Dirección estimada del humo', exact: true })).toBeDisabled();
  await expect(page.locator('[data-layer="smoke_direction"]')).toHaveCount(0);
  await expect(page.getByText('No hay suficiente humo o separación respecto al quemado para estimar una dirección.', { exact: true })).toBeVisible();
});

test('a failed optional smoke mask does not block the other layers or downloads', async ({ page }) => {
  await page.route('**/files/mask-smoke.png', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await analyze(page);
  await expect(page.getByRole('checkbox', { name: 'Dirección estimada del humo', exact: true })).toBeDisabled();
  await expect(page.getByText('No se pudieron cargar las máscaras para estimar la dirección. Las demás capas siguen disponibles.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-layer="burned"]')).toBeVisible();
  for (const name of ['Informe JSON', 'Imagen PNG']) {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    expect((await downloadBytes(await waiting)).length).toBeGreaterThan(0);
  }
});
