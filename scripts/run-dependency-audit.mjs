import { spawn } from 'node:child_process';
import process from 'node:process';
import { SUITES } from '../tests/e2e/suites.mjs';

if (!process.env.E2E_BINARY) {
    throw new Error('E2E_BINARY debe apuntar al wterminal.exe que se quiere auditar.');
}

// La configuración vive en el catálogo de suites (tests/e2e/suites.mjs) para
// que esta auditoría, `scripts/run-e2e-suite.mjs --suite dependency-audit` y
// `windows/build.ps1 -DependencyAudit` ejecuten exactamente lo mismo. Las
// variables ya definidas por quien la lanza conservan prioridad en los
// ajustes de captura, fotogramas y tiempo límite.
const audit = SUITES['dependency-audit'].scenarios[0].env;
const overridable = ['E2E_DEPENDENCY_CAPTURE_EACH_ACTION', 'E2E_VIDEO_FPS', 'E2E_DEPENDENCY_TIMEOUT_MS'];
const environment = { ...process.env, ...audit };
for (const key of overridable) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
}

const child = spawn(process.execPath, ['tests/e2e/smoke.mjs'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    windowsHide: process.platform === 'win32',
});

child.once('error', (error) => {
    throw error;
});
child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
});
