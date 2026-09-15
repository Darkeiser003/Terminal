import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const codeql = read('.github/workflows/codeql.yml');
const workflowSecurity = read('.github/workflows/workflow-security.yml');
const dependencyReview = read('.github/workflows/dependency-review.yml');
const scorecard = read('.github/workflows/scorecard.yml');
const dependabot = read('.github/dependabot.yml');
const linuxBuild = read('linux/build.sh');
const attributes = read('.gitattributes');
const ignore = read('.gitignore');
const license = read('LICENSE');
const contributing = read('CONTRIBUTING.md');
const securityPolicy = read('SECURITY.md');
const bugTemplate = read('.github/ISSUE_TEMPLATE/bug_report.yml');
const featureTemplate = read('.github/ISSUE_TEMPLATE/feature_request.yml');
const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml');
const packageManifest = JSON.parse(read('package.json'));
const cargoManifest = read('src-tauri/Cargo.toml');
const failures = [];
const workflowDirectory = resolve(root, '.github/workflows');
const workflowFiles = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
const workflows = workflowFiles.map((name) => ({ name, text: read(`.github/workflows/${name}`) }));
let staticChecksRun = 0;

function check(name, passed) {
    staticChecksRun += 1;
    if (!passed) failures.push(name);
}

check(
    'CodeQL cubre JavaScript/TypeScript, Rust y definiciones de GitHub Actions',
    /language:\s*\[javascript-typescript,\s*rust,\s*actions\]/.test(codeql),
);
check(
    'CodeQL no intenta compilar los workflows como si fueran código de aplicación',
    /autobuild@[0-9a-f]{40}(?:\s+#.*)?\s*\n\s*if:\s*matrix\.language\s*!=\s*'actions'/.test(codeql),
);
check(
    'actionlint está fijado a una versión concreta y se ejecuta sobre los workflows',
    workflowSecurity.includes('actionlint@v1.7.12')
        && /run:\s*actionlint -color/.test(workflowSecurity),
);
check(
    'zizmor está fijado a un commit completo y publica hallazgos de seguridad',
    /zizmorcore\/zizmor-action@[0-9a-f]{40}/.test(workflowSecurity)
        && workflowSecurity.includes('security-events: write'),
);
check(
    'La descarga del checkout no conserva credenciales del token',
    workflowSecurity.includes('persist-credentials: false'),
);
check(
    'Dependency Review está fijado por SHA y cubre vulnerabilidades altas, todos los scopes y licencias permitidas',
    /actions\/dependency-review-action@[0-9a-f]{40}/.test(dependencyReview)
        && dependencyReview.includes('fail-on-severity: high')
        && dependencyReview.includes('fail-on-scopes: runtime,development,unknown')
        && dependencyReview.includes('allow-licenses:'),
);
check(
    'OpenSSF Scorecard publica SARIF/resultados, conserva evidencia y puede leer commits, checks y metadatos del repositorio',
    /ossf\/scorecard-action@[0-9a-f]{40}/.test(scorecard)
        && /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/.test(scorecard)
        && /actions\/upload-artifact@[0-9a-f]{40}/.test(scorecard)
        && scorecard.includes('publish_results: true')
        && scorecard.includes('id-token: write')
        && scorecard.includes('issues: read')
        && scorecard.includes('pull-requests: read')
        && scorecard.includes('checks: read')
        && scorecard.includes('retention-days: 5')
        && scorecard.includes('persist-credentials: false'),
);
check(
    'No permanece el workflow APIsec de ejemplo que apuntaba a VAmPI y no a una API del producto',
    !existsSync(resolve(root, '.github/workflows/apisec-scan.yml')),
);
check(
    'Dependabot agrupa solo minor/patch y controla npm, Cargo, GitHub Actions y la imagen del fuzzer',
    (dependabot.match(/applies-to:\s*version-updates/g) ?? []).length === 7
        && (dependabot.match(/- minor\n\s+- patch/g) ?? []).length === 7
        && dependabot.includes('frontend-runtime')
        && dependabot.includes('frontend-tooling')
        && dependabot.includes('tauri-ecosystem')
        && dependabot.includes('actions-minor-patch')
        && dependabot.includes('directory: /fuzz')
        && dependabot.includes('fuzzing-minor-patch')
        && dependabot.includes('package-ecosystem: docker')
        && dependabot.includes('directory: /.clusterfuzzlite'),
);
check(
    'Los grupos de Dependabot son hermanos de cooldown dentro de cada ecosistema (no quedan anidados ni inactivos)',
    /^ {4}groups:\s*$/m.test(dependabot)
        && !/^ {6}groups:\s*$/m.test(dependabot)
        && /^ {6}actions-minor-patch:\s*\n {8}applies-to:\s*version-updates\s*$/m.test(dependabot)
        && !/^ {6}default-days:\s*7\s*\n {6}groups:/m.test(dependabot),
);
check(
    'La decisión MIT coincide en la licencia raíz y los manifiestos JavaScript y Rust',
    license.startsWith('MIT License\n')
        && packageManifest.license === 'MIT'
        && /^(?:license\s*=\s*"MIT")$/m.test(cargoManifest),
);
check(
    'La contribución, los reportes públicos y el canal privado de vulnerabilidades están documentados',
    contributing.includes('pull request')
        && contributing.includes('npm run check:local')
        && contributing.includes('[SECURITY.md](SECURITY.md)')
        && securityPolicy.replace(/\s+/g, ' ').toLowerCase().includes('reporte privado de vulnerabilidades')
        && securityPolicy.includes('RUSTSEC-2024-0429')
        && bugTemplate.includes('private reporting link')
        && featureTemplate.includes('Suggested behavior')
        && issueConfig.includes('/SECURITY.md'),
);
check(
    'Las reglas de Git conservan .github y no asignan filtros LFS indiscriminados',
    !/^\s*(?:\/?\.github\/?|\.\*)\s*$/m.test(ignore)
        && !/^\*\s+filter=lfs\b/m.test(attributes)
        && attributes.includes('*.wasm binary')
        && attributes.includes('*.woff2 binary'),
);

const actionReferences = [];
const checkoutSteps = [];
for (const workflow of workflows) {
    const lines = workflow.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const uses = lines[index].match(/^\s*-\s+uses:\s*([^\s#]+)/);
        if (!uses) continue;
        const reference = uses[1];
        if (reference.startsWith('./')) continue;
        actionReferences.push({ workflow: workflow.name, line: index + 1, reference, comment: lines[index] });

        const stepIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
        let end = index + 1;
        while (end < lines.length) {
            const nextStep = lines[end].match(/^(\s*)-\s+/);
            if (nextStep && nextStep[1].length <= stepIndent) break;
            end += 1;
        }
        if (/^actions\/checkout(?:\/|@)/i.test(reference)) {
            checkoutSteps.push({ workflow: workflow.name, line: index + 1, block: lines.slice(index, end).join('\n') });
        }
    }
}

check(
    'Todas las acciones externas de todos los workflows están fijadas a un SHA completo y anotadas con su versión',
    actionReferences.length > 0 && actionReferences.every(({ reference, comment }) =>
        /@[0-9a-f]{40}(?:\/[^\s#]+)?$/i.test(reference) && /#\s*(?:v?\d|stable\s*@)/i.test(comment)),
);
check(
    'Cada checkout desactiva la persistencia local de credenciales',
    checkoutSteps.length > 0 && checkoutSteps.every(({ block }) => /persist-credentials:\s*false\b/.test(block)),
);
check(
    'La build Linux instala exclusivamente desde el lockfile y nunca degrada a npm install',
    linuxBuild.includes('package-lock.json')
        && /npm ci/.test(linuxBuild)
        && !/\bnpm\s+install\b/.test(linuxBuild),
);
const releaseWorkflow = read('.github/workflows/release.yml');
const releaseBuildJobs = releaseWorkflow.split(/\n  publish:\n/)[0] ?? '';
const releasePublishJob = releaseWorkflow.split(/\n  publish:\n/)[1] ?? '';
check(
    'La release compila con permisos de solo lectura y reserva contents: write para el job de publicación, sin caché de paquetes',
    /^permissions:\s*\{\s*\}\s*$/m.test(releaseWorkflow)
        && (releaseWorkflow.match(/^\s{6}contents:\s*read\s*$/gm) ?? []).length === 2
        && (releaseWorkflow.match(/^\s{6}contents:\s*write\s*$/gm) ?? []).length === 1
        && /^\s{6}actions:\s*read\s*$/m.test(releaseWorkflow)
        && (releaseWorkflow.match(/^\s{10}package-manager-cache:\s*false\s*$/gm) ?? []).length === 2
        && !/^\s{10}cache:\s*\S+/m.test(releaseWorkflow),
);
check(
    'La publicación espera ambos builds, combina sus adjuntos, genera un manifiesto común y lo firma/verifica una sola vez',
    /publish:[\s\S]*?needs:\s*\[linux,\s*windows\]/.test(releaseWorkflow)
        && (releaseWorkflow.match(/gh run download/g) ?? []).length === 2
        && releaseWorkflow.includes('scripts/create-release-manifest.mjs')
        && releaseBuildJobs.includes('LTERMINAL_UPDATE_PUBLIC_KEY: ${{ secrets.LTERMINAL_UPDATE_PUBLIC_KEY }}')
        && !releaseBuildJobs.includes('LTERMINAL_SIGNING_PRIVATE_KEY')
        && releasePublishJob.includes('LTERMINAL_SIGNING_PRIVATE_KEY: ${{ secrets.LTERMINAL_SIGNING_PRIVATE_KEY }}')
        && (releaseWorkflow.match(/scripts\/sign-release-manifest\.mjs/g) ?? []).length === 2,
);
check(
    'La publicación de releases usa el gh CLI integrado de forma idempotente, sin acción externa adicional',
    !/softprops\/action-gh-release|actions\/upload-release-asset/.test(releaseWorkflow)
        && (releaseWorkflow.match(/gh release upload/g) ?? []).length === 1
        && releaseWorkflow.includes('--clobber'),
);
check(
    'CodeQL solo entrega security-events: write al job que analiza código',
    /^permissions:\s*$/m.test(codeql)
        && !/^\s{2}security-events:\s*write\s*$/m.test(codeql)
        && /^\s{6}security-events:\s*write\s*$/m.test(codeql),
);

const dependabotEntries = dependabot.split(/^\s*-\s+package-ecosystem:/m).slice(1);
check(
    'Cada ecosistema de Dependabot tiene al menos 7 días de cooldown explícito',
    dependabotEntries.length === 5 && dependabotEntries.every((entry) =>
        /^\s{4}cooldown:\s*\n\s{6}default-days:\s*(?:[7-9]|[1-9]\d+)\s*$/m.test(entry)),
);

function missingScanner(label) {
    const message = `${label} no está instalado localmente; el escaneo remoto de workflows sigue activo en GitHub Actions.`;
    if (process.env.LTERMINAL_REQUIRE_GITHUB_SECURITY_TOOLS === '1') failures.push(message);
    else console.log(`AVISO: ${message} Usa LTERMINAL_REQUIRE_GITHUB_SECURITY_TOOLS=1 para exigir ambos analizadores locales.`);
}

function runActionlint() {
    const result = spawnSync('actionlint', [], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error?.code === 'ENOENT') return missingScanner('actionlint');
    if (result.error && result.status !== 0) {
        failures.push(`actionlint no pudo iniciarse: ${result.error.message}`);
        return;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) failures.push(`actionlint encontró problemas (código ${result.status ?? 'desconocido'}).`);
    else console.log('✓ actionlint: sintaxis, expresiones y esquemas de workflows correctos.');
}

function runZizmor() {
    // SARIF deja que el build distinga avisos informativos de hallazgos que
    // deben bloquearlo; el escaneo sin auditorías online es determinista y no
    // depende de token ni conexión. GitHub ejecuta el escaneo completo y sube
    // sus resultados para actualizar Security > Code scanning.
    const result = spawnSync('zizmor', [
        '--no-online-audits', '--format', 'sarif', '--collect=all', '.github',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error?.code === 'ENOENT') return missingScanner('zizmor');
    if (result.error && result.status !== 0) {
        failures.push(`zizmor no pudo iniciarse: ${result.error.message}`);
        return;
    }
    if (result.stderr) process.stderr.write(result.stderr);

    let findings;
    try {
        const report = JSON.parse(result.stdout);
        findings = (report.runs ?? []).flatMap((run) => run.results ?? []);
    } catch (error) {
        failures.push(`zizmor no produjo un informe SARIF legible: ${error.message}`);
        return;
    }

    const actionable = findings.filter((finding) => !['note', 'none'].includes(finding.level));
    const notes = findings.length - actionable.length;
    for (const finding of actionable) {
        const location = finding.locations?.[0]?.physicalLocation;
        const file = location?.artifactLocation?.uri ?? '.github';
        const line = location?.region?.startLine;
        const where = line ? `${file}:${line}` : file;
        failures.push(`zizmor ${finding.level ?? 'finding'} (${finding.ruleId ?? 'sin regla'}) en ${where}`);
    }
    if (result.status !== 0 && actionable.length === 0) {
        failures.push(`zizmor no pudo completar el escaneo (código ${result.status ?? 'desconocido'}).`);
    }
    if (actionable.length === 0 && result.status === 0) {
        console.log(`✓ zizmor: ${findings.length} hallazgos bloqueantes; ${notes} notas informativas en .github.`);
    }
}

if (process.argv.includes('--scan')) {
    runActionlint();
    runZizmor();
}

if (failures.length) {
    throw new Error(`Configuración de seguridad GitHub incompleta:\n- ${failures.join('\n- ')}`);
}

console.log(`Configuración de seguridad GitHub verificada (${staticChecksRun} reglas, ${actionReferences.length} acciones fijadas, ${checkoutSteps.length} checkouts, ${workflowFiles.length} workflows).`);
