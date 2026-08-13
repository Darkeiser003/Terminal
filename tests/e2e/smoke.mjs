import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import process from 'node:process';

const driverPath = process.env.TAURI_DRIVER ?? 'tauri-driver';
const application = process.env.E2E_BINARY;
if (!application) throw new Error('E2E_BINARY debe apuntar al binario Tauri compilado');
await access(application);

const driver = spawn(driverPath, [], { stdio: ['ignore', 'inherit', 'inherit'] });
const endpoint = 'http://127.0.0.1:4444';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
let sessionId;

async function request(path, method = 'GET', body) {
    const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.value?.error) {
        throw new Error(`${method} ${path}: ${JSON.stringify(payload.value ?? payload)}`);
    }
    return payload.value;
}

async function waitForDriver() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try { await request('/status'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    throw new Error('tauri-driver no respondió en 15 segundos');
}

async function find(css) {
    const value = await request(`/session/${sessionId}/element`, 'POST', { using: 'css selector', value: css });
    return value[elementKey];
}

async function click(element) {
    await request(`/session/${sessionId}/element/${element}/click`, 'POST', {});
}

try {
    await waitForDriver();
    const created = await request('/session', 'POST', {
        capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    });
    sessionId = created.sessionId;
    await find('.toolbar');
    await find('.xterm');

    const buttons = await request(`/session/${sessionId}/elements`, 'POST', {
        using: 'css selector', value: 'button[data-panel-toggle]',
    });
    let settingsButton;
    for (const item of buttons) {
        const id = item[elementKey];
        const text = await request(`/session/${sessionId}/element/${id}/text`);
        if (/Ajustes|Settings/i.test(text)) { settingsButton = id; break; }
    }
    if (!settingsButton) throw new Error('No se encontró el botón de Ajustes');
    await click(settingsButton);
    const dialog = await find('[role="dialog"]');
    const title = await request(`/session/${sessionId}/element/${dialog}/text`);
    if (!/Preferencias|Settings|Ajustes/i.test(title)) throw new Error('El panel de Ajustes no se abrió');
    process.stdout.write('E2E OK: ventana, terminal, barra y panel de Ajustes operativos.\n');
} finally {
    if (sessionId) await request(`/session/${sessionId}`, 'DELETE').catch(() => {});
    driver.kill('SIGTERM');
}
