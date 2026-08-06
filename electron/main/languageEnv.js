// main/languageEnv.js
// Entornos de LENGUAJE: además de las shells del sistema, el selector ofrece
// el intérprete interactivo (REPL) de los lenguajes instalados en la máquina.
// Elegir uno abre el REPL real dentro de la pestaña, con su propio pty.
//
// Estos entornos se marcan con `repl: true` porque NO son shells:
//   - aliasProfiles no inyecta alias dentro de ellos (un "doskey" o un
//     "alias" escrito en un intérprete de Python es un error de sintaxis),
//   - el proceso principal enruta a una shell real las acciones que escriben
//     comandos (lanzar un script, instalar una dependencia).
//
// La detección solo mira si el ejecutable existe; no se instala nada ni se
// ejecuta el lenguaje durante el arranque.

const LANGUAGE_DEFS = [
    {
        id: 'python',
        label: 'Python',
        windows: { exe: 'python', args: [] },
        unix: { exe: 'python3', args: [] }
    },
    {
        id: 'node',
        label: 'Node.js',
        windows: { exe: 'node', args: [] },
        unix: { exe: 'node', args: [] }
    },
    {
        id: 'ruby',
        label: 'Ruby',
        // irb es el REPL de Ruby; el binario `ruby` sin argumentos se queda
        // leyendo un script de la entrada estándar, que no es lo que se busca.
        windows: { exe: 'irb', args: [] },
        unix: { exe: 'irb', args: [] }
    },
    {
        id: 'java',
        label: 'Java',
        // jshell viene con el JDK 9+. Un JRE suelto no lo trae.
        windows: { exe: 'jshell', args: [] },
        unix: { exe: 'jshell', args: [] },
        note: 'jshell forma parte del JDK 9 o superior.'
    },
    {
        id: 'php',
        label: 'PHP',
        windows: { exe: 'php', args: ['-a'] },
        unix: { exe: 'php', args: ['-a'] },
        note: 'El modo interactivo de PHP requiere que la compilación incluya readline.'
    },
    {
        id: 'lua',
        label: 'Lua',
        windows: { exe: 'lua', args: [] },
        unix: { exe: 'lua', args: [] }
    },
    {
        id: 'r',
        label: 'R',
        windows: { exe: 'R', args: ['--no-save'] },
        unix: { exe: 'R', args: ['--no-save'] }
    },
    {
        id: 'groovy',
        label: 'Groovy',
        windows: { exe: 'groovysh', args: [] },
        unix: { exe: 'groovysh', args: [] }
    },
    {
        id: 'deno',
        label: 'Deno',
        windows: { exe: 'deno', args: ['repl'] },
        unix: { exe: 'deno', args: ['repl'] }
    },
    {
        id: 'perl',
        label: 'Perl',
        // Perl no trae REPL propio: el modo depurador sobre una expresión
        // vacía es la forma habitual de obtener uno.
        windows: { exe: 'perl', args: ['-de1'] },
        unix: { exe: 'perl', args: ['-de1'] },
        note: 'Perl no incluye un REPL propio: se abre su depurador interactivo.'
    }
];

const LANGUAGE_GROUP = 'Lenguajes · intérprete interactivo';

// `isInstalled` se recibe como parámetro (y no se importa de shellDetect)
// para no crear una dependencia circular entre ambos módulos: shellDetect ya
// conoce los casos especiales, como el alias de Python de la Microsoft Store.
function detectLanguageEnvironments(options) {
    const opts = options || {};
    const platform = opts.platform || process.platform;
    const isInstalled = typeof opts.isInstalled === 'function' ? opts.isInstalled : () => false;
    const resolve = typeof opts.resolvePath === 'function' ? opts.resolvePath : () => null;
    const envs = [];

    LANGUAGE_DEFS.forEach((definition) => {
        const spec = platform === 'win32' ? definition.windows : definition.unix;
        if (!spec || !isInstalled(spec.exe)) return;
        envs.push({
            id: 'lang:' + definition.id,
            label: `${definition.label} · REPL`,
            group: LANGUAGE_GROUP,
            kind: 'repl',
            language: definition.id,
            repl: true,
            transport: 'native',
            exe: resolve(spec.exe) || spec.exe,
            args: (spec.args || []).slice(),
            note: definition.note || null
        });
    });

    return { envs, count: envs.length };
}

module.exports = { detectLanguageEnvironments, LANGUAGE_DEFS, LANGUAGE_GROUP };
