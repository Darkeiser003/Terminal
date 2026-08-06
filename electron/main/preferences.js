// Preferencias editables desde la UI. Este módulo no depende de Electron,
// de modo que la validación se puede probar también en Linux y en CI.

const THEME_PRESETS = Object.freeze([
    Object.freeze({
        id: 'silver', label: 'Negro y plata', description: 'Negro profundo, grises metálicos y contraste neutro.',
        palette: Object.freeze({ background: '#080808', surface: '#191919', surfaceAlt: '#111111', border: '#3b3d40', text: '#d7d7d7', muted: '#8b8e92', accent: '#b8bec6', accentSoft: '#34383d', terminalBackground: '#080808', terminalForeground: '#d7d7d7', selection: '#4b5056' })
    }),
    Object.freeze({
        id: 'winslim', label: 'Cian técnico', description: 'Cian técnico y superficies neutras.',
        palette: Object.freeze({ background: '#0d0d0d', surface: '#1e1e1e', surfaceAlt: '#161616', border: '#333333', text: '#d4d4d4', muted: '#888888', accent: '#0078d4', accentSoft: '#0d3553', terminalBackground: '#0d0d0d', terminalForeground: '#d4d4d4', selection: '#264f78' })
    }),
    Object.freeze({
        id: 'ocean', label: 'Océano', description: 'Azules profundos con contraste frío.',
        palette: Object.freeze({ background: '#081018', surface: '#111d29', surfaceAlt: '#0c1721', border: '#284055', text: '#d7e7f4', muted: '#7890a4', accent: '#2f9bff', accentSoft: '#123a5d', terminalBackground: '#071019', terminalForeground: '#d7e7f4', selection: '#214d70' })
    }),
    Object.freeze({
        id: 'forest', label: 'Bosque', description: 'Verdes sobrios para sesiones largas.',
        palette: Object.freeze({ background: '#0b120e', surface: '#17221b', surfaceAlt: '#111a14', border: '#304237', text: '#d7e5da', muted: '#7f9485', accent: '#45b96b', accentSoft: '#173d24', terminalBackground: '#09110c', terminalForeground: '#d7e5da', selection: '#245334' })
    }),
    Object.freeze({
        id: 'amber', label: 'Ámbar', description: 'Cálido, inspirado en terminales clásicas.',
        palette: Object.freeze({ background: '#120f0a', surface: '#241e15', surfaceAlt: '#1a160f', border: '#4a3b27', text: '#eee2cd', muted: '#9b8a70', accent: '#d99732', accentSoft: '#4d3514', terminalBackground: '#100d08', terminalForeground: '#f0dfbe', selection: '#5b421d' })
    }),
    Object.freeze({
        id: 'violet', label: 'Violeta', description: 'Contraste moderno con acento púrpura.',
        palette: Object.freeze({ background: '#0f0c16', surface: '#211a2d', surfaceAlt: '#171220', border: '#403451', text: '#e5dcf0', muted: '#9383a7', accent: '#9a6ee8', accentSoft: '#352451', terminalBackground: '#0e0b14', terminalForeground: '#e5dcf0', selection: '#493568' })
    }),
    Object.freeze({
        id: 'nordic', label: 'Nórdico', description: 'Azul grisáceo de baja saturación, poco cansado.',
        palette: Object.freeze({ background: '#2e3440', surface: '#3b4252', surfaceAlt: '#343b48', border: '#4c566a', text: '#e5e9f0', muted: '#9aa5b8', accent: '#88c0d0', accentSoft: '#3c5766', terminalBackground: '#2b303b', terminalForeground: '#e5e9f0', selection: '#4c566a' })
    }),
    Object.freeze({
        id: 'crimson', label: 'Carmesí', description: 'Rojo intenso sobre grafito, para destacar el foco.',
        palette: Object.freeze({ background: '#120b0c', surface: '#241618', surfaceAlt: '#1a1011', border: '#4a2b2f', text: '#f0dcdd', muted: '#a4848a', accent: '#e05561', accentSoft: '#4d1b22', terminalBackground: '#100a0b', terminalForeground: '#f0dcdd', selection: '#5b2830' })
    }),
    Object.freeze({
        id: 'matrix', label: 'Fósforo verde', description: 'Verde sobre negro, como las terminales de fósforo.',
        palette: Object.freeze({ background: '#000000', surface: '#0c150c', surfaceAlt: '#080f08', border: '#1f3a1f', text: '#9df79d', muted: '#5f9c5f', accent: '#3ddc45', accentSoft: '#123d16', terminalBackground: '#000000', terminalForeground: '#8ef78e', selection: '#1f5424' })
    }),
    Object.freeze({
        id: 'contrast', label: 'Alto contraste', description: 'Blanco puro sobre negro, pensado para baja visión.',
        palette: Object.freeze({ background: '#000000', surface: '#101010', surfaceAlt: '#080808', border: '#6f6f6f', text: '#ffffff', muted: '#c4c4c4', accent: '#ffd400', accentSoft: '#4a3b00', terminalBackground: '#000000', terminalForeground: '#ffffff', selection: '#6f6f6f' })
    }),
    // Todo el catálogo es oscuro a propósito. Un tema claro obliga a revisar
    // cada color que la interfaz da por hecho (bordes de xterm, sombras de los
    // paneles, el degradado de las tarjetas de tema) y sin eso se ve roto.
    Object.freeze({
        id: 'slate', label: 'Pizarra', description: 'Gris azulado neutro, sin tinte dominante.',
        palette: Object.freeze({ background: '#101418', surface: '#1c2228', surfaceAlt: '#151a1f', border: '#39424c', text: '#dbe1e8', muted: '#8b96a3', accent: '#7aa2c4', accentSoft: '#2b3a48', terminalBackground: '#0e1216', terminalForeground: '#dbe1e8', selection: '#3c4a58' })
    }),
    Object.freeze({
        id: 'plum', label: 'Ciruela', description: 'Magenta apagado sobre un fondo muy oscuro.',
        palette: Object.freeze({ background: '#120d13', surface: '#231827', surfaceAlt: '#1a121d', border: '#463149', text: '#ecdcee', muted: '#a288a6', accent: '#c774d4', accentSoft: '#472151', terminalBackground: '#100b11', terminalForeground: '#ecdcee', selection: '#54305c' })
    }),
    Object.freeze({
        id: 'teal', label: 'Turquesa', description: 'Verde azulado frío, alto contraste sin ser duro.',
        palette: Object.freeze({ background: '#08120f', surface: '#12211d', surfaceAlt: '#0d1815', border: '#2a4640', text: '#d3ebe4', muted: '#7d9c94', accent: '#2fbfa0', accentSoft: '#124038', terminalBackground: '#06100d', terminalForeground: '#d3ebe4', selection: '#1d564b' })
    })
]);

