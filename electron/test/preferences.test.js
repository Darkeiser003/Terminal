const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PREFERENCES, THEME_PRESETS, FONT_FAMILIES, sanitizePreferences } = require('../main/preferences');

test('las preferencias tienen acordeones cerrados y exclusivos por defecto', () => {
    const preferences = sanitizePreferences({});
    assert.equal(preferences.autoOpenFirstGroup, false);
    assert.equal(preferences.exclusiveAccordionGroups, true);
    assert.equal(preferences.scriptsHereDepth, 3);
    assert.equal(preferences.showSystemBanner, true);
    assert.equal(preferences.themeId, 'silver');
});

test('limita números y descarta identificadores de entorno peligrosos', () => {
    const preferences = sanitizePreferences({
        scriptsHereDepth: 99,
        terminalFontSize: 2,
        terminalLineHeight: 9,
        terminalLetterSpacing: -20,
        terminalPadding: 99,
        terminalScrollback: 999999,
        accentColor: 'red',
        terminalBackground: '#ABCDEF',
        terminalCursorStyle: 'beam',
        terminalFontFamily: 'Comic Sans',
        uiDensity: 'gigante',
        defaultEnvironmentId: 'wsl:Ubuntu\nmalicioso'
    });
    assert.equal(preferences.scriptsHereDepth, 10);
    assert.equal(preferences.terminalFontSize, 10);
    assert.equal(preferences.terminalLineHeight, 1.8);
    assert.equal(preferences.terminalLetterSpacing, -1);
    assert.equal(preferences.terminalPadding, 24);
    assert.equal(preferences.terminalScrollback, 100000);
    assert.equal(preferences.accentColor, THEME_PRESETS[0].palette.accent);
    assert.equal(preferences.terminalBackground, '#abcdef');
    assert.equal(preferences.terminalCursorStyle, 'beam');
    assert.equal(preferences.terminalFontFamily, FONT_FAMILIES[0].id);
    assert.equal(preferences.uiDensity, DEFAULT_PREFERENCES.uiDensity);
    assert.equal(preferences.defaultEnvironmentId, '');
});

test('acepta los nuevos estilos de cursor compatibles con xterm', () => {
    assert.equal(sanitizePreferences({ terminalCursorStyle: 'beam' }).terminalCursorStyle, 'beam');
    assert.equal(sanitizePreferences({ terminalCursorStyle: 'underline-thick' }).terminalCursorStyle, 'underline-thick');
});

test('cada tema y fuente expuestos producen preferencias válidas', () => {
    THEME_PRESETS.forEach((theme) => {
        const preferences = sanitizePreferences({ themeId: theme.id });
        assert.equal(preferences.themeId, theme.id);
        assert.match(preferences.accentColor, /^#[0-9a-f]{6}$/);
    });
    FONT_FAMILIES.forEach((font) => {
        assert.equal(sanitizePreferences({ terminalFontFamily: font.id }).terminalFontFamily, font.id);
    });
});

test('cada tema trae la paleta completa que el renderer espera', () => {
    // Una paleta incompleta no rompe nada visible al instante: deja una
    // variable CSS sin valor y el color anterior pegado, que es mucho más
    // difícil de diagnosticar que un fallo aquí.
    const required = ['background', 'surface', 'surfaceAlt', 'border', 'text', 'muted',
        'accent', 'accentSoft', 'terminalBackground', 'terminalForeground', 'selection'];
    const ids = new Set();
    THEME_PRESETS.forEach((theme) => {
        assert.ok(theme.id && theme.label, 'cada tema necesita id y etiqueta');
        assert.ok(!ids.has(theme.id), `id de tema duplicado: ${theme.id}`);
        ids.add(theme.id);
        required.forEach((key) => {
            assert.match(theme.palette[key] || '', /^#[0-9a-f]{6}$/i, `${theme.id}.${key} debe ser un color hex`);
        });
    });
    assert.ok(ids.has('contrast'), 'debe haber una paleta de alto contraste');
});

test('todos los temas son oscuros', () => {
    // Un tema claro obliga a revisar cada color que la interfaz da por hecho
    // (bordes de xterm, sombras de los paneles, el degradado de las tarjetas de
    // tema). Se probó y se veía roto, así que el catálogo es oscuro entero y
    // esta prueba impide que se cuele otro claro sin darse cuenta.
    const luminance = (hex) => {
        const value = parseInt(hex.slice(1), 16);
        const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    THEME_PRESETS.forEach((theme) => {
        assert.ok(luminance(theme.palette.background) < 0.3,
            `${theme.id}: el fondo de la interfaz debe ser oscuro`);
        assert.ok(luminance(theme.palette.terminalBackground) < 0.3,
            `${theme.id}: el fondo de la terminal debe ser oscuro`);
        assert.ok(luminance(theme.palette.text) > 0.5,
            `${theme.id}: el texto debe ser claro sobre fondo oscuro`);
    });
});

test('los ajustes de terminal añadidos se validan y tienen valores seguros', () => {
    const defaults = sanitizePreferences({});
    assert.equal(defaults.terminalFontWeight, 'normal');
    assert.equal(defaults.terminalScrollSensitivity, 3);
    // Copiar al seleccionar sorprende en Windows: se entra desactivado.
    assert.equal(defaults.copyOnSelect, false);

    const forzado = sanitizePreferences({
        terminalFontWeight: '900',
        terminalScrollSensitivity: 500,
        copyOnSelect: 'sí'
    });
    assert.equal(forzado.terminalFontWeight, 'normal');
    assert.equal(forzado.terminalScrollSensitivity, 10);
    assert.equal(forzado.copyOnSelect, false);

    const elegido = sanitizePreferences({
        terminalFontWeight: 'bold',
        terminalScrollSensitivity: 1,
        copyOnSelect: true
    });
    assert.equal(elegido.terminalFontWeight, 'bold');
    assert.equal(elegido.terminalScrollSensitivity, 1);
    assert.equal(elegido.copyOnSelect, true);
});
