// Integración pública con GitHub para el panel «Proyectos».
//
// No guarda tokens ni ejecuta descargas ocultas: valida perfiles/URLs,
// reduce la respuesta de la API a campos explícitos y construye un comando
// git clone/pull que main.js escribe en una terminal visible.

const fs = require('fs');
const path = require('path');
const { unixPathFor } = require('./scriptLauncher');

const GITHUB_ORIGIN = 'https://github.com';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const MAX_API_BYTES = 2 * 1024 * 1024;

function isGithubOwner(value) {
    return typeof value === 'string'
        && value.length >= 1
        && value.length <= 39
        && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value);
}

function isGithubRepoName(value) {
    return typeof value === 'string'
        && value.length >= 1
        && value.length <= 100
        && /^[A-Za-z0-9._-]+$/.test(value);
}

function parseFullName(value) {
    if (typeof value !== 'string') return null;
    const parts = value.trim().replace(/\.git$/i, '').split('/');
    if (parts.length !== 2 || !isGithubOwner(parts[0]) || !isGithubRepoName(parts[1])) return null;
    return { owner: parts[0], name: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

// Acepta un login, owner/repo o una URL web normal. Se rechazan SSH,
// git://, hosts alternativos, credenciales, puertos y segmentos adicionales.
function parseGithubTarget(raw) {
    const value = String(raw || '').trim();
    if (!value || value.length > 300) return null;
    if (isGithubOwner(value)) return { kind: 'owner', owner: value };
    const fullName = parseFullName(value);
    if (fullName) return { kind: 'repo', ...fullName };
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password) return null;
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length === 1 && isGithubOwner(segments[0])) return { kind: 'owner', owner: segments[0] };
        if (segments.length === 2) {
            const repo = parseFullName(`${segments[0]}/${segments[1]}`);
            if (repo) return { kind: 'repo', ...repo };
        }
    } catch (e) { }
    return null;
}

function safeText(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function sanitizeProfile(raw) {
    if (!raw || !isGithubOwner(raw.login)) return null;
    return {
        login: raw.login,
        name: safeText(raw.name, 120),
        bio: safeText(raw.bio, 500),
        type: raw.type === 'Organization' ? 'Organization' : 'User',
        publicRepos: Number.isFinite(raw.public_repos) ? raw.public_repos : 0,
        followers: Number.isFinite(raw.followers) ? raw.followers : 0,
        htmlUrl: `${GITHUB_ORIGIN}/${raw.login}`
    };
}

function sanitizeRepository(raw) {
    if (!raw || !raw.owner || !isGithubOwner(raw.owner.login) || !isGithubRepoName(raw.name)) return null;
    const owner = raw.owner.login;
    const name = raw.name;
    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        description: safeText(raw.description, 500),
        language: safeText(raw.language, 60),
        stars: Number.isFinite(raw.stargazers_count) ? raw.stargazers_count : 0,
        forks: Number.isFinite(raw.forks_count) ? raw.forks_count : 0,
        archived: raw.archived === true,
        fork: raw.fork === true,
        updatedAt: safeText(raw.updated_at, 40),
        htmlUrl: `${GITHUB_ORIGIN}/${owner}/${name}`,
        cloneUrl: `${GITHUB_ORIGIN}/${owner}/${name}.git`
    };
}

class GithubApiError extends Error {
    constructor(message, status, rateLimit) {
        super(message);
        this.name = 'GithubApiError';
        this.status = status || 0;
        this.rateLimit = rateLimit || null;
    }
}

