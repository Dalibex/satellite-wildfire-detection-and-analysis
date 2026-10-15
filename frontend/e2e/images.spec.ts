import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';

async function uploadAndAnalyze(page: Page, clear = false, keyboard = false) {
  const files = clear ? resolve('../out/browser-tests/clear.png') : [resolve('../out/browser-tests/swir.png'), resolve('../out/browser-tests/truecolor.png')];
  if (keyboard) {
    await page.getByRole('button', { name: 'Seleccionar imágenes', exact: true }).focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(files);
  } else await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByRole('button', { name: 'Analizar imágenes' })).toBeEnabled();
  // The True Color upload must finish before the first run.
  if (!clear) await expect(page.getByRole('combobox', { name: 'Tipo de composición de truecolor.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Analizar imágenes' }).click();
  await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible();
}

test('real image flow supports layers, comparison, languages, themes, and every export', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  await page.goto('/');
  await uploadAndAnalyze(page);
  await expect(page.getByText('Área quemada detectada', { exact: true })).toBeVisible();
  const layer = page.getByRole('checkbox', { name: 'Quemado confirmado' });
  await layer.uncheck();
  await expect(page.locator('img.image-layer[src*="layer-burned"]')).toHaveCount(0);
  await layer.check();
  await page.getByRole('switch', { name: 'Comparar original y resultado' }).check();
  await page.getByRole('slider', { name: 'Posición del comparador' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider', { name: 'Posición del comparador' })).toHaveValue('51');
  await page.getByRole('button', { name: 'Ampliar imagen' }).click();
  await expect(page.locator('.zoom-controls output')).toHaveText('150%');
  await page.getByRole('button', { name: 'Ajustar imagen' }).click();
  await page.getByRole('combobox', { name: 'Simulación visual' }).selectOption('deuteranopia');
  await expect(page.locator('.image-stack')).toHaveCSS('filter', /deuteranopia/);

  const report = page.getByRole('button', { name: 'Informe JSON', exact: true });
  const download = page.waitForEvent('download'); await report.click();
  const jsonDownload = await download;
  expect(jsonDownload.suggestedFilename()).toContain('.json');
  const stream = await jsonDownload.createReadStream();
  let contents = ''; for await (const chunk of stream!) contents += chunk.toString();
  expect(JSON.parse(contents).burned_pixels).toBeGreaterThan(0);
  expect(contents).not.toMatch(/"bbox"|latitude|longitude|geojson/);

  for (const name of ['Imagen PNG', 'Informe PDF', 'Tabla CSV', 'Descripción TXT']) {
    const waiting = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name, exact: true }).click();
    const file = await waiting;
    expect(await file.failure()).toBeNull();
    if (name === 'Informe PDF') {
      const pdfStream = await file.createReadStream();
      const buffers: Buffer[] = []; for await (const chunk of pdfStream!) buffers.push(Buffer.from(chunk));
      const pdf = Buffer.concat(buffers).toString('latin1');
      expect(pdf.startsWith('%PDF')).toBe(true);
      expect(pdf).toContain('/StructTreeRoot');
      expect(pdf).toContain('/Lang (es)');
      expect(pdf).toContain('/FontFile2');
      expect(pdf).toContain('/Alt');
    }
  }
  await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Explore the scene' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#result-description')).toContainText('A burned area');
  for (const appearance of ['dark', 'contrast', 'light']) {
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption(appearance);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(accessibility.violations).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/desktop-results.png', fullPage: true });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('light');
  expect(browserErrors).toEqual([]);
});

test('mobile and keyboard navigation remain usable and handle invalid uploads', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.locator('input[type="file"]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
  await expect(page.getByText('El archivo no es una imagen PNG o JPG válida.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analizar imágenes' })).toBeDisabled();
  await uploadAndAnalyze(page, false, true);
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/mobile-results.png', fullPage: true });
});

test('a scene without fire returns a complete empty result', async ({ page }) => {
  await page.goto('/');
  await uploadAndAnalyze(page, true);
  await expect(page.getByText('Sin área quemada detectada', { exact: true })).toBeVisible();
  await expect(page.getByText('No hay focos activos aceptados.', { exact: true })).toBeVisible();
  await expect(page.locator('#result-description')).toContainText('No se ha detectado');
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
});
