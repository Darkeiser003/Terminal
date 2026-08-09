// Traduce las preferencias a variables CSS y a la configuración de xterm.
//
// La versión Electron hacía esto en `applyPreferences` dentro de renderer.js.
// Se mantiene la misma lista de variables (`--app-bg`, `--surface`, ...) para
// que el CSS de la aplicación siga siendo el mismo.

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { FontFamily, Preferences, ThemePreset } from './types';

/** xterm solo admite tres estilos de cursor. Los dos extra que ofrece Ajustes
 *  ("Barra gruesa" y "Subrayado grueso") son esos mismos con más grosor, así
 *  que se traducen aquí en vez de llegar a xterm como un valor que rechaza. */
export function cursorOptions(
    preferences: Preferences
): Pick<ITerminalOptions, 'cursorStyle' | 'cursorWidth'> {
    switch (preferences.terminalCursorStyle) {
        case 'beam':
            return { cursorStyle: 'bar', cursorWidth: 3 };
        case 'underline-thick':
            return { cursorStyle: 'underline', cursorWidth: 3 };
        default:
            return { cursorStyle: preferences.terminalCursorStyle, cursorWidth: 1 };
    }
}

/** Mezcla dos colores hexadecimales. Se usa para el estado `hover`, que no
 *  está en la paleta pero se deriva de la superficie y el acento. */
function mix(a: string, b: string, weight: number): string {
    const parse = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    const [ar, ag, ab] = parse(a);
    const [br, bg, bb] = parse(b);
    const channel = (x: number, y: number) => Math.round(x + (y - x) * weight);
    const toHex = (value: number) => value.toString(16).padStart(2, '0');
    return `#${toHex(channel(ar, br))}${toHex(channel(ag, bg))}${toHex(channel(ab, bb))}`;
}

export function applyTheme(
    preferences: Preferences,
    themes: ThemePreset[],
    fonts: FontFamily[]
): void {
    const theme = themes.find((candidate) => candidate.id === preferences.themeId) ?? themes[0];
    if (!theme) return;
    const font = fonts.find((candidate) => candidate.id === preferences.terminalFontFamily) ?? fonts[0];
    const { palette } = theme;
    const root = document.documentElement.style;

    root.setProperty('--app-bg', palette.background);
    root.setProperty('--surface', palette.surface);
    root.setProperty('--surface-alt', palette.surfaceAlt);
    root.setProperty('--surface-hover', mix(palette.surface, palette.text, 0.12));
    root.setProperty('--border', palette.border);
    root.setProperty('--text', palette.text);
    root.setProperty('--muted', palette.muted);
    // El acento y los colores de terminal son editables por separado: mandan
    // los de las preferencias, no los del tema.
    root.setProperty('--accent', preferences.accentColor);
    root.setProperty('--accent-soft', palette.accentSoft);
    root.setProperty('--terminal-bg', preferences.terminalBackground);
    root.setProperty('--terminal-fg', preferences.terminalForeground);
    root.setProperty('--terminal-padding', `${preferences.terminalPadding}px`);
    root.setProperty('--terminal-font', font?.css ?? 'monospace');
    root.setProperty('--ui-scale', preferences.uiDensity === 'compact' ? '0.9' : '1');

    document.body.dataset.density = preferences.uiDensity;
}

/** La parte de las preferencias que entiende xterm. */
export function terminalTheme(preferences: Preferences, themes: ThemePreset[]): ITheme {
    const theme = themes.find((candidate) => candidate.id === preferences.themeId) ?? themes[0];
    return {
        background: preferences.terminalBackground,
        foreground: preferences.terminalForeground,
        cursor: preferences.accentColor,
        cursorAccent: preferences.terminalBackground,
        selectionBackground: theme?.palette.selection
    };
}

export function terminalFont(preferences: Preferences, fonts: FontFamily[]): string {
    const font = fonts.find((candidate) => candidate.id === preferences.terminalFontFamily);
    return font?.css ?? 'monospace';
}
