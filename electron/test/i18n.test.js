const test = require('node:test');
const assert = require('node:assert/strict');
const {
    LANGUAGES, CATALOGS, FALLBACK_LANGUAGE,
    resolveLanguage, translate, createTranslator, catalogFor,
    groupKeyFor, translateAction
} = require('../main/i18n');
const { sanitizePreferences } = require('../main/preferences');
const { getInstallActions } = require('../main/installActions');
const { buildBanner } = require('../main/systemInfo');

test('el idioma automático sale del sistema y nunca deja la interfaz sin catálogo', () => {
    assert.equal(resolveLanguage('auto', 'en-GB'), 'en');
    assert.equal(resolveLanguage('auto', 'es-ES'), 'es');
    assert.equal(resolveLanguage('auto', 'en_US'), 'en');
    // Un idioma que no está traducido cae al de referencia, no a una pantalla
    // llena de claves.
    assert.equal(resolveLanguage('auto', 'ja-JP'), FALLBACK_LANGUAGE);
    assert.equal(resolveLanguage('auto', ''), FALLBACK_LANGUAGE);
    assert.equal(resolveLanguage('auto', undefined), FALLBACK_LANGUAGE);
    // La preferencia explícita manda sobre el sistema.
    assert.equal(resolveLanguage('en', 'es-ES'), 'en');
    assert.equal(resolveLanguage('es', 'en-US'), 'es');
    // Y una preferencia inventada tampoco rompe nada.
    assert.equal(resolveLanguage('klingon', 'en-US'), FALLBACK_LANGUAGE);
});

test('solo se ofrecen idiomas que existen, y la preferencia se valida', () => {
    LANGUAGES.forEach((idioma) => {
        if (idioma.id === 'auto') return;
        assert.ok(CATALOGS[idioma.id], `${idioma.id} figura en Ajustes pero no tiene catálogo`);
    });
    assert.equal(sanitizePreferences({}).language, 'auto');
    assert.equal(sanitizePreferences({ language: 'en' }).language, 'en');
    assert.equal(sanitizePreferences({ language: 'inventado' }).language, 'auto');
    assert.equal(sanitizePreferences({ language: 42 }).language, 'auto');
});

test('una clave sin traducir se ve en español, no como clave', () => {
    const t = createTranslator('en');
    assert.equal(t('clave.que.no.existe', null, 'Texto de respaldo'), 'Texto de respaldo');
    // Sin respaldo tampoco se inventa nada raro: se devuelve la clave, que es
    // lo único que hay, pero eso solo puede pasar por un error de programación
    // y por eso lo vigila scripts/validate-i18n.js.
    assert.equal(t('clave.que.no.existe'), 'clave.que.no.existe');
    assert.equal(t('toolbar.settings'), 'Settings');
});

test('los parámetros se sustituyen y los que sobran no ensucian el texto', () => {
    assert.equal(
        translate('en', 'tabs.exited', { code: 137 }),
        '[Process finished with code 137]'
    );
    // Un parámetro que no se pasa deja el hueco visible en vez de romper: es
    // preferible verlo a que aparezca "undefined".
    assert.equal(translate('en', 'tabs.exited', {}), '[Process finished with code {code}]');
    assert.equal(translate('en', 'explorer.copied', { name: 'notas.txt' }), 'Copied: notas.txt');
});

test('el renderer recibe un solo catálogo, ya resuelto', () => {
    const paquete = catalogFor('en');
    assert.equal(paquete.language, 'en');
    assert.equal(paquete.strings['toolbar.logs'], 'Logs');
    // Copia, no la tabla viva: el renderer no puede modificar el catálogo del
    // proceso principal.
    paquete.strings['toolbar.logs'] = 'roto';
    assert.equal(CATALOGS.en['toolbar.logs'], 'Logs');
    // Un idioma desconocido no deja al renderer sin nada.
    assert.equal(catalogFor('klingon').language, FALLBACK_LANGUAGE);
});

