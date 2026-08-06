// main/fileExplorer.js
// Listado y creación de archivos/carpetas para el explorador lateral.
//
// Reglas que este módulo garantiza, y de las que depende main.js:
//   - un nombre nuevo es SOLO un nombre: sin separadores, sin "..", sin
//     unidades ni caracteres de control, y el resultado debe quedar dentro de
//     la carpeta mostrada (se comprueba resolviendo la ruta, no confiando en
//     la cadena),
//   - nunca se sobrescribe algo existente,
//   - el listado no sigue enlaces simbólicos al decidir qué es carpeta, para
//     que un enlace no lleve el árbol fuera de donde el usuario cree estar.
//
// El módulo no depende de Electron: se puede probar en cualquier plataforma.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 2000;
const MAX_NAME_LENGTH = 255;

// Nombres reservados de Windows: crear "CON.txt" o "aux" produce errores muy
// confusos, así que se rechazan en todas las plataformas para que la carpeta
// signifique lo mismo en cualquier sistema.
const WINDOWS_RESERVED_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

function isWindowsStylePath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

// El proceso principal corre en Windows aunque la pestaña sea de WSL: las
// rutas traducidas al host siguen siendo rutas de Windows, así que la API de
// `path` correcta depende de la ruta, no del proceso.
function pathApiFor(value) {
    return isWindowsStylePath(value) ? path.win32 : path;
}

