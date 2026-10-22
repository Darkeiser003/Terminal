import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const WEBVIEW2_CLIENT_ID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const WEBVIEW2_REGISTRY_KEYS = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_ID}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_ID}`,
    `HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_ID}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_ID}`,
];

export function versionBuild(version) {
    const match = String(version ?? '').match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function isCompatibleDriverVersion(driver, runtime) {
    const driverBuild = versionBuild(driver);
    return Boolean(driverBuild && driverBuild === versionBuild(runtime));
}

export function cachedWindowsDriverPath(projectRoot, runtimeVersion) {
    const runtimeBuild = versionBuild(runtimeVersion);
    return runtimeBuild
        ? join(projectRoot, 'src-tauri', 'target', 'e2e-driver', runtimeBuild, 'msedgedriver.exe')
        : null;
}

export function selectCompatibleDriver(candidates, runtimeVersion, readVersion) {
    if (!versionBuild(runtimeVersion)) return null;
    return candidates.find((candidate) => isCompatibleDriverVersion(readVersion(candidate), runtimeVersion)) ?? null;
}

export function parseWebView2Version(output) {
    const match = String(output ?? '').match(/\bpv\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/i);
    return match && match[1] !== '0.0.0.0' ? match[1] : null;
}

function installedWebView2Version() {
    for (const key of WEBVIEW2_REGISTRY_KEYS) {
        try {
            const output = execFileSync('reg.exe', ['query', key, '/v', 'pv'], {
                encoding: 'utf8',
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const version = parseWebView2Version(output);
            if (version) return version;
        } catch {
            // Puede instalarse por usuario/máquina y en las vistas de 32/64 bits.
        }
    }
    return null;
}

function driverVersion(path) {
    try {
        const output = execFileSync(path, ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1] ?? null;
    } catch {
        return null;
    }
}

export function resolveWindowsNativeDriver(projectRoot, env = process.env) {
    if (env.TAURI_NATIVE_DRIVER) return resolve(projectRoot, env.TAURI_NATIVE_DRIVER);
    const runtimeVersion = installedWebView2Version();
    const runtimeBuild = versionBuild(runtimeVersion);
    if (!runtimeBuild) return null;

    const candidates = [
        ...String(env.PATH ?? '').split(delimiter)
            .filter(Boolean)
            .map((directory) => join(directory, 'msedgedriver.exe')),
        cachedWindowsDriverPath(projectRoot, runtimeVersion),
    ];
    const existing = [...new Set(candidates.map((path) => resolve(projectRoot, path)))].filter(existsSync);
    return selectCompatibleDriver(existing, runtimeVersion, driverVersion);
}
