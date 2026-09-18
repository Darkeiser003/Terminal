/** Utilidades puras de idioma e identidad compartidas por todos los paneles.
 * Mantenerlas aquí evita que cada vista fije por su cuenta el español o una
 * de las dos marcas de la aplicación. */

function safeLocale(locale?: string): string {
    const candidate = locale?.trim();
    if (!candidate || candidate === 'auto') return 'en';
    try {
        // Obliga al motor a validar el identificador antes de que llegue a las
        // búsquedas y ordenaciones reactivas de la interfaz.
        return Intl.getCanonicalLocales(candidate)[0] ?? 'en';
    } catch {
        return 'en';
    }
}

export function foldLocalized(value: string, locale?: string): string {
    return value.normalize('NFKC').toLocaleLowerCase(safeLocale(locale));
}

export function includesLocalized(value: string, query: string, locale?: string): boolean {
    return foldLocalized(value, locale).includes(foldLocalized(query.trim(), locale));
}

export function compareLocalized(left: string, right: string, locale?: string): number {
    return left.localeCompare(right, safeLocale(locale), {
        sensitivity: 'base',
        numeric: true,
    });
}

/** Adapta textos compartidos a la identidad real de la build. Los reemplazos
 * largos van primero para no convertir “WTerminal Projects” en “LTerminals”. */
export function platformBrandText(text: string, platform?: string, appName?: string): string {
    if (platform === 'windows') {
        const name = appName || 'WTerminal';
        return text
            .replaceAll('LTerminal Projects', 'WTerminal Projects')
            .replaceAll('WinSlim Projects', 'WTerminal Projects')
            .replaceAll('WinSlim Terminal', name)
            .replaceAll('WinSlimTerminal', name)
            .replaceAll('winslim://', 'wterminal://')
            .replaceAll('WinSlim', 'WTerminal')
            .replaceAll('LTerminal', name);
    }

    if (platform === 'linux' || platform === 'macos') {
        const name = appName || 'LTerminal';
        return text
            .replaceAll('WTerminal Projects', `${name} Projects`)
            .replaceAll('WTerminal', name);
    }

    return text;
}
