// Portable de un solo archivo: `wterminal.exe` con sus archivos de apoyo
// añadidos al final, fuera de la imagen PE. No es un autoextraíble: Windows
// arranca el ejecutable directamente y la app lee de su propio archivo lo que
// necesita cuando lo necesita (ver `src-tauri/src/config/single_file.rs`).
//
// Formato: [imagen PE][archivo 1]…[archivo N][índice JSON][cola de 32 bytes]
// La cola son tres u64 little-endian (inicio de los archivos, posición y
// longitud del índice) seguidos de la marca `WTPORT01`.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PORTABLE_MAGIC = Buffer.from('WTPORT01', 'ascii');
const TRAILER_BYTES = 32;
const FORMAT = 1;

/**
 * Lo que va dentro, en este orden. `WebView2Loader.dll` no hace falta: el
 * cargador de WebView2 está enlazado estáticamente en `wterminal.exe`.
 */
export const EMBEDDED_FILES = [
    { name: 'conpty.dll', required: true },
    { name: 'OpenConsole.exe', required: true },
    { name: 'MicrosoftEdgeWebView2Setup.exe', required: true },
    { name: 'THIRD-PARTY-NOTICES.txt', required: true },
];

async function sha256File(path, start = 0, end = undefined) {
    const hash = createHash('sha256');
    const options = end === undefined ? { start } : { start, end: end - 1 };
    if (end !== undefined && end <= start) return hash.digest('hex');
    for await (const chunk of createReadStream(path, options)) hash.update(chunk);
    return hash.digest('hex');
}

async function appendFile(stream, path) {
    for await (const chunk of createReadStream(path)) {
        if (!stream.write(chunk)) await new Promise((resolveDrain) => stream.once('drain', resolveDrain));
    }
}

function u64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
}

/**
 * Crea el portable. Escribe a un temporal junto al destino y lo renombra al
 * final: nunca queda un `-Portable.exe` a medias con el nombre definitivo.
 */
