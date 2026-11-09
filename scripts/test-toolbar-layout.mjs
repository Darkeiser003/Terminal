#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { measureToolbarLayout, toolbarLayoutIsValid } from '../tests/e2e/toolbar-layout.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.E2E_CAPTURE_DIR
    ? resolve(process.env.E2E_CAPTURE_DIR)
    : await mkdtemp(join(tmpdir(), 'wterminal-toolbar-layout-'));
await mkdir(output, { recursive: true });
const server = await createServer({
    root,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false },
});
let browser;
const results = [];
try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(new URL('tests/ui/toolbar.html', server.resolvedUrls.local[0]).href);
    await page.locator('.toolbar').waitFor();
    for (const width of [480, 640, 900, 1920, 3840, 7680]) {
        await page.setViewportSize({ width, height: 270 });
        for (const favorites of [0, 3, 24]) {
            for (const refresh of [false, true]) for (const selector of [false, true]) {
                for (const language of ['es', 'en', 'de', 'fr', 'ru', 'ar', 'hi']) {
                    const options = { width, favorites, refresh, selector, language };
                    await page.evaluate(options => window.configureToolbar(options), options);
                    const snapshot = await page.evaluate(measureToolbarLayout);
                    results.push({ ...options, ...snapshot, passed: toolbarLayoutIsValid(snapshot) });
                    if (width === 480 && !favorites && !refresh && selector && language === 'es') {
                        await page.screenshot({ path: join(output, 'toolbar-minimum.png') });
                    }
                    if (width === 480 && favorites === 24 && refresh && selector && language === 'es') {
                        const last = page.locator('.repl-favorite').last();
                        await last.focus();
                        const reachable = await last.evaluate(node => {
                            const rect = node.getBoundingClientRect();
                            const container = node.parentElement.getBoundingClientRect();
                            const x = (Math.max(rect.left, container.left) + Math.min(rect.right, container.right)) / 2;
                            return node.parentElement.scrollLeft > 0
                                && document.elementFromPoint(x, (rect.top + rect.bottom) / 2) === node;
                        });
                        assert.equal(reachable, true, 'el último favorito debe ser accesible al desplazar la lista');
                        await last.press('Enter');
                        assert.equal(await page.evaluate(() => window.lastReplId), 'repl-23');
                        await page.screenshot({ path: join(output, 'toolbar-24-favorites.png') });
                    }
                }
            }
        }
    }
    // El menú de idioma (16 idiomas, unos 480 px) se salía por abajo con la
    // ventana por defecto en pantallas pequeñas y con la interfaz agrandada
    // (aviso de un usuario, 09-11). Se aplica el zoom igual que app.css
    // (`main > .toolbar { zoom: var(--ui-scale) }`) y se exige que quepa y que
    // el último idioma se alcance con scroll.
    const menuResults = [];
    for (const [width, height, scales] of [
        [980, 640, [1, 1.5, 2]],
        [980, 480, [1, 1.5, 2]],
        [1366, 768, [1, 1.5, 2]],
        [480, 270, [1]],
    ]) {
        await page.setViewportSize({ width, height });
        for (const scale of scales) {
            await page.evaluate(async scale => {
                await window.configureToolbar({ language: 'es' });
                document.documentElement.style.setProperty('--ui-scale', String(scale));
                document.querySelector('.toolbar').style.zoom = String(scale);
                document.querySelector('.lang-btn').click();
            }, scale);
            await page.locator('.lang-menu').waitFor();
            const fit = await page.evaluate(() => {
                const menu = document.querySelector('.lang-menu');
                const before = menu.getBoundingClientRect();
                const items = menu.querySelectorAll('.lang-item');
                const last = items[items.length - 1];
                menu.scrollTop = menu.scrollHeight;
                const after = menu.getBoundingClientRect();
                const lastRect = last.getBoundingClientRect();
                menu.scrollTop = 0;
                return {
                    items: items.length, top: before.top, bottom: before.bottom, left: before.left, right: before.right,
                    innerWidth, innerHeight, lastBottom: lastRect.bottom, menuBottom: after.bottom,
                };
            });
            const passed = fit.items >= 16 && fit.top >= -1 && fit.left >= -1
                && fit.bottom <= fit.innerHeight + 1 && fit.right <= fit.innerWidth + 1
                && fit.lastBottom <= fit.menuBottom + 1 && fit.lastBottom <= fit.innerHeight + 1;
            menuResults.push({ width, height, scale, ...fit, passed });
            if (width === 980 && height === 640 && scale === 1.5) {
                await page.screenshot({ path: join(output, 'language-menu-980x640-150.png') });
            }
            await page.locator('.lang-backdrop').dispatchEvent('mousedown');
            await page.locator('.lang-menu').waitFor({ state: 'detached' });
        }
    }
    await page.evaluate(() => {
        document.documentElement.style.removeProperty('--ui-scale');
        document.querySelector('.toolbar').style.zoom = '';
    });
    const menuFailures = menuResults.filter(result => !result.passed);
    assert.equal(menuFailures.length, 0, `Menú de idioma fuera de la ventana: ${JSON.stringify(menuFailures.slice(0, 3))}`);
    results.push(...menuResults.map(result => ({ languageMenu: true, ...result })));
    const failures = results.filter(result => !result.passed);
    assert.deepEqual(pageErrors, [], 'el componente no debe producir errores de JavaScript');
    assert.equal(failures.length, 0, `Controles solapados o recortados: ${JSON.stringify(failures.slice(0, 3))}`);
    console.log(`Barra superior: ${results.length} combinaciones verificadas y último favorito accesible. Evidencia: ${output}`);
} finally {
    await writeFile(join(output, 'toolbar-layout.json'), `${JSON.stringify(results, null, 2)}\n`);
    await browser?.close();
    await server.close();
}
