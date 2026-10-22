import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveSshKeygen, signSshManifest, verifySshManifest } from './lib/ssh-signing.mjs';

const keygen = await resolveSshKeygen();
const root = await mkdtemp(join(tmpdir(), 'lterminal-release-ssh-test-'));
const privateKey = join(root, 'release-key');
const publicKey = `${privateKey}.pub`;
const manifest = join(root, 'SHA256SUMS.txt');
const signature = join(root, 'SHA256SUMS.txt.sshsig');

function run(args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(keygen, args, { stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('close', (code) => resolvePromise(code));
    });
}

try {
    assert.equal(await run(['-q', '-t', 'ed25519', '-N', '', '-C', 'lterminal-test', '-f', privateKey]), 0);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(manifest, 'a'.repeat(64) + '  package.zip\n'));
    const config = {
        keygen,
        privateKey,
        publicKey,
        identity: 'lterminal-test',
        namespace: 'lterminal-release',
    };
    await signSshManifest(manifest, signature, config);
    await verifySshManifest(manifest, signature, config);
    await import('node:fs/promises').then(({ appendFile }) => appendFile(manifest, 'tampered\n'));
    await assert.rejects(() => verifySshManifest(manifest, signature, config));
    assert.match(await readFile(signature, 'utf8'), /BEGIN SSH SIGNATURE/);
    console.log('Firma OpenSSH de manifiestos verificada y alteración detectada.');
} finally {
    await rm(root, { recursive: true, force: true });
}
