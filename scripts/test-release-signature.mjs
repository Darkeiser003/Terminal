import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const publicHex = publicDer.subarray(-32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'lterminal-release-signature-'));
const manifest = join(directory, 'SHA256SUMS.txt');
const signature = join(directory, 'SHA256SUMS.txt.sig');
const helper = resolve('scripts/sign-release-manifest.mjs');

function run(args, env = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [helper, ...args], {
            env: { ...process.env, ...env },
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolvePromise({ code, stderr }));
    });
}

try {
    await writeFile(manifest, 'a'.repeat(64) + '  LTerminal-1.4.4-x86_64.AppImage\n');
    let result = await run(['--manifest', manifest, '--signature', signature], {
        LTERMINAL_SIGNING_PRIVATE_KEY: privatePem.toString(),
    });
    assert.equal(result.code, 0, result.stderr);
    result = await run(['--manifest', manifest, '--signature', signature, '--verify'], {
        LTERMINAL_UPDATE_PUBLIC_KEY: publicHex,
    });
    assert.equal(result.code, 0, result.stderr);
    await writeFile(manifest, 'b'.repeat(64) + '  LTerminal-1.4.4-x86_64.AppImage\n');
    result = await run(['--manifest', manifest, '--signature', signature, '--verify'], {
        LTERMINAL_UPDATE_PUBLIC_KEY: publicHex,
    });
    assert.notEqual(result.code, 0, 'un manifiesto modificado debe invalidar la firma');
    assert.equal((await readFile(signature, 'utf8')).trim().length > 0, true);
    console.log('Firma Ed25519 de manifiestos verificada y alteración detectada.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
