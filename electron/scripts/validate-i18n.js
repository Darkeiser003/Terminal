// scripts/validate-i18n.js
// Comprueba que el catálogo de traducciones y el código no se separen.
//
// Es fácil añadir un t('algo.nuevo') y olvidar la traducción, o traducir una
// clave que ya no usa nadie. Ninguna de las dos cosas rompe la aplicación (el
// respaldo es el texto en español), pero las dos dejan la interfaz a medias en
// el idioma que no es el de referencia, y eso no se ve hasta que alguien la
// cambia. Aquí sí se ve.

const fs = require('fs');
const path = require('path');
const { CATALOGS, FALLBACK_LANGUAGE, GROUP_KEYS, VERB_KEYS } = require('../main/i18n');

const root = path.join(__dirname, '..');
const fuentes = [
    path.join(root, 'renderer', 'renderer.js'),
    path.join(root, 'renderer', 'index.html'),
    path.join(root, 'main.js'),
    path.join(root, 'main', 'systemInfo.js'),
    // El texto que imprime el alias `ayuda` también se traduce: es lo primero
    // que lee quien no sabe qué comandos le ha añadido la terminal.
    path.join(root, 'main', 'aliasProfiles.js')
];

// Namespaces reales del catálogo. Filtrarlos evita confundir un acceso a
// propiedad (result.error, repo.stars) con una clave de traducción.
const NAMESPACES = new Set(Object.keys(CATALOGS.en).map((clave) => clave.split('.')[0]));

function clavesUsadas() {
    const encontradas = new Map();
    fuentes.forEach((archivo) => {
        const texto = fs.readFileSync(archivo, 'utf8');
        // t('clave'...), tr('clave'...) y los atributos data-i18n* del HTML.
        const patrones = [
            // t('clave'), translate('clave'), tr('clave') — el traductor ya
            // resuelto — y translate(idioma, 'clave'), la forma con idioma
            // explícito que usa el propio módulo.
            /\b(?:t|tr|translate)\(\s*'([^']+)'/g,
            /\btranslate\(\s*[A-Za-z_$][\w.$]*\s*,\s*'([^']+)'/g,
            /data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g
        ];
        patrones.forEach((patron) => {
            let coincidencia;
            while ((coincidencia = patron.exec(texto)) !== null) {
                const clave = coincidencia[1];
                if (!NAMESPACES.has(clave.split('.')[0])) continue;
                if (!encontradas.has(clave)) encontradas.set(clave, path.basename(archivo));
            }
        });
    });
    return encontradas;
}

// Para decidir si una clave SOBRA no vale el análisis anterior: hay llamadas
// con la clave elegida en un ternario (singular/plural), y ahí el patrón no
// llega. Como una clave es una cadena muy característica, basta con buscarla
// literalmente en las fuentes.
const textoFuentes = fuentes.map((archivo) => fs.readFileSync(archivo, 'utf8')).join('\n');
function apareceEnElCodigo(clave) {
    return textoFuentes.includes("'" + clave + "'")
        || textoFuentes.includes('"' + clave + '"');
}

const usadas = clavesUsadas();
const problemas = [];

// 1. Toda clave usada tiene que estar traducida en todos los idiomas que no
//    sean el de referencia.
Object.keys(CATALOGS)
    .filter((idioma) => idioma !== FALLBACK_LANGUAGE)
    .forEach((idioma) => {
        usadas.forEach((archivo, clave) => {
            if (!CATALOGS[idioma][clave]) {
                problemas.push(`falta "${clave}" en el catálogo ${idioma} (se usa en ${archivo})`);
            }
        });
    });

// 2. Y toda clave traducida tiene que usarse en alguna parte. Dos excepciones
//    legítimas: las de los grupos y verbos, que se referencian desde sus
//    tablas y no desde una llamada a t(), y las de las acciones del panel
//    (`action.<id>.<campo>`), que se buscan por el identificador de cada
//    acción en translateAction.
const clavesDinamicas = new Set([...Object.values(GROUP_KEYS), ...Object.values(VERB_KEYS)]);
// `action.*` se busca por el id de cada acción y `tool.*` por el `labelKey`
// declarado en las tablas de installActions.js: ninguna de las dos aparece
// como literal en el código que se analiza aquí.
const esClaveDeAccion = (clave) => clave.startsWith('action.') || clave.startsWith('tool.');
Object.keys(CATALOGS)
    .filter((idioma) => idioma !== FALLBACK_LANGUAGE)
    .forEach((idioma) => {
        Object.keys(CATALOGS[idioma]).forEach((clave) => {
            if (clavesDinamicas.has(clave) || esClaveDeAccion(clave)) return;
            if (usadas.has(clave) || apareceEnElCodigo(clave)) return;
            problemas.push(`"${clave}" está traducida en ${idioma} pero no la usa nadie`);
        });
    });

// 3. Los parámetros entre llaves tienen que coincidir: una traducción que se
//    deja un {name} fuera muestra un hueco en vez del dato.
function parametros(texto) {
    return new Set((texto.match(/\{(\w+)\}/g) || []).sort());
}
Object.keys(CATALOGS)
    .filter((idioma) => idioma !== FALLBACK_LANGUAGE)
    .forEach((idioma) => {
        Object.keys(CATALOGS[idioma]).forEach((clave) => {
            const referencia = CATALOGS[FALLBACK_LANGUAGE][clave];
            if (!referencia) return;   // el español vive en el código, no aquí
            const esperados = parametros(referencia);
            const recibidos = parametros(CATALOGS[idioma][clave]);
            if (esperados.size !== recibidos.size
                || [...esperados].some((param) => !recibidos.has(param))) {
                problemas.push(`"${clave}" no usa los mismos parámetros en ${idioma}`);
            }
        });
    });

if (problemas.length) {
    console.error('Catálogo de traducciones incoherente:');
    problemas.forEach((problema) => console.error('  - ' + problema));
    process.exit(1);
}

const idiomas = Object.keys(CATALOGS).join(', ');
console.log(`Traducciones válidas: ${usadas.size} claves en uso; idiomas ${idiomas}.`);
