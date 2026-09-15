import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NUGET_PACKAGE = 'Microsoft.Windows.Console.ConPTY';
export const NUGET_VERSION = '1.24.260710001';
export const NUGET_BASE = 'https://api.nuget.org/v3-flatcontainer';
// SHA-512 published in NuGet's immutable package metadata for this exact
// version. Pin locally instead of trusting a checksum fetched beside the file.
export const NUGET_SHA512_BASE64 = 'OKMRdAbPiFfqRAid/FJpjuL+ijMGA/JzWKYY4JdJsZ+RuZrwuRMFwOEI+mnEEjexid7hfGupMzA8ANcOQsoYDw==';
export const REQUIRED_FILES = Object.freeze({
  'build/native/runtimes/x64/OpenConsole.exe': 'OpenConsole.exe',
  'runtimes/win-x64/native/conpty.dll': 'conpty.dll',
});

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const GENERATED_FILES = new Set(['OpenConsole.exe', 'conpty.dll', '.conpty-assets.json']);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function assertPeX64(buffer, name) {
  if (buffer.length < 0x100 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`${name} no tiene una cabecera DOS/PE válida.`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length
      || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${name} no contiene una cabecera PE válida.`);
  }
  if (buffer.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`${name} no es un binario PE x64 (AMD64).`);
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  if (sectionCount === 0 || sectionCount > 96 || optionalHeaderSize < 0x70
      || peOffset + 24 + optionalHeaderSize > buffer.length) {
    throw new Error(`${name} tiene una cabecera PE incompleta o incoherente.`);
  }
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Paquete NuGet inválido: rango fuera del archivo (${label}).`);
  }
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error('Paquete NuGet inválido: no se encontró el directorio ZIP central.');
}

export function extractConptyAssets(packageBytes) {
  const buffer = Buffer.from(packageBytes);
  if (buffer.length < 22 || buffer.length > MAX_PACKAGE_BYTES) {
    throw new Error(`Tamaño de paquete NuGet no permitido: ${buffer.length} bytes.`);
  }

  const endOffset = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff) {
    throw new Error('Paquete NuGet inválido: no se admiten ZIP divididos ni ZIP64.');
  }
  requireRange(buffer, centralOffset, centralSize, 'directorio central');
  if (centralOffset + centralSize > endOffset) {
    throw new Error('Paquete NuGet inválido: el directorio central se solapa con el cierre ZIP.');
  }

  const found = new Map();
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(buffer, cursor, 46, 'registro central');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Paquete NuGet inválido: registro central ZIP mal formado.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    requireRange(buffer, cursor, entryLength, 'nombre del registro central');
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff || (flags & 1) !== 0) {
      throw new Error('Paquete NuGet inválido: entrada ZIP cifrada, dividida o ZIP64.');
    }
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (name.includes('\ufffd')) throw new Error('Paquete NuGet inválido: nombre ZIP no UTF-8.');

    if (Object.hasOwn(REQUIRED_FILES, name)) {
      if (found.has(name)) throw new Error(`El paquete repite el recurso obligatorio ${name}.`);
      if (uncompressedSize === 0 || uncompressedSize > MAX_ASSET_BYTES) {
        throw new Error(`Tamaño no permitido para el recurso ${name}.`);
      }
      if (method !== 0 && method !== 8) throw new Error(`Compresión ZIP no admitida para ${name}.`);
      requireRange(buffer, localOffset, 30, `cabecera local de ${name}`);
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Cabecera local ZIP inválida para ${name}.`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      requireRange(buffer, localOffset + 30, localNameLength + localExtraLength + compressedSize, `datos de ${name}`);
      const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
      if (localName !== name) throw new Error(`Los nombres ZIP local/central no coinciden para ${name}.`);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      let data;
      try {
        data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ASSET_BYTES });
      } catch (error) {
        throw new Error(`No se pudo descomprimir ${name}: ${error.message}`);
      }
      if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
        throw new Error(`El tamaño o CRC de ${name} no coincide con el ZIP.`);
      }
      found.set(name, data);
    }
    cursor += entryLength;
  }
  if (cursor !== centralEnd) throw new Error('Paquete NuGet inválido: tamaño del directorio central incoherente.');

  for (const name of Object.keys(REQUIRED_FILES)) {
    if (!found.has(name)) throw new Error(`El paquete oficial no contiene el recurso requerido ${name}.`);
    assertPeX64(found.get(name), REQUIRED_FILES[name]);
  }
  return new Map([...found].map(([archiveName, data]) => [REQUIRED_FILES[archiveName], data]));
}

export function verifyNugetSha512(packageBytes, sidecar) {
  const expectedText = String(sidecar).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(expectedText)) {
    throw new Error('La respuesta de integridad SHA-512 de NuGet tiene un formato inválido.');
  }
  const expected = Buffer.from(expectedText, 'base64');
  const actual = createHash('sha512').update(packageBytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('El SHA-512 del paquete ConPTY no coincide con el valor publicado por NuGet.');
  }
}

async function fetchNuget(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: 'follow' });
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || !['api.nuget.org', 'globalcdn.nuget.org'].includes(finalUrl.hostname)) {
    throw new Error(`${label}: redirección fuera de un dominio HTTPS de NuGet rechazada.`);
  }
  if (!response.ok) throw new Error(`${label}: NuGet respondió HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  const maxBytes = label === 'Paquete ConPTY' ? MAX_PACKAGE_BYTES : 512;
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`${label}: tamaño anunciado supera el límite de seguridad.`);
  }
  if (!response.body) throw new Error(`${label}: respuesta vacía de NuGet.`);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`${label}: respuesta superior al límite de ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

async function currentInstallIsValid(destination) {
  try {
    const manifest = JSON.parse(await readFile(resolve(destination, '.conpty-assets.json'), 'utf8'));
    if (manifest.package !== NUGET_PACKAGE || manifest.version !== NUGET_VERSION
        || typeof manifest.files !== 'object' || manifest.files === null) return false;
    for (const name of Object.values(REQUIRED_FILES)) {
      const digest = createHash('sha256').update(await readFile(resolve(destination, name))).digest('hex');
      if (digest !== manifest.files[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function replaceConptyDirectory(destination, staging, backup, filesystem = {}) {
  const move = filesystem.rename ?? rename;
  const remove = filesystem.rm ?? rm;
  let previousMoved = false;
  try {
    try {
      const oldEntries = await readdir(destination);
      const unexpected = oldEntries.filter((entry) => !GENERATED_FILES.has(entry));
      if (unexpected.length) {
        throw new Error(`No reemplazo una carpeta ConPTY con archivos ajenos: ${unexpected.join(', ')}.`);
      }
      await move(destination, backup);
      previousMoved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    try {
      await move(staging, destination);
    } catch (installError) {
      if (previousMoved) {
        try {
          await move(backup, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Falló la instalación ConPTY y no se pudo restaurar el directorio anterior. `
              + `La copia recuperable se conserva en ${backup}.`,
            { cause: new AggregateError([installError, restoreError]) },
          );
        }
      }
      throw installError;
    }

    if (previousMoved) {
      try {
        await remove(backup, { recursive: true, force: true });
        previousMoved = false;
      } catch (error) {
        throw new Error(
          `ConPTY quedó instalado, pero no se pudo retirar la copia anterior; se conserva en ${backup}.`,
          { cause: error },
        );
      }
    }
  } finally {
    // Nunca borres el único directorio recuperable si fallan tanto el cambio
    // como su rollback; el backup se elimina solo después de una instalación
    // confirmada o se devuelve a su ruta original.
    await remove(staging, { recursive: true, force: true });
  }
}

