import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
    cachedWindowsDriverPath,
    isCompatibleDriverVersion,
    parseWebView2Version,
    selectCompatibleDriver,
    versionBuild,
} from './e2e-native-driver.mjs';

assert.equal(parseWebView2Version('pv    REG_SZ    153.0.4234.48'), '153.0.4234.48');
assert.equal(parseWebView2Version('pv REG_SZ 0.0.0.0'), null);
assert.equal(versionBuild('153.0.4234.48'), '153.0.4234');
assert.equal(versionBuild('153.0.invalid'), null);
assert.equal(isCompatibleDriverVersion('153.0.4234.99', '153.0.4234.48'), true);
assert.equal(isCompatibleDriverVersion('153.0.4235.1', '153.0.4234.48'), false);
assert.equal(cachedWindowsDriverPath('project-root', '153.0.4234.48'), join('project-root', 'src-tauri', 'target', 'e2e-driver', '153.0.4234', 'msedgedriver.exe'));

const candidates = ['wrong.exe', 'compatible.exe'];
assert.equal(
    selectCompatibleDriver(candidates, '153.0.4234.48', (candidate) => candidate === 'compatible.exe' ? '153.0.4234.1' : '152.0.4234.1'),
    'compatible.exe',
);
assert.equal(selectCompatibleDriver(candidates, 'not-a-version', () => '153.0.4234.1'), null);

console.log('Edge WebDriver E2E: lectura de WebView2, coincidencia por build y selección de caché verificados.');