const FONT_FAMILIES = Object.freeze([
    Object.freeze({ id: 'system-mono', label: 'Cascadia / Consolas', css: "'Cascadia Code', Consolas, 'Courier New', monospace" }),
    Object.freeze({ id: 'jetbrains', label: 'JetBrains Mono', css: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace" }),
    Object.freeze({ id: 'fira', label: 'Fira Code', css: "'Fira Code', 'Cascadia Code', Consolas, monospace" }),
    Object.freeze({ id: 'monospace', label: 'Monoespaciada del sistema', css: 'monospace' })
]);

const { LANGUAGES } = require('./i18n');

const DEFAULT_PREFERENCES = Object.freeze({
    // 'auto' = el idioma del sistema. Ver resolveLanguage en i18n.js.
    language: 'auto',
    scriptsHereDepth: 3,
    autoStartDocker: true,
    exclusiveAccordionGroups: true,
    autoOpenFirstGroup: false,
    showSystemBanner: true,
    themeId: 'silver',
    accentColor: '#b8bec6',
    terminalBackground: '#080808',
    terminalForeground: '#d7d7d7',
    terminalFontFamily: 'system-mono',
    terminalFontSize: 14,
    terminalLineHeight: 1.1,
    terminalLetterSpacing: 0,
    terminalCursorStyle: 'block',
    terminalFontWeight: 'normal',
    terminalPadding: 10,
    terminalScrollback: 5000,
    terminalCursorBlink: true,
    // Cuántas líneas avanza una muesca de la rueda. xterm usa 1 de fábrica,
    // que en un historial largo obliga a girar sin parar.
    terminalScrollSensitivity: 3,
    // Copiar al seleccionar, como en las terminales de Linux. Desactivado de
    // fábrica porque en Windows sorprende: la gente selecciona para leer.
    copyOnSelect: false,
    uiDensity: 'comfortable',
    defaultEnvironmentId: '',
    // Gestor de archivos con el que abrir carpetas. Vacío = el que decida el
    // sistema. Solo se rellena cuando el usuario elige uno a mano porque el
    // sistema no supo abrirla (ver FILE_MANAGERS en fileViewers.js).
    fileManagerId: '',
    // Últimas dimensiones medidas de la terminal. No se editan desde Ajustes:
    // las guarda la aplicación para que la primera sesión de la próxima
    // ejecución nazca ya con el tamaño de la ventana, en vez de escribir su
    // banner y su prompt a 80x24 y tener que reflujarlo todo al medir.
    viewportCols: 80,
    viewportRows: 24
});

// Los identificadores válidos los define fileViewers.js; aquí basta con que
// sea un nombre corto y sin sorpresas, porque main.js lo busca en su tabla
// antes de ejecutar nada.
function safeIdentifier(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().slice(0, 40);
    return /^[a-z0-9-]*$/i.test(trimmed) ? trimmed : '';
}

function integerInRange(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function safeEnvironmentId(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().slice(0, 200);
    return /[\u0000-\u001f\u007f]/.test(trimmed) ? '' : trimmed;
}

function numberInRange(value, minimum, maximum, fallback, decimals) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const limited = Math.min(maximum, Math.max(minimum, parsed));
    const factor = 10 ** (decimals || 0);
    return Math.round(limited * factor) / factor;
}

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function safeHexColor(value, fallback) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function sanitizePreferences(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const themeId = oneOf(source.themeId, THEME_PRESETS.map((theme) => theme.id), DEFAULT_PREFERENCES.themeId);
    const theme = THEME_PRESETS.find((candidate) => candidate.id === themeId) || THEME_PRESETS[0];
    return {
        language: oneOf(source.language, LANGUAGES.map((entry) => entry.id), DEFAULT_PREFERENCES.language),
        scriptsHereDepth: integerInRange(source.scriptsHereDepth, 0, 10, DEFAULT_PREFERENCES.scriptsHereDepth),
        autoStartDocker: source.autoStartDocker !== false,
        exclusiveAccordionGroups: source.exclusiveAccordionGroups !== false,
        autoOpenFirstGroup: source.autoOpenFirstGroup === true,
        showSystemBanner: source.showSystemBanner !== false,
        themeId,
        accentColor: safeHexColor(source.accentColor, theme.palette.accent),
        terminalBackground: safeHexColor(source.terminalBackground, theme.palette.terminalBackground),
        terminalForeground: safeHexColor(source.terminalForeground, theme.palette.terminalForeground),
        terminalFontFamily: oneOf(source.terminalFontFamily, FONT_FAMILIES.map((font) => font.id), DEFAULT_PREFERENCES.terminalFontFamily),
        terminalFontSize: integerInRange(source.terminalFontSize, 10, 24, DEFAULT_PREFERENCES.terminalFontSize),
        terminalLineHeight: numberInRange(source.terminalLineHeight, 0.9, 1.8, DEFAULT_PREFERENCES.terminalLineHeight, 2),
        terminalLetterSpacing: numberInRange(source.terminalLetterSpacing, -1, 3, DEFAULT_PREFERENCES.terminalLetterSpacing, 1),
        terminalCursorStyle: oneOf(source.terminalCursorStyle, ['block', 'underline', 'bar'], DEFAULT_PREFERENCES.terminalCursorStyle),
        terminalFontWeight: oneOf(source.terminalFontWeight, ['normal', 'bold'], DEFAULT_PREFERENCES.terminalFontWeight),
        terminalPadding: integerInRange(source.terminalPadding, 4, 24, DEFAULT_PREFERENCES.terminalPadding),
        terminalScrollback: integerInRange(source.terminalScrollback, 1000, 100000, DEFAULT_PREFERENCES.terminalScrollback),
        terminalCursorBlink: source.terminalCursorBlink !== false,
        terminalScrollSensitivity: integerInRange(source.terminalScrollSensitivity, 1, 10, DEFAULT_PREFERENCES.terminalScrollSensitivity),
        copyOnSelect: source.copyOnSelect === true,
        uiDensity: oneOf(source.uiDensity, ['compact', 'comfortable'], DEFAULT_PREFERENCES.uiDensity),
        defaultEnvironmentId: safeEnvironmentId(source.defaultEnvironmentId),
        fileManagerId: safeIdentifier(source.fileManagerId),
        viewportCols: integerInRange(source.viewportCols, 20, 1000, DEFAULT_PREFERENCES.viewportCols),
        viewportRows: integerInRange(source.viewportRows, 5, 500, DEFAULT_PREFERENCES.viewportRows)
    };
}

module.exports = { DEFAULT_PREFERENCES, THEME_PRESETS, FONT_FAMILIES, LANGUAGES, sanitizePreferences };