function createGithubClient(fetchImpl, options) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl debe ser una función');
    const userAgent = options && typeof options.userAgent === 'string'
        ? options.userAgent.slice(0, 100)
        : 'WinSlim-Terminal';

    async function request(apiPath) {
        if (!/^\/[A-Za-z0-9?&=._%\/-]+$/.test(apiPath)) throw new GithubApiError('Ruta de API no válida.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetchImpl(GITHUB_API_ORIGIN + apiPath, {
                method: 'GET',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': userAgent
                }
            });
        } catch (error) {
            throw new GithubApiError(error && error.name === 'AbortError'
                ? 'GitHub tardó demasiado en responder.'
                : 'No se pudo conectar con GitHub.');
        } finally {
            clearTimeout(timer);
        }

        const remaining = Number(response.headers.get('x-ratelimit-remaining'));
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        const rateLimit = {
            remaining: Number.isFinite(remaining) ? remaining : null,
            resetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null
        };
        const text = await response.text();
        if (text.length > MAX_API_BYTES) throw new GithubApiError('La respuesta de GitHub es demasiado grande.', response.status, rateLimit);
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { }
        if (!response.ok) {
            const fallback = response.status === 404
                ? 'El perfil o repositorio no existe o no es público.'
                : response.status === 403 && rateLimit.remaining === 0
                    ? 'Se agotó temporalmente el límite de consultas públicas de GitHub.'
                    : `GitHub respondió con el estado ${response.status}.`;
            throw new GithubApiError(fallback, response.status, rateLimit);
        }
        return { data, rateLimit };
    }

    async function lookup(rawTarget) {
        const target = parseGithubTarget(rawTarget);
        if (!target) throw new GithubApiError('Introduce un usuario, owner/repo o una URL pública de github.com.');
        if (target.kind === 'repo') {
            const result = await request(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`);
            const repo = sanitizeRepository(result.data);
            if (!repo) throw new GithubApiError('GitHub devolvió un repositorio no válido.');
            return { target: 'repo', profile: null, repositories: [repo], rateLimit: result.rateLimit };
        }

        const profileResult = await request(`/users/${encodeURIComponent(target.owner)}`);
        const profile = sanitizeProfile(profileResult.data);
        if (!profile) throw new GithubApiError('GitHub devolvió un perfil no válido.');
        const route = profile.type === 'Organization' ? 'orgs' : 'users';
        const reposResult = await request(`/${route}/${encodeURIComponent(profile.login)}/repos?sort=updated&direction=desc&per_page=100&type=public`);
        const repositories = Array.isArray(reposResult.data)
            ? reposResult.data.map(sanitizeRepository).filter(Boolean)
            : [];
        return { target: 'owner', profile, repositories, rateLimit: reposResult.rateLimit };
    }

    // Última release publicada de un repositorio. GitHub responde 404 cuando
    // el proyecto no ha publicado ninguna, que es lo normal en la mayoría: eso
    // no es un error que haya que enseñar como tal.
    async function latestRelease(fullName) {
        const repo = parseFullName(fullName);
        if (!repo) throw new GithubApiError('Repositorio no válido.');
        try {
            const result = await request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases/latest`);
            const release = sanitizeRelease(result.data);
            return { release, rateLimit: result.rateLimit };
        } catch (error) {
            if (error instanceof GithubApiError && error.status === 404) {
                return { release: null, rateLimit: error.rateLimit || null };
            }
            throw error;
        }
    }

    return { lookup, latestRelease };
}

// El catálogo puede traer un bloque por plataforma. Existe porque la
// aplicación tiene DOS identidades (WinSlim Terminal en Windows, LTerminal en
// Linux y macOS) y sus anclados de fábrica no tienen que coincidir: la marca
// Linux es independiente y publica solo su propio perfil.
//
// Lo que no está en el bloque se hereda del catálogo base, así que un override
// puede cambiar solo los perfiles anclados y dejar la marca y los repositorios
// como estén.
function catalogForPlatform(raw, platform) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const overrides = source.platformOverrides && typeof source.platformOverrides === 'object'
        ? source.platformOverrides
        : {};
    const override = platform && overrides[platform] && typeof overrides[platform] === 'object'
        ? overrides[platform]
        : null;
    if (!override) return source;
    const merged = { ...source, ...override };
    delete merged.platformOverrides;
    return merged;
}

function normalizeCatalog(raw, platform) {
    const source = catalogForPlatform(raw, platform);
    const owners = Array.isArray(source.owners)
        ? source.owners.filter(isGithubOwner)
        : [];
    const fixedProfiles = Array.isArray(source.fixedProfiles)
        ? source.fixedProfiles.filter(isGithubOwner)
        : [];
    const developers = Array.isArray(source.developers)
        ? source.developers.filter(isGithubOwner)
        : [];
    const repositories = Array.isArray(source.repositories)
        ? source.repositories.map(parseFullName).filter(Boolean).map((repo) => repo.fullName)
        : [];
    return {
        brand: safeText(source.brand, 100) || 'WinSlim Project',
        owners: Array.from(new Set(owners)),
        fixedProfiles: Array.from(new Set(fixedProfiles)),
        developers: Array.from(new Set(developers)),
        repositories: Array.from(new Set(repositories))
    };
}

// `platform` decide qué bloque de platformOverrides se aplica. Se pasa
// explícitamente en vez de leer process.platform aquí para que las pruebas
// puedan comprobar las dos identidades sin simular el sistema operativo.
function loadCatalog(catalogPath, platform) {
    try {
        return normalizeCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')), platform);
    } catch (e) {
        return normalizeCatalog(null, platform);
    }
}