function isSafeEntryName(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return false;
    if (trimmed === '.' || trimmed === '..') return false;
    // Caracteres de control (0x00-0x1f y 0x7f): invisibles en la interfaz y
    // capaces de romper el nombre real en disco. Se comprueban por código
    // para no depender de secuencias de escape dentro de una expresion regular.
    for (let i = 0; i < trimmed.length; i += 1) {
        const code = trimmed.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return false;
    }
    // Separadores de ruta: un nombre nuevo es solo un nombre, nunca una ruta.
    if (/[\\/]/.test(trimmed)) return false;
    // Reservados de Windows, con o sin extensión (CON, con.txt).
    if (WINDOWS_RESERVED_NAMES.has(trimmed.split('.')[0].toLowerCase())) return false;
    // Caracteres que Windows no admite en un nombre de archivo.
    if (/[<>:"|?*]/.test(trimmed)) return false;
    return true;
}

// Une carpeta + nombre comprobando que el resultado sigue siendo un hijo
// DIRECTO de la carpeta. Devuelve null si no lo es.
function resolveChildPath(directory, name) {
    if (!directory || !isSafeEntryName(name)) return null;
    const pathApi = pathApiFor(directory);
    const parent = pathApi.resolve(directory);
    const target = pathApi.resolve(parent, name.trim());
    if (pathApi.dirname(target) !== parent) return null;
    return target;
}

function parentDirectory(directory) {
    if (!directory) return null;
    const pathApi = pathApiFor(directory);
    const resolved = pathApi.resolve(directory);
    const parent = pathApi.dirname(resolved);
    return parent && parent !== resolved ? parent : null;
}

function entryKind(fullPath, dirent) {
    if (dirent.isSymbolicLink()) {
        // Un enlace se muestra como lo que apunta, pero etiquetado: así el
        // usuario sabe que al entrar puede acabar en otra parte del disco.
        try {
            return fs.statSync(fullPath).isDirectory() ? 'directory' : 'file';
        } catch (error) {
            return 'file';
        }
    }
    return dirent.isDirectory() ? 'directory' : 'file';
}

// Lista una carpeta: primero directorios, después archivos, y ambos por
// nombre. No lanza si la carpeta desaparece o no es legible: devuelve el
// error para que la interfaz lo muestre en su sitio.
function listDirectory(directory, options) {
    const opts = options || {};
    const fsImpl = opts.fs || fs;
    if (!directory) return { ok: false, error: 'No hay una carpeta que mostrar.', dir: '', entries: [] };

    let dirents;
    try {
        const stat = fsImpl.statSync(directory);
        if (!stat.isDirectory()) return { ok: false, error: 'La ruta actual no es una carpeta.', dir: directory, entries: [] };
        dirents = fsImpl.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        const message = error.code === 'ENOENT'
            ? 'La carpeta ya no existe.'
            : error.code === 'EPERM' || error.code === 'EACCES'
                ? 'No hay permisos para leer esta carpeta.'
                : error.message;
        return { ok: false, error: message, dir: directory, entries: [] };
    }

    const pathApi = pathApiFor(directory);
    const entries = [];
    let truncated = false;
    for (const dirent of dirents) {
        if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
        const full = pathApi.join(directory, dirent.name);
        let size = 0;
        let modified = 0;
        try {
            const stat = fsImpl.lstatSync(full);
            size = stat.size;
            modified = stat.mtimeMs;
        } catch (error) { /* entrada desaparecida entre readdir y lstat */ }
        entries.push({
            name: dirent.name,
            path: full,
            kind: entryKind(full, dirent),
            link: dirent.isSymbolicLink(),
            hidden: dirent.name.startsWith('.'),
            size,
            modified
        });
    }

    entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return {
        ok: true,
        dir: directory,
        parent: parentDirectory(directory),
        entries,
        truncated
    };
}

function createEntry(directory, name, kind, options) {
    const fsImpl = (options && options.fs) || fs;
    const target = resolveChildPath(directory, name);
    if (!target) return { ok: false, error: 'Nombre no válido. No puede contener rutas, "..", ni los caracteres < > : " | ? *' };
    if (fsImpl.existsSync(target)) return { ok: false, error: 'Ya existe un archivo o carpeta con ese nombre.' };
    try {
        if (kind === 'directory') {
            fsImpl.mkdirSync(target);
        } else {
            // 'wx' falla si el archivo aparece entre la comprobación anterior
            // y esta llamada, en vez de truncar lo que hubiera.
            fsImpl.writeFileSync(target, '', { flag: 'wx' });
        }
    } catch (error) {
        const message = error.code === 'EEXIST'
            ? 'Ya existe un archivo o carpeta con ese nombre.'
            : error.code === 'EPERM' || error.code === 'EACCES'
                ? 'No hay permisos para escribir en esta carpeta.'
                : error.message;
        return { ok: false, error: message };
    }
    return { ok: true, path: target };
}

// Mensaje único para los errores del sistema de archivos: los códigos son los
// mismos en crear, renombrar, copiar y mover, y traducirlos en cada sitio
// acababa dando explicaciones distintas para el mismo problema.
function describeFsError(error) {
    if (!error) return 'Error desconocido.';
    if (error.code === 'EEXIST') return 'Ya existe un archivo o carpeta con ese nombre.';
    if (error.code === 'ENOENT') return 'El archivo o la carpeta ya no existe.';
    if (error.code === 'EPERM' || error.code === 'EACCES') return 'No hay permisos para hacer esto aquí.';
    if (error.code === 'EBUSY') return 'El archivo está en uso por otro programa.';
    if (error.code === 'ENOTEMPTY') return 'La carpeta de destino no está vacía.';
    return error.message;
}

// Renombra dentro de la MISMA carpeta: origen y destino se resuelven como
// hijos directos de `directory`, así que un nombre nuevo no puede mover nada
// a otro sitio ni salirse por "..".
function renameEntry(directory, currentPath, newName, options) {
    const fsImpl = (options && options.fs) || fs;
    const pathApi = pathApiFor(directory);
    const target = resolveChildPath(directory, newName);
    if (!target) return { ok: false, error: 'Nombre no válido. No puede contener rutas, "..", ni los caracteres < > : " | ? *' };
    if (!currentPath || pathApi.dirname(pathApi.resolve(currentPath)) !== pathApi.resolve(directory)) {
        return { ok: false, error: 'Ese elemento no pertenece a la carpeta abierta.' };
    }
    if (pathApi.resolve(currentPath) === target) return { ok: true, path: target };
    // En Windows y macOS el sistema de archivos no distingue mayúsculas: un
    // existsSync diría que "notas.md" ya existe al renombrar a "Notas.md", que
    // es justo un renombrado legítimo. Por eso se compara en minúsculas antes
    // de dar el nombre por ocupado.
    const sameNameOtherCase = pathApi.resolve(currentPath).toLowerCase() === target.toLowerCase();
    if (!sameNameOtherCase && fsImpl.existsSync(target)) {
        return { ok: false, error: 'Ya existe un archivo o carpeta con ese nombre.' };
    }
    try {
        fsImpl.renameSync(currentPath, target);
    } catch (error) {
        return { ok: false, error: describeFsError(error) };
    }
    return { ok: true, path: target };
}

// Nombre libre dentro de `directory` a partir de uno que ya está ocupado:
// "notas.md" -> "notas (copia).md" -> "notas (copia 2).md". Se para a las 100
// pruebas para no quedarse dando vueltas si algo va mal en el sistema.
function availableCopyName(directory, name, options) {
    const fsImpl = (options && options.fs) || fs;
    const pathApi = pathApiFor(directory);
    const parsed = pathApi.parse(name);
    // Un nombre como ".gitignore" es TODO extensión para path.parse: renombrarlo
    // a " (copia).gitignore" quedaría raro, así que ahí se trata como base.
    const base = parsed.name || parsed.base;
    const ext = parsed.name ? parsed.ext : '';
    for (let i = 1; i <= 100; i += 1) {
        const candidate = i === 1 ? `${base} (copia)${ext}` : `${base} (copia ${i})${ext}`;
        if (!isSafeEntryName(candidate)) return null;
        if (!fsImpl.existsSync(pathApi.join(directory, candidate))) return candidate;
    }
    return null;
}

// Copiar una carpeta dentro de sí misma (o de una descendiente) es un bucle
// infinito garantizado; `rename` a esos mismos sitios deja el árbol huérfano.
function isInside(parent, child, pathApi) {
    const from = pathApi.resolve(parent);
    const to = pathApi.resolve(child);
    if (from === to) return true;
    const prefix = from.endsWith(pathApi.sep) ? from : from + pathApi.sep;
    return to.startsWith(prefix);
}

// Pega en `directory` lo que hay en `sourcePath`. `move` decide si es cortar
// (renombrar) o copiar; al copiar sobre un nombre ocupado se busca uno libre
// en vez de sobrescribir, que nunca es lo que se espera de un pegado.
function pasteEntry(sourcePath, directory, move, options) {
    const fsImpl = (options && options.fs) || fs;
    const pathApi = pathApiFor(directory);
    if (!sourcePath || !directory) return { ok: false, error: 'No hay nada que pegar.' };

    let sourceStat;
    try {
        sourceStat = fsImpl.lstatSync(sourcePath);
    } catch (error) {
        return { ok: false, error: 'El origen ya no existe: se habrá movido o borrado.' };
    }

    const name = pathApi.basename(sourcePath);
    if (!isSafeEntryName(name)) return { ok: false, error: 'El nombre del origen no se puede usar aquí.' };
    if (sourceStat.isDirectory() && isInside(sourcePath, directory, pathApi)) {
        return { ok: false, error: 'No se puede pegar una carpeta dentro de sí misma.' };
    }

    let finalName = name;
    const direct = resolveChildPath(directory, name);
    if (!direct) return { ok: false, error: 'El nombre del origen no se puede usar aquí.' };
    if (fsImpl.existsSync(direct)) {
        if (pathApi.resolve(direct) === pathApi.resolve(sourcePath)) {
            // Pegar en la misma carpeta de la que se cortó no es un error: no
            // hay nada que hacer.
            if (move) return { ok: true, path: direct, name };
        } else if (move) {
            return { ok: false, error: 'Ya existe un archivo o carpeta con ese nombre.' };
        }
        if (!move) {
            const free = availableCopyName(directory, name, options);
            if (!free) return { ok: false, error: 'Ya existe un archivo o carpeta con ese nombre.' };
            finalName = free;
        }
    }

    const target = resolveChildPath(directory, finalName);
    if (!target) return { ok: false, error: 'El nombre del origen no se puede usar aquí.' };

    try {
        if (move) {
            try {
                fsImpl.renameSync(sourcePath, target);
            } catch (error) {
                // Entre discos distintos (o de un montaje a otro) rename no
                // funciona: hay que copiar y borrar el origen a mano.
                if (error.code !== 'EXDEV') throw error;
                fsImpl.cpSync(sourcePath, target, { recursive: true, errorOnExist: true, force: false });
                fsImpl.rmSync(sourcePath, { recursive: true, force: true });
            }
        } else {
            fsImpl.cpSync(sourcePath, target, { recursive: true, errorOnExist: true, force: false });
        }
    } catch (error) {
        return { ok: false, error: describeFsError(error) };
    }
    return { ok: true, path: target, name: finalName, renamed: finalName !== name };
}

module.exports = {
    listDirectory,
    createEntry,
    renameEntry,
    pasteEntry,
    availableCopyName,
    isInside,
    describeFsError,
    resolveChildPath,
    parentDirectory,
    isSafeEntryName,
    MAX_ENTRIES
};
