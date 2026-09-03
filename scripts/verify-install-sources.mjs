import process from 'node:process';

// Esta comprobación no intenta resolver los 200 paquetes del catálogo: eso
// sería lento, dependiente de la distro y daría falsos negativos por cambios
// de versión. Comprueba los registros que realmente usa el instalador y deja
// el fallo cerca del inicio del build, antes de descubrirlo al pulsar
// "Instalar".
const mode = (process.env.LTERMINAL_INSTALL_SOURCE_CHECK ?? 'warn').toLowerCase();
// Los registros públicos pueden tardar más que una petición normal cuando el
// runner sale por primera vez a Internet. Un margen de 8 s y tres intentos
// evita falsos avisos por cold-start sin convertir la comprobación en una
// espera indefinida; ambos valores siguen siendo configurables para CI.
const timeoutMs = Math.max(1000, Number(process.env.LTERMINAL_INSTALL_SOURCE_TIMEOUT_MS ?? 8000));
const retries = Math.max(1, Number(process.env.LTERMINAL_INSTALL_SOURCE_RETRIES ?? 3));
const sources = [
    ['WinGet manifests', 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master/README.md'],
    ['Chocolatey', 'https://community.chocolatey.org/api/v2/'],
    ['Flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'],
    ['npm', 'https://registry.npmjs.org/'],
    ['PyPI', 'https://pypi.org/pypi/pip/json'],
    ['crates.io', 'https://crates.io/api/v1/crates/cargo'],
    ['Go proxy', 'https://proxy.golang.org/'],
    ['RubyGems', 'https://rubygems.org/api/v1/gems/bundler.json'],
    ['Packagist', 'https://repo.packagist.org/p2/composer/composer.json'],
    ['NuGet', 'https://api.nuget.org/v3/index.json'],
    ['Hex', 'https://hex.pm/api/packages/plug'],
    ['Hackage', 'https://hackage.haskell.org/package/cabal'],
    ['Dart pub', 'https://pub.dev/api/packages/http'],
    // search.maven.org es un índice de búsqueda y ha dado timeouts
    // intermitentes. El instalador necesita Maven Central, no el buscador:
    // consultar el metadata XML del repositorio canónico es más pequeño y
    // representa mejor la disponibilidad real que necesita la aplicación.
    ['Maven Central', 'https://repo.maven.apache.org/maven2/org/junit/jupiter/junit-jupiter-api/maven-metadata.xml'],
    ['LuaRocks', 'https://luarocks.org/manifest.json'],
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
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
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