function mergePins(catalog, settings) {
    const fixed = normalizeCatalog(catalog);
    const stored = settings && typeof settings === 'object' ? settings : {};
    const normalized = normalizeCatalog({
        brand: fixed.brand,
        owners: [
            ...fixed.fixedProfiles,
            ...(Array.isArray(stored.githubPinnedOwners) ? stored.githubPinnedOwners : [])
        ],
        fixedProfiles: fixed.fixedProfiles,
        developers: fixed.developers,
        repositories: [...fixed.repositories, ...(Array.isArray(stored.githubPinnedRepos) ? stored.githubPinnedRepos : [])]
    });
    return normalized;
}

function repositoryFromFullName(fullName) {
    const parsed = parseFullName(fullName);
    if (!parsed) return null;
    return {
        ...parsed,
        description: '', language: '', stars: 0, forks: 0,
        archived: false, fork: false, updatedAt: '',
        htmlUrl: `${GITHUB_ORIGIN}/${parsed.fullName}`,
        cloneUrl: `${GITHUB_ORIGIN}/${parsed.fullName}.git`
    };
}

function localRepositoryState(projectsFolder, repository) {
    const root = path.resolve(projectsFolder);
    const localPath = path.resolve(root, repository.owner, repository.name);
    const relative = path.relative(root, localPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    let exists = false;
    let repositoryExists = false;
    try {
        exists = fs.existsSync(localPath);
        repositoryExists = exists && fs.existsSync(path.join(localPath, '.git'));
    } catch (e) { }
    return { localPath, exists, repositoryExists, action: repositoryExists ? 'pull' : 'clone' };
}

// Cuántos repositorios hay clonados de verdad bajo la carpeta de proyectos.
// La estructura es <carpeta>/<propietario>/<repositorio>, así que se miran dos
// niveles y solo cuenta lo que tiene un `.git` dentro: una carpeta suelta con
// el nombre de un repositorio no es un repositorio.
//
// Se recorre el disco, no la lista de anclados: lo interesante es lo que hay
// descargado, incluido lo que se clonó y luego se desancló.
const MAX_SCANNED_OWNERS = 200;

function countLocalRepositories(projectsFolder) {
    if (!projectsFolder) return 0;
    let owners;
    try {
        owners = fs.readdirSync(projectsFolder, { withFileTypes: true });
    } catch (e) {
        // La carpeta puede no existir todavía: no es un error, es que aún no
        // se ha descargado nada.
        return 0;
    }
    let total = 0;
    owners
        .filter((entry) => entry.isDirectory())
        .slice(0, MAX_SCANNED_OWNERS)
        .forEach((owner) => {
            const ownerPath = path.join(projectsFolder, owner.name);
            let repositories;
            try {
                repositories = fs.readdirSync(ownerPath, { withFileTypes: true });
            } catch (e) {
                return;
            }
            repositories.forEach((repository) => {
                if (!repository.isDirectory()) return;
                if (fs.existsSync(path.join(ownerPath, repository.name, '.git'))) total += 1;
            });
        });
    return total;
}

/* ---- Releases ----
 *
 * Un release es la forma en que la mayoría de proyectos publican algo
 * ejecutable: quien solo quiere usar la herramienta no necesita clonarla ni
 * compilarla. El panel enseña la última publicada y sus adjuntos.
 *
 * Los adjuntos NO se sirven desde api.github.com: la API devuelve una URL de
 * descarga que apunta a otro host de GitHub. Se acepta una lista cerrada de
 * hosts y solo https, para que un campo manipulado en la respuesta no pueda
 * convertir la descarga en una petición a cualquier sitio.
 */
const ASSET_HOSTS = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com'
]);

function isAllowedAssetUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:'
            && ASSET_HOSTS.has(url.hostname.toLowerCase())
            && !url.username && !url.password && !url.port;
    } catch (e) {
        return false;
    }
}

// Extensiones que sabemos desempaquetar. El resto (un .exe, un .AppImage, un
// binario suelto) se descarga y se deja donde está: no hay nada que extraer.
const ARCHIVE_KINDS = [
    { match: /\.tar\.(gz|bz2|xz|zst)$/i, kind: 'tar' },
    { match: /\.(tgz|tbz2|txz)$/i, kind: 'tar' },
    { match: /\.tar$/i, kind: 'tar' },
    { match: /\.zip$/i, kind: 'zip' },
    { match: /\.7z$/i, kind: '7z' },
    { match: /\.rar$/i, kind: 'rar' }
];

function archiveKindFor(name) {
    const found = ARCHIVE_KINDS.find((candidate) => candidate.match.test(String(name || '')));
    return found ? found.kind : null;
}

const MAX_ASSETS = 30;