test('el banner se traduce sin tocar los datos del sistema', () => {
    // Los rótulos van pegados a una secuencia de color, así que se buscan tal
    // cual y no con límites de palabra.
    const enIngles = buildBanner('bash', 'LTerminal', createTranslator('en'));
    ['User', 'System', 'Kernel', 'Environment', 'Memory', 'Uptime', 'cores'].forEach((rotulo) => {
        assert.ok(enIngles.includes(rotulo), `falta "${rotulo}" en el banner en inglés`);
    });
    assert.ok(!enIngles.includes('Usuario'));

    // Sin traductor sigue saliendo en el idioma de referencia.
    const enEspanol = buildBanner('bash', 'LTerminal');
    ['Usuario', 'Sistema', 'Entorno', 'Memoria', 'núcleos'].forEach((rotulo) => {
        assert.ok(enEspanol.includes(rotulo), `falta "${rotulo}" en el banner en español`);
    });

    // Y los datos del sistema son los mismos en los dos: lo que cambia es el
    // rótulo, no lo que se mide.
    assert.ok(enIngles.includes(require('os').hostname()));
    assert.ok(enEspanol.includes(require('os').hostname()));
});

test('las acciones se traducen sin perder id, comando ni orden', () => {
    const opciones = { platform: 'linux', pkgManager: 'pacman', wsl: null };
    const original = getInstallActions(opciones);
    const traducidas = getInstallActions({ ...opciones, t: createTranslator('en') })
        .map((accion) => translateAction('en', accion));

    assert.equal(traducidas.length, original.length);
    traducidas.forEach((accion, indice) => {
        assert.equal(accion.id, original[indice].id, 'el orden y los ids no pueden cambiar');
        // Traducir un comando lo rompería: es lo único que de verdad se
        // ejecuta, y va literal a la terminal.
        assert.equal(accion.command, original[indice].command, accion.id);
        assert.equal(accion.group, original[indice].group, accion.id);
    });

    const porId = new Map(traducidas.map((accion) => [accion.id, accion]));
    assert.equal(porId.get('pkg-node').label, 'Install Node.js + npm (pacman)');
    assert.equal(porId.get('pkg-node').shortLabel, 'Install with pacman');
    assert.equal(porId.get('pkg-bash-update').verb, 'Update');
});

test('ninguna etiqueta llega a la interfaz con un hueco sin rellenar', () => {
    const combinaciones = [
        { platform: 'linux', pkgManager: 'pacman' },
        { platform: 'linux', pkgManager: 'apt', hasSnap: true },
        { platform: 'linux', pkgManager: 'pacman', aurHelper: 'paru' },
        { platform: 'darwin' },
        {
            platform: 'win32',
            wsl: { available: true, installed: [{ name: 'Ubuntu', shell: 'bash', shells: ['bash'], tools: [], packageManager: 'apt' }], online: [] }
        }
    ];
    ['es', 'en'].forEach((idioma) => {
        combinaciones.forEach((opciones) => {
            getInstallActions({ ...opciones, wsl: opciones.wsl || null, t: createTranslator(idioma) })
                .map((accion) => translateAction(idioma, accion))
                .forEach((accion) => {
                    ['label', 'shortLabel'].forEach((campo) => {
                        if (!accion[campo]) return;
                        assert.doesNotMatch(accion[campo], /\{\w+\}/,
                            `${idioma}/${opciones.platform}: ${accion.id}.${campo} deja un hueco sin rellenar`);
                        assert.doesNotMatch(accion[campo], /^(action|tool)\./,
                            `${idioma}/${opciones.platform}: ${accion.id}.${campo} muestra la clave en vez del texto`);
                    });
                });
        });
    });
});

test('los apartados del panel y del selector de entorno tienen clave', () => {
    ['Shells', 'Docker', 'Compatibilidad Windows', 'Visores de archivos'].forEach((grupo) => {
        assert.ok(groupKeyFor(grupo), `${grupo} sin clave de traducción`);
    });
    ['Shells del sistema', 'Android (ADB)', 'Lenguajes · intérprete interactivo'].forEach((grupo) => {
        assert.ok(groupKeyFor(grupo), `${grupo} sin clave de traducción`);
    });
    assert.equal(groupKeyFor('Un grupo que no existe'), null);

    // Y todo apartado que produzca el catálogo tiene que estar cubierto: si se
    // añade uno nuevo y se olvida su clave, el panel lo enseñaría en español
    // dentro de una interfaz en inglés.
    const grupos = new Set(getInstallActions({ platform: 'linux', pkgManager: 'apt', wsl: null })
        .map((accion) => accion.group));
    grupos.forEach((grupo) => {
        assert.ok(groupKeyFor(grupo), `el apartado "${grupo}" no tiene traducción`);
    });
});
