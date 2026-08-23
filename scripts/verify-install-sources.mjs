import process from 'node:process';

// Esta comprobación no intenta resolver los 200 paquetes del catálogo: eso
// sería lento, dependiente de la distro y daría falsos negativos por cambios
// de versión. Comprueba los registros que realmente usa el instalador y deja
// el fallo cerca del inicio del build, antes de descubrirlo al pulsar
// "Instalar".
const mode = (process.env.LTERMINAL_INSTALL_SOURCE_CHECK ?? 'warn').toLowerCase();
const timeoutMs = Math.max(1000, Number(process.env.LTERMINAL_INSTALL_SOURCE_TIMEOUT_MS ?? 5000));
const retries = Math.max(1, Number(process.env.LTERMINAL_INSTALL_SOURCE_RETRIES ?? 2));
const sources = [
    ['npm', 'https://registry.npmjs.org/'],
    ['PyPI', 'https://pypi.org/pypi/pip/json'],
    ['crates.io', 'https://crates.io/api/v1/crates/cargo'],
    ['Go proxy', 'https://proxy.golang.org/'],
    ['RubyGems', 'https://rubygems.org/api/v1/gems/bundler.json'],
    ['Packagist', 'https://repo.packagist.org/p2/composer/composer.json'],
    ['NuGet', 'https://api.nuget.org/v3/index.json'],
    ['Hex', 'https://hex.pm/api/packages/plug'],
    ['Hackage', 'https://hackage.haskell.org/package/cabal'],
    ['AUR', 'https://aur.archlinux.org/rpc?v=5&type=search&arg=paru'],
];

function errorText(error) {
    if (error?.name === 'AbortError') return `timeout de ${timeoutMs} ms`;
    const code = error?.cause?.code;
    return code ? `${error.message} (${code})` : error.message;
}

async function probe(url) {
    let lastError = 'sin respuesta';
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'user-agent': 'LTerminal-install-source-check/1.0', range: 'bytes=0-0' },
            });
            await response.body?.cancel();
            if (response.status >= 200 && response.status < 400) {
                return { ok: true, status: response.status, attempt };
            }
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = errorText(error);
        } finally {
            clearTimeout(timer);
        }
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    return { ok: false, error: lastError };
}

if (mode === 'off') {
    console.warn(`Fuentes de instalación: comprobación desactivada (${sources.length} registros).`);
    process.exit(0);
}

console.log(`Fuentes de instalación: comprobando ${sources.length} registros (${mode}, HTTP ${timeoutMs} ms/${retries} intentos)...`);
const results = await Promise.all(sources.map(async ([name, url]) => [name, url, await probe(url)]));
const failures = [];
for (const [name, url, result] of results) {
    if (result.ok) console.log(`  ✔ ${result.status} ${name} (${url})`);
    else {
        failures.push([name, url, result.error]);
        console.warn(`  ⚠ ${name}: ${result.error} (${url})`);
    }
}

console.log(`Fuentes de instalación: ${sources.length - failures.length} OK, ${failures.length} sin respuesta.`);
if (failures.length > 0 && mode === 'strict') {
    console.error('Fuentes de instalación: el build se detiene porque un registro necesario no responde.');
    console.error('Fuentes de instalación: usa LTERMINAL_INSTALL_SOURCE_CHECK=warn para continuar y diagnosticar.' );
    process.exit(1);
}
if (failures.length > 0) {
    console.warn('Fuentes de instalación: aviso no bloqueante; las acciones afectadas pueden fallar hasta recuperar la red.');
}
