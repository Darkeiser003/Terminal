import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  assertPeX64,
  extractConptyAssets,
  replaceConptyDirectory,
  REQUIRED_FILES,
  verifyNugetSha512,
} from './prepare-conpty.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, contents] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(contents);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

const openConsolePath = Object.keys(REQUIRED_FILES).find((name) => name.endsWith('OpenConsole.exe'));
const conptyPath = Object.keys(REQUIRED_FILES).find((name) => name.endsWith('conpty.dll'));
function peFixture() {
  const buffer = Buffer.alloc(512);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(0x00f0, 0x94);
  return buffer;
}
const openConsoleFixture = peFixture();
const conptyFixture = peFixture();
conptyFixture[0x120] = 0x43;
const packageBytes = makeZip([[openConsolePath, openConsoleFixture], [conptyPath, conptyFixture]]);
const extracted = extractConptyAssets(packageBytes);
assert.deepEqual(extracted.get('OpenConsole.exe'), openConsoleFixture);
assert.deepEqual(extracted.get('conpty.dll'), conptyFixture);
assert.throws(() => assertPeX64(Buffer.from('not a PE'), 'fixture.exe'), /cabecera DOS\/PE válida/);
const x86Fixture = peFixture();
x86Fixture.writeUInt16LE(0x014c, 0x84);
assert.throws(() => assertPeX64(x86Fixture, 'fixture-x86.exe'), /no es un binario PE x64/);
assert.throws(() => extractConptyAssets(makeZip([[openConsolePath, openConsoleFixture]])), /no contiene el recurso requerido/);
assert.throws(() => extractConptyAssets(makeZip([
  [openConsolePath, openConsoleFixture], [openConsolePath, openConsoleFixture], [conptyPath, conptyFixture],
])), /repite el recurso obligatorio/);

const expectedSha512 = createHash('sha512').update(packageBytes).digest('base64');
assert.doesNotThrow(() => verifyNugetSha512(packageBytes, expectedSha512));
assert.throws(() => verifyNugetSha512(packageBytes, Buffer.alloc(64).toString('base64')), /no coincide/);
assert.throws(() => verifyNugetSha512(packageBytes, 'malformed'), /formato inválido/);
const corrupted = Buffer.from(packageBytes);
const centralDirectoryOffset = corrupted.readUInt32LE(corrupted.length - 22 + 16);
corrupted.writeUInt32LE((corrupted.readUInt32LE(centralDirectoryOffset + 16) ^ 1) >>> 0, centralDirectoryOffset + 16);
assert.throws(() => extractConptyAssets(corrupted), /CRC/);

const temporaryRoot = await mkdtemp(join(tmpdir(), 'lterminal-conpty-rollback-'));
try {
  const destination = join(temporaryRoot, 'conpty');
  const staging = join(temporaryRoot, '.conpty-staging');
  const backup = join(temporaryRoot, '.conpty-backup');
  await mkdir(destination);
  await mkdir(staging);
  await writeFile(join(destination, 'conpty.dll'), 'previous verified asset');
  await writeFile(join(staging, 'conpty.dll'), 'new verified asset');
  let renameCalls = 0;
  await assert.rejects(
    replaceConptyDirectory(destination, staging, backup, {
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls > 1) throw Object.assign(new Error('simulated filesystem failure'), { code: 'EIO' });
        return rename(...args);
      },
    }),
    (error) => error.message.includes(backup) && error.cause instanceof AggregateError,
    'si falla tanto la instalación como el rollback, se informa y conserva el backup',
  );
  await assert.rejects(readFile(join(destination, 'conpty.dll')), { code: 'ENOENT' });
  assert.equal(await readFile(join(backup, 'conpty.dll'), 'utf8'), 'previous verified asset');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Preparación ConPTY: integridad del ZIP/PE/SHA-512 y rollback recuperable verificados.');
