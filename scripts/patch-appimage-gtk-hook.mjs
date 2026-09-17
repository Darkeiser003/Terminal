#!/usr/bin/env node

import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = '# LTerminal selects a usable GTK backend for the current session.';

export function patchGtkHook(source) {
    if (source.includes(marker)) return source;

    const forcedX11 = /^export GDK_BACKEND=x11[^\r\n]*$/gm;
    const matches = source.match(forcedX11) ?? [];
    if (matches.length !== 1) {
        throw new Error(`Se esperaba exactamente una selección GDK_BACKEND=x11; encontradas: ${matches.length}.`);
    }

    const selection = [
        marker,
        'if [[ -n "${LTERMINAL_GDK_BACKEND:-}" ]]; then',
        '    export GDK_BACKEND="$LTERMINAL_GDK_BACKEND"',
        'else',
        '    LTERMINAL_WAYLAND_SOCKET=""',
        '    if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then',
        '        if [[ "$WAYLAND_DISPLAY" = /* ]]; then',
        '            LTERMINAL_WAYLAND_SOCKET="$WAYLAND_DISPLAY"',
        '        elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then',
        '            LTERMINAL_WAYLAND_SOCKET="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"',
        '        fi',
        '    fi',
        '    if [[ -n "$LTERMINAL_WAYLAND_SOCKET" && -S "$LTERMINAL_WAYLAND_SOCKET" ]]; then',
        '        export GDK_BACKEND=wayland',
        '    else',
        '        export GDK_BACKEND=x11',
        '    fi',
        '    unset LTERMINAL_WAYLAND_SOCKET',
        'fi',
    ].join('\n');

    return source.replace(forcedX11, selection);
}

const directExecution = process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directExecution) {
    const targetArgument = process.argv[2];
    if (!targetArgument) {
        console.error('Uso: node scripts/patch-appimage-gtk-hook.mjs RUTA_AL_HOOK');
        process.exitCode = 2;
    } else {
        const target = resolve(targetArgument);
        const metadata = await lstat(target);
        if (!metadata.isFile()) throw new Error(`El hook GTK debe ser un archivo regular: ${target}`);

        const current = await readFile(target, 'utf8');
        const updated = patchGtkHook(current);
        if (updated !== current) {
            const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
            try {
                await writeFile(temporary, updated, { encoding: 'utf8', mode: metadata.mode & 0o777 });
                await chmod(temporary, metadata.mode & 0o777);
                await rename(temporary, target);
            } catch (error) {
                await unlink(temporary).catch(() => {});
                throw error;
            }
        }
        console.log(`Hook GTK adaptado a Wayland/X11: ${target}`);
    }
}
