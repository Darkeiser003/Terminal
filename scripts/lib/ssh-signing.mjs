import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_NAMESPACE = 'lterminal-release';

async function isFile(path) {
    if (!path) return false;
    try {
        await access(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

export async function resolveSshKeygen() {
    const explicit = process.env.LTERMINAL_SSH_KEYGEN;
    const candidates = [explicit];
    if (platform() === 'win32') {
        candidates.push(
            process.env.ProgramW6432 && join(process.env.ProgramW6432, 'Git', 'usr', 'bin', 'ssh-keygen.exe'),
            process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'ssh-keygen.exe'),
            process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'ssh-keygen.exe'),
            process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'ssh-keygen.exe'),
        );
    } else {
        candidates.push('/usr/bin/ssh-keygen', '/bin/ssh-keygen');
    }
    for (const candidate of candidates) if (await isFile(candidate)) return candidate;
    return 'ssh-keygen';
}

function configuredIdentity() {
    return process.env.LTERMINAL_SSH_SIGNING_IDENTITY
        || process.env.LTERMINAL_SSH_UPDATE_IDENTITY
        || 'lterminal-release@local';
}

function configuredNamespace() {
    return process.env.LTERMINAL_SSH_SIGNATURE_NAMESPACE || DEFAULT_NAMESPACE;
}

export async function resolveSshSigningConfiguration({ requirePrivate = false } = {}) {
    const home = homedir();
    const privateKey = process.env.LTERMINAL_SSH_SIGNING_KEY_FILE
        || process.env.LTERMINAL_SSH_UPDATE_PRIVATE_KEY_FILE
        || join(home, '.ssh', 'lterminal-release-signing');
    const publicKey = process.env.LTERMINAL_SSH_SIGNING_PUBLIC_KEY_FILE
        || process.env.LTERMINAL_SSH_UPDATE_PUBLIC_KEY_FILE
        || `${privateKey}.pub`;
    const keygen = await resolveSshKeygen();
    const hasPublic = await isFile(publicKey);
    const hasPrivate = await isFile(privateKey);
    if (!hasPublic || (requirePrivate && !hasPrivate)) {
        throw new Error(requirePrivate
            ? 'Falta la clave privada/pública OpenSSH para firmar la release.'
            : 'Falta la clave pública OpenSSH para verificar la release.');
    }
    return {
        keygen,
        privateKey,
        publicKey,
        identity: configuredIdentity(),
        namespace: configuredNamespace(),
    };
}

async function run(program, args, input = undefined) {
    return await new Promise((resolvePromise, reject) => {
        const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

async function allowedSigners(path, configuration) {
    const fields = (await readFile(configuration.publicKey, 'utf8')).trim().split(/\s+/);
    if (fields.length < 2 || !/^(ssh-|sk-ssh-|ecdsa-)/.test(fields[0])) {
        throw new Error('La clave pública SSH no tiene un formato OpenSSH admitido.');
    }
    await writeFile(path, `${configuration.identity} ${fields[0]} ${fields[1]}\n`, { mode: 0o600 });
}

export async function verifySshManifest(manifest, signature, configuration = undefined) {
    const config = configuration || await resolveSshSigningConfiguration();
    const temporary = await mkdtemp(join(tmpdir(), 'lterminal-ssh-verify-'));
    try {
        const allowed = join(temporary, 'allowed_signers');
        await allowedSigners(allowed, config);
        const result = await run(config.keygen, [
            '-Y', 'verify', '-f', allowed, '-I', config.identity,
            '-n', config.namespace, '-s', signature,
        ], await readFile(manifest));
        if (result.code !== 0) {
            throw new Error(`La firma OpenSSH no es válida: ${result.stderr.trim() || result.stdout.trim()}`);
        }
        return true;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

export async function signSshManifest(manifest, signature, configuration = undefined) {
    const config = configuration || await resolveSshSigningConfiguration({ requirePrivate: true });
    const temporary = await mkdtemp(join(tmpdir(), 'lterminal-ssh-sign-'));
    try {
        const staged = join(temporary, basename(manifest));
        const stagedSignature = `${staged}.sig`;
        await cp(manifest, staged);
        const result = await run(config.keygen, [
            '-Y', 'sign', '-f', config.privateKey, '-n', config.namespace, staged,
        ]);
        if (result.code !== 0 || !(await isFile(stagedSignature))) {
            throw new Error(`ssh-keygen no pudo firmar el manifiesto: ${result.stderr.trim() || result.stdout.trim()}`);
        }
        await verifySshManifest(staged, stagedSignature, config);
        await cp(stagedSignature, resolve(dirname(signature), basename(signature)));
        return true;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

export { DEFAULT_NAMESPACE };
