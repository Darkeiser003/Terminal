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
): { cursorStyle: NonNullable<ITerminalOptions['cursorStyle']>; cursorWidth: number } {
    switch (preferences.terminalCursorStyle) {
        case 'beam':
            return { cursorStyle: 'bar', cursorWidth: 3 };
        case 'underline-thick':
            return { cursorStyle: 'underline', cursorWidth: 3 };
        default:
            return { cursorStyle: preferences.terminalCursorStyle, cursorWidth: 1 };
    }
}

/**
 * El cursor no debe desaparecer al cambiar el foco entre paneles. xterm usa
 * un estilo distinto para terminales inactivas y su valor por defecto puede
 * ser demasiado tenue sobre algunas paletas/WebView. Reutilizamos la forma
 * elegida por el usuario para que activo e inactivo sean coherentes.
 */
export function cursorInactiveStyle(
    preferences: Preferences
): NonNullable<ITerminalOptions['cursorInactiveStyle']> {
    return cursorOptions(preferences).cursorStyle;
}

/** xterm acepta pesos numéricos, mientras que la preferencia usa nombres
 * legibles. Mantener la conversión aquí hace que los cinco valores se apliquen
 * de verdad en vez de enviar etiquetas CSS que xterm no reconoce. */
export function terminalFontWeight(
    preferences: Preferences
): NonNullable<ITerminalOptions['fontWeight']> {
    switch (preferences.terminalFontWeight) {
        case 'light':
            return 300;
        case 'medium':
            return 500;
        case 'semibold':
            return 600;
        case 'bold':
            return 700;
        default:
            return 400;
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

    root.setProperty('--app-bg', preferences.uiBackgroundColor);
    root.setProperty('--surface', preferences.uiSurfaceColor);
    root.setProperty('--surface-alt', preferences.uiSurfaceAltColor);
    root.setProperty('--surface-hover', mix(preferences.uiSurfaceColor, preferences.uiTextColor, 0.12));
    root.setProperty('--border', preferences.uiBorderColor);
    root.setProperty('--text', preferences.uiTextColor);
    root.setProperty('--muted', preferences.uiMutedColor);
    // El acento y los colores de terminal son editables por separado: mandan
    // los de las preferencias, no los del tema.
    root.setProperty('--accent', preferences.accentColor);
    root.setProperty('--accent-soft', palette.accentSoft);
    root.setProperty('--terminal-bg', preferences.terminalBackground);
    root.setProperty('--terminal-fg', preferences.terminalForeground);
    // El indicador persistente del cursor usa la misma preferencia que xterm.
    // Así el estado de parpadeo no puede dejar la posición de escritura
    // completamente invisible entre dos frames.
    root.setProperty('--terminal-cursor', preferences.terminalCursorColor);
    root.setProperty('--terminal-cursor-width', `${cursorOptions(preferences).cursorWidth}px`);
    root.setProperty('--terminal-padding', `${preferences.terminalPadding}px`);
    root.setProperty('--terminal-font', font?.css ?? 'monospace');
    root.setProperty('--ui-scale', preferences.uiDensity === 'compact' ? '0.9' : '1');

    document.body.dataset.density = preferences.uiDensity;
}

/** La parte de las preferencias que entiende xterm. */
export function terminalTheme(preferences: Preferences, themes: ThemePreset[]): ITheme {
    // Mantener el parámetro hace explícito que la función comparte contrato
    // con applyTheme; los colores editables ya no dependen del preset.
    void themes;
    return {
        background: preferences.terminalBackground,
        foreground: preferences.terminalForeground,
        cursor: preferences.terminalCursorColor,
        cursorAccent: preferences.terminalBackground,
        selectionBackground: preferences.terminalSelectionColor
    };
}

export function terminalFont(preferences: Preferences, fonts: FontFamily[]): string {
    const font = fonts.find((candidate) => candidate.id === preferences.terminalFontFamily);
    return font?.css ?? 'monospace';
}
