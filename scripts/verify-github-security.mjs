import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const codeql = read('.github/workflows/codeql.yml');
const workflowSecurity = read('.github/workflows/workflow-security.yml');
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
    'Las reglas de Git conservan .github y no asignan filtros LFS indiscriminados',
    !/^\s*(?:\/?\.github\/?|\.\*)\s*$/m.test(ignore)
        && !/^\*\s+filter=lfs\b/m.test(attributes)
        && attributes.includes('*.wasm binary')
        && attributes.includes('*.woff2 binary'),
);

if (failures.length) {
    throw new Error(`Configuración de seguridad GitHub incompleta:\n- ${failures.join('\n- ')}`);
}

console.log('Configuración de seguridad GitHub verificada (6 contratos).');
