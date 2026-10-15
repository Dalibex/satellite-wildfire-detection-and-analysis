import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test.skip(process.env.FIREWATCH_STATELESS !== '1', 'Run with FIREWATCH_STATELESS=1');

test('stateless analysis renders browser-owned layers, exports and replaces results', async ({ page }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { requests.push(new URL(request.url()).pathname); });
  await page.goto('/');
  await expect(page.getByText(/máximo 4 MiB en total/)).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([
    resolve('../out/browser-tests/swir.png'), resolve('../out/browser-tests/truecolor.png'),
  ]);
  const analyze = page.getByRole('button', { name: 'Analizar imágenes', exact: true });
  await expect(page.getByRole('combobox', { name: 'Tipo de composición de truecolor.png' })).toBeVisible();
  await expect(analyze).toBeEnabled();
  await analyze.click();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible();
  const base = page.locator('.base-image');
  await expect.poll(() => base.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const originalUrl = await base.getAttribute('src');
  expect(originalUrl).toMatch(/^blob:/);
  await expect(page.locator('img.image-layer').first()).toHaveAttribute('src', /^blob:/);
  for (const name of ['Informe JSON', 'Imagen PNG', 'Informe PDF', 'Descargar todo (.zip)']) {
    const button = page.getByRole('button', { name, exact: true });
    const download = page.waitForEvent('download');
    await button.click();
    expect(await (await download).failure()).toBeNull();
  }
  await page.getByRole('button', { name: 'Volver a analizar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible();
  await expect(base).not.toHaveAttribute('src', originalUrl!);
  expect(await page.evaluate(async url => {
    try { await fetch(url!); return true; } catch { return false; }
  }, originalUrl)).toBe(false);
  expect(requests.some(path => path === '/api/process')).toBe(true);
  expect(requests.some(path => path.startsWith('/api/analyses'))).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toHaveCount(0);
  await expect(page.locator('.upload-item')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('oversized input is rejected before upload with the Vercel limit', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/Vercel admite hasta 4 MiB en total/).first()).toBeVisible();
});