function sanitizeAsset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = safeText(raw.name, 200);
    const downloadUrl = safeText(raw.browser_download_url, 500);
    // Un nombre de archivo con separadores o `..` no se escribe nunca en
    // disco: la ruta de destino la construye main.js con basename, pero es
    // más barato descartarlo aquí que confiar en un solo filtro.
    if (!name || /[\\/]|^\.{1,2}$/.test(name)) return null;
    if (!isAllowedAssetUrl(downloadUrl)) return null;
    const size = Number(raw.size);
    return {
        name,
        downloadUrl,
        size: Number.isFinite(size) && size >= 0 ? size : 0,
        downloads: Number.isFinite(Number(raw.download_count)) ? Number(raw.download_count) : 0,
        archive: archiveKindFor(name)
    };
}

function sanitizeRelease(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const assets = Array.isArray(raw.assets)
        ? raw.assets.map(sanitizeAsset).filter(Boolean).slice(0, MAX_ASSETS)
        : [];
    return {
        tag: safeText(raw.tag_name, 100),
        name: safeText(raw.name, 200) || safeText(raw.tag_name, 100),
        publishedAt: safeText(raw.published_at, 40),
        htmlUrl: safeText(raw.html_url, 500),
        prerelease: raw.prerelease === true,
        // El código fuente siempre está disponible aunque no haya adjuntos.
        sourceZip: safeText(raw.zipball_url, 500),
        assets
    };
}

// Comando para desempaquetar lo descargado. Se escribe en la terminal visible
// como cualquier otra acción: el usuario ve qué se ejecuta sobre su disco.
//
// No se usa una librería de descompresión dentro de la aplicación a propósito.
// Las herramientas del sistema entienden los formatos reales que publica la
// gente (tar.zst, 7z, rar), respetan permisos y enlaces, y dejan el comando a
// la vista para poder repetirlo o cancelarlo.
function buildExtractCommand(archivePath, destination, kind, options) {
    const archive = archiveKindFor(archivePath);
    if (!archive) return null;
    const opts = options || {};
    const windowsShell = kind === 'cmd' || kind === 'powershell';
    const file = windowsShell ? archivePath : unixPathFor(archivePath, kind, opts.transport);
    const dir = windowsShell ? destination : unixPathFor(destination, kind, opts.transport);
    const quote = windowsShell ? qWin : qUnix;

    if (kind === 'powershell') {
        // Expand-Archive solo entiende zip; para el resto, el tar que Windows
        // trae desde la build 17063.
        if (archive === 'zip') {
            return `Expand-Archive -LiteralPath ${quote(file)} -DestinationPath ${quote(dir)} -Force`;
        }
        if (archive === 'tar') return `tar -xf ${quote(file)} -C ${quote(dir)}`;
        return `7z x ${quote(file)} -o${quote(dir)} -y`;
    }
    if (kind === 'cmd') {
        // El tar de Windows es bsdtar: descomprime también los .zip.
        if (archive === 'tar' || archive === 'zip') return `tar -xf ${quote(file)} -C ${quote(dir)}`;
        return `7z x ${quote(file)} -o${quote(dir)} -y`;
    }
    // Unix: el tar de GNU no abre zip, así que ahí se usa unzip.
    if (archive === 'tar') return `tar -xf ${quote(file)} -C ${quote(dir)}`;
    if (archive === 'zip') return `unzip -o ${quote(file)} -d ${quote(dir)}`;
    if (archive === '7z') return `7z x ${quote(file)} -o${quote(dir)} -y`;
    return `unrar x -o+ ${quote(file)} ${quote(dir)}`;
}

function qWin(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function qUnix(value) {
    return "'" + String(value).replace(/'/g, `'\\''`) + "'";
}

function buildGitCommand(repository, projectsFolder, env) {
    const state = localRepositoryState(projectsFolder, repository);
    if (!state || !env || env.transport === 'docker' || env.transport === 'android') return null;
    const windowsShell = env.kind === 'cmd' || env.kind === 'powershell';
    const localPath = windowsShell
        ? state.localPath
        : unixPathFor(state.localPath, env.kind, env.transport);
    const quote = windowsShell ? qWin : qUnix;
    const command = state.repositoryExists
        ? `git -C ${quote(localPath)} pull --ff-only`
        : `git clone -- ${quote(repository.cloneUrl)} ${quote(localPath)}`;
    return { ...state, command };
}

module.exports = {
    GITHUB_ORIGIN,
    parseGithubTarget,
    parseFullName,
    sanitizeProfile,
    sanitizeRepository,
    createGithubClient,
    loadCatalog,
    mergePins,
    repositoryFromFullName,
    localRepositoryState,
    countLocalRepositories,
    buildGitCommand,
    sanitizeRelease,
    isAllowedAssetUrl,
    archiveKindFor,
    buildExtractCommand,
    isGithubOwner,
    GithubApiError
};
