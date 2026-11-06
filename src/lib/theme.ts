// Traduce las preferencias a variables CSS y a la configuración de xterm.
//
// La versión Electron hacía esto en `applyPreferences` dentro de renderer.js.
// Se mantiene la misma lista de variables (`--app-bg`, `--surface`, ...) para
// que el CSS de la aplicación siga siendo el mismo.

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { FontFamily, Preferences, ThemePalette, ThemePreset } from './types';

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

/** El tema cuya base neutra comparten los demás (ver `effective_palette`
 *  en preferences.rs; las dos reglas tienen que coincidir). */
export const NEUTRAL_THEME_ID = 'winslim';
const FULL_PALETTE_THEMES = ['contrast'];

/** Los colores que aplica un tema: uno propio tal cual; uno de fábrica solo
 *  con su acento sobre la base de «Cian técnico», salvo que se pida
 *  recolorear toda la interfaz. */
export function effectivePalette(
    themeId: string,
    preferences: Pick<Preferences, 'customThemes' | 'themeRecolorAll'>,
    themes: ThemePreset[]
): ThemePalette | null {
    const custom = (preferences.customThemes ?? []).find((theme) => theme.id === themeId);
    if (custom) return custom.palette;
    const theme = themes.find((candidate) => candidate.id === themeId) ?? themes[0];
    if (!theme) return null;
    const base = themes.find((candidate) => candidate.id === NEUTRAL_THEME_ID);
    if (preferences.themeRecolorAll || !base || theme.id === NEUTRAL_THEME_ID || FULL_PALETTE_THEMES.includes(theme.id)) {
        return theme.palette;
    }
    return {
        ...base.palette,
        accent: theme.palette.accent,
        accentSoft: theme.palette.accentSoft,
        selection: theme.palette.selection
    };
}

/** Las preferencias que cambia elegir un tema: sus colores (según el modo)
 *  y, si es propio, su paleta ANSI. Lo usan Ajustes y la orden `:theme`. */
export function themePreferencePatch(
    themeId: string,
    preferences: Pick<Preferences, 'customThemes' | 'themeRecolorAll'>,
    themes: ThemePreset[]
): Partial<Preferences> | null {
    const palette = effectivePalette(themeId, preferences, themes);
    if (!palette) return null;
    const custom = (preferences.customThemes ?? []).find((theme) => theme.id === themeId);
    return {
        themeId,
        accentColor: palette.accent,
        uiBackgroundColor: palette.background,
        uiSurfaceColor: palette.surface,
        uiSurfaceAltColor: palette.surfaceAlt,
        uiBorderColor: palette.border,
        uiTextColor: palette.text,
        uiMutedColor: palette.muted,
        terminalSelectionColor: palette.selection,
        fastfetchColor: palette.accent,
        terminalCursorColor: palette.accent,
        terminalBackground: palette.terminalBackground,
        terminalForeground: palette.terminalForeground,
        ...(custom ? { terminalAnsiColors: [...custom.ansi] } : {})
    };
}

export function applyTheme(
    preferences: Preferences,
    themes: ThemePreset[],
    fonts: FontFamily[]
): void {
    const palette = effectivePalette(preferences.themeId, preferences, themes);
    if (!palette) return;
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
    // xterm 6 genera la capa de selección mediante CSS dinámico. La declaramos
    // también como variable estática para WebKitGTK, donde ese bloque puede no
    // entrar en la hoja activa y dejar la selección invisible.
    root.setProperty('--terminal-selection', preferences.terminalSelectionColor);
    root.setProperty('--terminal-padding', `${preferences.terminalPadding}px`);
    root.setProperty('--terminal-font', terminalFont(preferences, fonts));
    applyUiScale(preferences.uiScale ?? 100);

    document.body.dataset.density = preferences.uiDensity;
}

/** Límites del tamaño de la interfaz, los mismos que valida el backend. */
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 500;
export const UI_SCALE_STEP = 10;
/** Hasta el 200 % se aplica siempre lo pedido, como antes de subir el límite. */
const UI_SCALE_ALWAYS_APPLIED = 200;
/** El ancho mínimo de la ventana (`minWidth` de Tauri): por debajo, la barra
 *  de herramientas ya no cabe aunque se repliegue. */
const UI_SCALE_MIN_LAYOUT_WIDTH = 480;

/** Un valor escrito a mano, redondeado y dentro de los límites. */
export function clampUiScale(value: number): number {
    if (!Number.isFinite(value)) return 100;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value)));
}

/** La escala que de verdad se aplica. Por encima del 200 %, la interfaz
 *  escalada no puede quedar más estrecha que la ventana mínima: al 500 % en
 *  una pantalla de 1920 px la barra quedaría en 384 px y se saldría. Entonces
 *  se aplica la mayor que cabe, y vuelve sola a la pedida al ensanchar. */
export function effectiveUiScale(requested: number, viewportWidth: number): number {
    const wanted = clampUiScale(requested);
    const fitting = Math.floor((viewportWidth / UI_SCALE_MIN_LAYOUT_WIDTH) * 100);
    return Math.min(wanted, Math.max(UI_SCALE_ALWAYS_APPLIED, fitting));
}

let requestedUiScale = 100;
let uiScaleResizeListener = false;

function applyUiScale(requested: number): void {
    requestedUiScale = requested;
    const scale = effectiveUiScale(requested, window.innerWidth);
    document.documentElement.style.setProperty('--ui-scale', String(scale / 100));
    document.documentElement.dataset.uiScale = String(scale);
    if (!uiScaleResizeListener) {
        uiScaleResizeListener = true;
        window.addEventListener('resize', () => applyUiScale(requestedUiScale), { passive: true });
    }
}

/** La parte de las preferencias que entiende xterm. */
export function terminalTheme(preferences: Preferences, themes: ThemePreset[]): ITheme {
    // Mantener el parámetro hace explícito que la función comparte contrato
    // con applyTheme; los colores editables ya no dependen del preset.
    void themes;
    const theme: ITheme = {
        background: preferences.terminalBackground,
        foreground: preferences.terminalForeground,
        cursor: preferences.terminalCursorColor,
        cursorAccent: preferences.terminalBackground,
        selectionBackground: preferences.terminalSelectionColor
    };
    const ansi = preferences.terminalAnsiColors ?? [];
    if (ansi.length === ANSI_COLOR_KEYS.length) {
        ANSI_COLOR_KEYS.forEach((key, index) => {
            theme[key] = ansi[index];
        });
    }
    return theme;
}

/** Orden de los 16 colores ANSI, el mismo que guarda `terminalAnsiColors`. */
export const ANSI_COLOR_KEYS = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const satisfies readonly (keyof ITheme)[];

/** La paleta de 16 colores que xterm usa de fábrica: es el punto de partida
 *  al editar los colores ANSI en Ajustes. */
export const DEFAULT_ANSI_COLORS = [
    '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
];

export function terminalFont(preferences: Preferences, fonts: FontFamily[]): string {
    const font = fonts.find((candidate) => candidate.id === preferences.terminalFontFamily) ?? fonts[0];
    const stack = font?.css ?? 'monospace';
    // La fuente escrita a mano va delante; si no está instalada, el navegador
    // sigue con la familia elegida y sus respaldos de símbolos.
    const custom = preferences.terminalFontCustom?.trim();
    return custom ? `'${custom}', ${stack}` : stack;
}
