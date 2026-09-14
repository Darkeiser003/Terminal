import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const codeql = read('.github/workflows/codeql.yml');
const workflowSecurity = read('.github/workflows/workflow-security.yml');
const dependencyReview = read('.github/workflows/dependency-review.yml');
const scorecard = read('.github/workflows/scorecard.yml');
const dependabot = read('.github/dependabot.yml');
const attributes = read('.gitattributes');
const ignore = read('.gitignore');
const failures = [];

function check(name, passed) {
    if (!passed) failures.push(name);
}

check(
    'CodeQL cubre JavaScript/TypeScript, Rust y definiciones de GitHub Actions',
    /language:\s*\[javascript-typescript,\s*rust,\s*actions\]/.test(codeql),
);
check(
    'CodeQL no intenta compilar los workflows como si fueran código de aplicación',
    /autobuild@v\d+\s*\n\s*if:\s*matrix\.language\s*!=\s*'actions'/.test(codeql),
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
    'OpenSSF Scorecard publica SARIF y resultados verificables con permisos explícitos',
    /ossf\/scorecard-action@[0-9a-f]{40}/.test(scorecard)
        && /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/.test(scorecard)
        && scorecard.includes('publish_results: true')
        && scorecard.includes('id-token: write')
        && scorecard.includes('persist-credentials: false'),
);
check(
    'No permanece el workflow APIsec de ejemplo que apuntaba a VAmPI y no a una API del producto',
    !existsSync(resolve(root, '.github/workflows/apisec-scan.yml')),
);
check(
    'Dependabot agrupa solo minor/patch y deja major por separado para npm, Cargo y GitHub Actions',
    (dependabot.match(/applies-to:\s*version-updates/g) ?? []).length === 6
        && (dependabot.match(/- minor\n\s+- patch/g) ?? []).length === 6
        && dependabot.includes('frontend-runtime')
        && dependabot.includes('frontend-tooling')
        && dependabot.includes('tauri-ecosystem')
        && dependabot.includes('actions-minor-patch'),
);
check(
    'Las reglas de Git conservan .github y no asignan filtros LFS indiscriminados',
    !/^\s*(?:\/?\.github\/?|\.\*)\s*$/m.test(ignore)
        && !/^\*\s+filter=lfs\b/m.test(attributes)
        && attributes.includes('*.wasm binary')
        && attributes.includes('*.woff2 binary'),
);

if (failures.length) {
    throw new Error(`Configuración de seguridad GitHub incompleta:\n- ${failures.join('\n- ')}`);
}

console.log('Configuración de seguridad GitHub verificada (10 contratos).');