export async function prepareConpty(projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const vendor = resolve(projectRoot, 'src-tauri/vendor');
  const destination = resolve(vendor, 'conpty');
  if (await currentInstallIsValid(destination)) {
    console.log(`ConPTY ${NUGET_VERSION} ya está preparado y verificado.`);
    return;
  }

  const packageSlug = NUGET_PACKAGE.toLowerCase();
  const versionSlug = NUGET_VERSION.toLowerCase();
  const packageUrl = `${NUGET_BASE}/${packageSlug}/${versionSlug}/${packageSlug}.${versionSlug}.nupkg`;
  console.log(`Descargando ${NUGET_PACKAGE} ${NUGET_VERSION} desde NuGet…`);
  const packageBytes = await fetchNuget(packageUrl, 'Paquete ConPTY');
  verifyNugetSha512(packageBytes, NUGET_SHA512_BASE64);
  const assets = extractConptyAssets(packageBytes);
  const manifest = {
    package: NUGET_PACKAGE,
    version: NUGET_VERSION,
    packageSha512: createHash('sha512').update(packageBytes).digest('base64'),
    files: Object.fromEntries([...assets].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  };

  await mkdir(vendor, { recursive: true });
  const staging = resolve(vendor, `.conpty-staging-${process.pid}-${Date.now()}`);
  const backup = resolve(vendor, `.conpty-backup-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: false });
  try {
    for (const [name, bytes] of assets) await writeFile(resolve(staging, name), bytes, { flag: 'wx' });
    await writeFile(resolve(staging, '.conpty-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

    await replaceConptyDirectory(destination, staging, backup);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  if (!(await currentInstallIsValid(destination))) {
    throw new Error('Los recursos ConPTY instalados no superaron la verificación posterior a la escritura.');
  }
  console.log(`ConPTY ${NUGET_VERSION} verificado y preparado (${assets.size} archivos).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareConpty().catch((error) => {
    console.error(`ERROR: no se pudo preparar ConPTY: ${error.message}`);
    process.exitCode = 1;
  });
}
