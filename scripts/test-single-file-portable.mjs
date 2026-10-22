// Comprueba el empaquetador del portable de un solo archivo sin compilar la
// app: crea un portable con archivos de prueba, lo lee, detecta alteraciones
// y verifica que el formato coincide con el lector de Rust (`single_file.rs`).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createSingleFilePortable,
    EMBEDDED_FILES,
    PORTABLE_MAGIC,
    readSingleFilePortable,
    verifySingleFilePortable,
} from './create-single-file-portable.mjs';

const root = await mkdtemp(join(tmpdir(), 'wterminal-portable-test-'));
try {
    const input = join(root, 'unpacked');
    await mkdir(input);
    const contents = {
        'wterminal.exe': Buffer.from('MZ imagen PE de prueba'),
        'conpty.dll': Buffer.from('conpty'),
        'OpenConsole.exe': Buffer.from('openconsole'),
        'MicrosoftEdgeWebView2Setup.exe': Buffer.alloc(300_000, 7),
        'THIRD-PARTY-NOTICES.txt': Buffer.from('avisos'),
        'WebView2Loader.dll': Buffer.from('no se embebe'),
    };
    for (const [name, data] of Object.entries(contents)) await writeFile(join(input, name), data);

    const output = join(root, 'out', 'WTerminal-1.0.0-Portable.exe');
    const result = await createSingleFilePortable({ inputDir: input, outputPath: output });
    const bytes = await readFile(output);
    assert(bytes.subarray(0, contents['wterminal.exe'].length).equals(contents['wterminal.exe']), 'la imagen PE va primero y sin cambios');
    assert(bytes.subarray(-8).equals(PORTABLE_MAGIC), 'la marca cierra el archivo');
    assert.equal(bytes.length, result.size);

    const portable = await readSingleFilePortable(output);
    assert.equal(portable.payloadStart, contents['wterminal.exe'].length);
    assert.deepEqual(portable.files.map((file) => file.name), EMBEDDED_FILES.map((file) => file.name));
    for (const file of portable.files) {
        assert(bytes.subarray(file.offset, file.offset + file.size).equals(contents[file.name]), `${file.name} embebido tal cual`);
    }
    assert(!portable.files.some((file) => file.name === 'WebView2Loader.dll'), 'el cargador de WebView2 va enlazado en el exe');
    await verifySingleFilePortable(output, input);

    // Un ejecutable normal no es un portable.
    assert.equal(await readSingleFilePortable(join(input, 'wterminal.exe')), null);

    // Una alteración en un archivo embebido se detecta.
    const tampered = Buffer.from(bytes);
    tampered[portable.files[0].offset] ^= 0xff;
    const tamperedPath = join(root, 'alterado.exe');
    await writeFile(tamperedPath, tampered);
    await assert.rejects(() => verifySingleFilePortable(tamperedPath, input), /conpty\.dll no coincide/u);

    // Un archivo obligatorio ausente impide crear el portable.
    await rm(join(input, 'OpenConsole.exe'));
    await assert.rejects(() => createSingleFilePortable({ inputDir: input, outputPath: join(root, 'x.exe') }), /Falta OpenConsole\.exe/u);
    assert.equal(existsSync(join(root, 'x.exe')), false, 'no queda un portable a medias');
} finally {
    await rm(root, { recursive: true, force: true });
}

// Mismo formato en el lector de Rust y en el empaquetador.
const rust = await readFile('src-tauri/src/config/single_file.rs', 'utf8');
assert(rust.includes(`pub const MAGIC: &[u8; 8] = b"${PORTABLE_MAGIC.toString('ascii')}";`), 'la marca de Rust debe coincidir');
assert(rust.includes('const TRAILER_LEN: u64 = 32;') && rust.includes('const FORMAT: u32 = 1;'), 'cola y versión de formato deben coincidir');
for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    assert(rust.includes(`"${name}"`) && EMBEDDED_FILES.some((file) => file.name === name && file.required), `${name} debe ir embebido y lo debe usar Rust`);
}
assert(rust.includes('pub const WEBVIEW2_INSTALLER: &str = "MicrosoftEdgeWebView2Setup.exe";'));
// El portable no es un autoextraíble de 7-Zip.
const packager = await readFile('scripts/create-single-file-portable.mjs', 'utf8');
assert(!/7z\.sfx|RunProgram|InstallPath/u.test(packager), 'el portable no debe volver a ser un SFX de 7-Zip');

console.log('Portable de un solo archivo verificado: formato, contenido, alteraciones y contrato con Rust.');
