import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

test.describe('local real-scene downloads', () => {
  test.skip(process.env.FIREWATCH_REAL_IMAGES !== '1', 'Uses optional local Sentinel-2 images.');

  for (const scene of ['avila', 'niebla']) {
    test(`${scene}: all download formats and ZIP are readable`, async ({ page }) => {
      test.setTimeout(180_000);
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
      await page.goto('/');
      await page.locator('input[type="file"]').setInputFiles([
        resolve(`../images/${scene}/swir.jpg`), resolve(`../images/${scene}/truecolor.jpg`),
      ]);
      await expect(page.getByRole('combobox', { name: 'Tipo de composición de truecolor.jpg', exact: true })).toHaveValue('truecolor');
      await page.getByRole('button', { name: 'Analizar imágenes', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Explora la escena' })).toBeVisible({ timeout: 90_000 });
      await page.getByRole('slider', { name: /Grosor de líneas/ }).fill('200');
      await expect(page.locator('[data-layer="perimeter"]')).toHaveAttribute('src', /^blob:/);
      for (const [name, extension] of [
        ['Imagen PNG', 'png'], ['Informe PDF', 'pdf'], ['Informe JSON', 'json'],
        ['Tabla CSV', 'csv'], ['Descripción TXT', 'txt'], ['Descargar todo (.zip)', 'zip'],
      ] as const) {
        console.log(`Exporting ${scene}: ${extension}`);
        const waiting = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByRole('button', { name, exact: true }).click();
        const download = await waiting;
        expect(await download.failure()).toBeNull();
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        const data = Buffer.concat(chunks);
        expect(data.length).toBeGreaterThan(0);
        if (extension === 'zip') {
          const files = unzipSync(data);
          expect(files['firesentinel-result-es.pdf']?.length).toBeGreaterThan(0);
          expect(files['masks/mask-burned.png']?.length).toBeGreaterThan(0);
          expect(JSON.parse(Buffer.from(files['firesentinel-result-es.json']!).toString()).view.line_scale).toBe(2);
        }
      }
    });
  }
});
