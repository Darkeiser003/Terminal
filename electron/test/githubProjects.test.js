const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseGithubTarget,
    createGithubClient,
    loadCatalog,
    mergePins,
    repositoryFromFullName,
    buildGitCommand
} = require('../main/githubProjects');

test('el catálogo separa perfiles anclados de créditos de Información', () => {
    const catalog = loadCatalog(path.join(__dirname, '..', 'config', 'project-catalog.json'));
    assert.ok(!catalog.owners.includes('Darkeiser003'));
    assert.ok(catalog.fixedProfiles.includes('Darkeiser003'));
    assert.ok(catalog.developers.includes('Darkeiser003'));
    // Christianlg97 sigue anclado (su perfil y su repositorio se ven en
    // Proyectos) pero ya no aparece en los créditos de Ajustes › Información.
    assert.ok(catalog.owners.includes('Christianlg97'));
    assert.ok(catalog.fixedProfiles.includes('Christianlg97'));
    assert.ok(!catalog.developers.includes('Christianlg97'));
});

test('cada identidad de la aplicación resuelve sus propios anclados', () => {
    // WinSlim Terminal (Windows) y LTerminal (Linux/macOS) son dos marcas con
    // el mismo código. LTerminal publica solo su propio perfil.
    const catalogPath = path.join(__dirname, '..', 'config', 'project-catalog.json');
    const windows = loadCatalog(catalogPath, 'win32');
    assert.deepEqual(windows.fixedProfiles, ['Darkeiser003', 'Christianlg97']);

    ['linux', 'darwin'].forEach((platform) => {
        const other = loadCatalog(catalogPath, platform);
        assert.deepEqual(other.fixedProfiles, ['Darkeiser003'], `${platform} solo ancla Darkeiser003`);
        assert.deepEqual(other.owners, [], `${platform} no tiene perfil oficial WinSlim`);
        assert.ok(!other.developers.includes('Christianlg97'));
        // Lo que el override no menciona se hereda: el repositorio del
        // proyecto sigue anclado en las dos identidades.
        assert.deepEqual(other.repositories, windows.repositories);
    });

    // Sin bloque para esa plataforma se usa el catálogo base tal cual.
    assert.deepEqual(loadCatalog(catalogPath, 'sunos').fixedProfiles, windows.fixedProfiles);
    assert.deepEqual(loadCatalog(catalogPath).fixedProfiles, windows.fixedProfiles);
});

test('acepta únicamente perfiles y repositorios HTTPS de github.com', () => {
    assert.deepEqual(parseGithubTarget('WinSlimProject'), { kind: 'owner', owner: 'WinSlimProject' });
    assert.equal(parseGithubTarget('https://github.com/WinSlimProject/Terminal.git').fullName, 'WinSlimProject/Terminal');
    assert.equal(parseGithubTarget('git@github.com:owner/repo.git'), null);
    assert.equal(parseGithubTarget('https://github.example/owner/repo'), null);
    assert.equal(parseGithubTarget('https://user@github.com/owner/repo'), null);
    assert.equal(parseGithubTarget('https://github.com/owner/repo/issues'), null);
});

test('consulta perfil y repos públicos mediante una respuesta reducida', async () => {
    const calls = [];
    const fetchMock = async (url, options) => {
        calls.push({ url, options });
        const body = url.includes('/repos?')
            ? [{
                name: 'Terminal', owner: { login: 'WinSlimProject' }, description: 'Hub',
                language: 'JavaScript', stargazers_count: 5, forks_count: 2,
                archived: false, fork: false, updated_at: '2026-08-05T00:00:00Z'
            }]
            : { login: 'WinSlimProject', name: 'WinSlim Project', bio: 'Proyecto', type: 'Organization', public_repos: 1, followers: 4 };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'x-ratelimit-remaining': '58', 'x-ratelimit-reset': '1785900000' }
        });
    };
    const result = await createGithubClient(fetchMock).lookup('WinSlimProject');
    assert.equal(result.profile.login, 'WinSlimProject');
    assert.equal(result.repositories[0].cloneUrl, 'https://github.com/WinSlimProject/Terminal.git');
    assert.equal(result.rateLimit.remaining, 58);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers['User-Agent'], 'WinSlim-Terminal');
});

test('fusiona catálogo oficial, anclados personales y decide clone/pull', (t) => {
    const pins = mergePins(
        { brand: 'WinSlim Project', owners: ['Official'], fixedProfiles: ['Official', 'External'], developers: ['Official', 'External'], repositories: ['Official/Core'] },
        { githubPinnedOwners: ['Collaborator'], githubPinnedRepos: ['Collaborator/Tool'] }
    );
    assert.deepEqual(pins.owners, ['Official', 'External', 'Collaborator']);
    assert.deepEqual(pins.fixedProfiles, ['Official', 'External']);
    assert.deepEqual(pins.developers, ['Official', 'External']);
    assert.deepEqual(pins.repositories, ['Official/Core', 'Collaborator/Tool']);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winslim-projects-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = repositoryFromFullName('Collaborator/Tool');
    const clone = buildGitCommand(repo, root, { kind: 'cmd', transport: 'native' });
    assert.equal(clone.action, 'clone');
    assert.match(clone.command, /^git clone -- "https:\/\/github\.com\/Collaborator\/Tool\.git"/);

    fs.mkdirSync(path.join(root, 'Collaborator', 'Tool', '.git'), { recursive: true });
    const pull = buildGitCommand(repo, root, { kind: 'cmd', transport: 'native' });
    assert.equal(pull.action, 'pull');
    assert.match(pull.command, /^git -C .* pull --ff-only$/);
});
