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
    const failures = results.filter(result => !result.passed);
    assert.deepEqual(pageErrors, [], 'el componente no debe producir errores de JavaScript');
    assert.equal(failures.length, 0, `Controles solapados o recortados: ${JSON.stringify(failures.slice(0, 3))}`);
    console.log(`Barra superior: ${results.length} combinaciones verificadas y último favorito accesible. Evidencia: ${output}`);
} finally {
    await writeFile(join(output, 'toolbar-layout.json'), `${JSON.stringify(results, null, 2)}\n`);
    await browser?.close();
    await server.close();
}