export async function createSingleFilePortable({ inputDir, outputPath, files = EMBEDDED_FILES }) {
    const input = resolve(inputDir);
    const output = resolve(outputPath);
    const base = join(input, 'wterminal.exe');
    const baseSize = (await stat(base)).size;
    const present = [];
    for (const file of files) {
        const path = join(input, file.name);
        try {
            const info = await stat(path);
            if (!info.isFile() || info.size === 0) throw new Error('vacío');
            present.push({ ...file, path, size: info.size });
        } catch {
            if (file.required) throw new Error(`Falta ${file.name} en ${input}; el portable quedaría incompleto.`);
        }
    }
    await mkdir(dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    const stream = createWriteStream(temporary);
    try {
        await appendFile(stream, base);
        let offset = baseSize;
        const entries = [];
        for (const file of present) {
            entries.push({ name: file.name, offset, size: file.size, sha256: await sha256File(file.path) });
            await appendFile(stream, file.path);
            offset += file.size;
        }
        const index = Buffer.from(JSON.stringify({ format: FORMAT, files: entries }), 'utf8');
        const trailer = Buffer.concat([u64(baseSize), u64(offset), u64(index.length), PORTABLE_MAGIC]);
        stream.write(index);
        stream.write(trailer);
        await new Promise((resolveEnd, rejectEnd) => {
            stream.once('error', rejectEnd);
            stream.end(resolveEnd);
        });
        await rm(output, { force: true });
        await rename(temporary, output);
        return { outputPath: output, size: offset + index.length + TRAILER_BYTES, baseSize, entries };
    } catch (error) {
        stream.destroy();
        await rm(temporary, { force: true });
        throw error;
    }
}

/**
 * Lee el índice de un portable. Igual que `Payload::read` en Rust, pero sin
 * firma Authenticode (la release no se firma; si se firmara, la build lo
 * haría después de esta comprobación).
 */
export async function readSingleFilePortable(path) {
    const handle = await open(path, 'r');
    try {
        const { size } = await handle.stat();
        if (size < TRAILER_BYTES) return null;
        const trailer = Buffer.alloc(TRAILER_BYTES);
        await handle.read(trailer, 0, TRAILER_BYTES, size - TRAILER_BYTES);
        if (!trailer.subarray(24).equals(PORTABLE_MAGIC)) return null;
        const payloadStart = Number(trailer.readBigUInt64LE(0));
        const indexOffset = Number(trailer.readBigUInt64LE(8));
        const indexLength = Number(trailer.readBigUInt64LE(16));
        if (indexOffset + indexLength !== size - TRAILER_BYTES || payloadStart > indexOffset || indexLength > 64 * 1024) {
            throw new Error(`La cola del portable apunta fuera de su contenido: ${path}`);
        }
        const raw = Buffer.alloc(indexLength);
        await handle.read(raw, 0, indexLength, indexOffset);
        const index = JSON.parse(raw.toString('utf8'));
        if (index.format !== FORMAT || !Array.isArray(index.files)) throw new Error(`Formato de portable desconocido: ${path}`);
        for (const entry of index.files) {
            if (entry.offset < payloadStart || entry.offset + entry.size > indexOffset) {
                throw new Error(`${entry.name} queda fuera del contenido del portable.`);
            }
        }
        return { payloadStart, indexOffset, files: index.files };
    } finally {
        await handle.close();
    }
}

/**
 * Comprueba un portable contra la carpeta de la que salió: la imagen PE es
 * `wterminal.exe` byte a byte y cada archivo embebido coincide por SHA-256
 * con el índice y con el original.
 */
export async function verifySingleFilePortable(path, inputDir, files = EMBEDDED_FILES) {
    const portable = await readSingleFilePortable(path);
    if (!portable) throw new Error(`${path} no lleva contenido embebido: no es el portable de un solo archivo.`);
    const problems = [];
    const base = join(resolve(inputDir), 'wterminal.exe');
    const baseSize = (await stat(base)).size;
    if (portable.payloadStart !== baseSize) problems.push(`la imagen PE mide ${portable.payloadStart} bytes y wterminal.exe ${baseSize}`);
    else if (await sha256File(path, 0, baseSize) !== await sha256File(base)) problems.push('la imagen PE no es wterminal.exe');
    for (const file of files) {
        const entry = portable.files.find((item) => item.name === file.name);
        if (!entry) {
            if (file.required) problems.push(`falta ${file.name}`);
            continue;
        }
        const embedded = await sha256File(path, entry.offset, entry.offset + entry.size);
        if (embedded !== entry.sha256) problems.push(`${file.name} no coincide con su SHA-256 del índice`);
        if (embedded !== await sha256File(join(resolve(inputDir), file.name))) problems.push(`${file.name} no es el de ${inputDir}`);
    }
    if (problems.length) throw new Error(`Portable inválido (${basename(path)}): ${problems.join('; ')}`);
    return portable;
}

async function main(args) {
    const value = (name) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const input = value('--input');
    const output = value('--output');
    const verify = value('--verify');
    if (args.includes('--help') || (!verify && (!input || !output)) || (verify && !input)) {
        console.error('Uso: node scripts/create-single-file-portable.mjs --input <carpeta unpacked> --output <exe>');
        console.error('     node scripts/create-single-file-portable.mjs --verify <exe> --input <carpeta unpacked>');
        process.exitCode = args.includes('--help') ? 0 : 2;
        return;
    }
    if (verify) {
        const portable = await verifySingleFilePortable(verify, input);
        console.log(`Portable verificado: ${portable.files.map((file) => file.name).join(', ')} coinciden con ${resolve(input)}.`);
        return;
    }
    const result = await createSingleFilePortable({ inputDir: input, outputPath: output });
    await verifySingleFilePortable(result.outputPath, input);
    console.log(`Portable de un solo archivo: ${result.outputPath} (${Math.round(result.size / 1024 / 1024)} MiB, ${result.entries.length} archivos embebidos).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    await main(process.argv.slice(2));
}
