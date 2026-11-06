// Catálogo único de las validaciones E2E estandarizadas de WTerminal.
//
// Cada suite agrupa escenarios de `tests/e2e/smoke.mjs` (seleccionados por
// sus variables E2E_*) con un tiempo límite propio. Lo usan
// `scripts/run-e2e-suite.mjs`, el build de Windows (`-FullTests`,
// `-ReleaseValidation`) y la documentación: añadir aquí un escenario lo
// incorpora a todos ellos a la vez.

const MINUTE = 60_000;

const NEW_TAB_ECHO = {
    E2E_NEW_TAB_ECHO_ONLY: '1',
    E2E_NEW_TAB_ECHO_ROTATE: '1',
    E2E_NEW_TAB_ECHO_SWITCH: '1',
};

export const SUITES = {
    focused: {
        title: 'Regresiones enfocadas',
        description: 'Escenarios que reproducen fallos ya corregidos: eco despegado, filas tras redimensionar, entrada larga y scroll horizontal, estilos ANSI, cursor, selección, Ajustes, PATH y cachés.',
        scenarios: [
            { id: 'settings-footer', title: 'Pie de Ajustes sin huecos a 800x600', env: { E2E_SETTINGS_FOOTER_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'toolchain-store', title: 'Entornos y descargas: lista, variable en la terminal y vaciado', env: { E2E_TOOLCHAIN_STORE_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'path-integration', title: 'Invocar desde el PATH sin alterar el registro del usuario', env: { E2E_PATH_INTEGRATION_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'resize-type', title: 'Escribir justo tras redimensionar (visible y oculta)', env: { E2E_RESIZE_TYPE_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'queued-input', title: 'Entrada en cola antes del prompt y filas tras redimensionar', env: { E2E_QUEUED_INPUT_RESIZE_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'new-tab-echo', title: 'Primera orden en pestañas nacidas en casillas diminutas', env: NEW_TAB_ECHO, timeoutMs: 15 * MINUTE, repeat: 3 },
            { id: 'new-tab-echo-forced-race', title: 'Primera orden con geometría heredada obsoleta y banner tardío (carrera forzada)', env: { ...NEW_TAB_ECHO, E2E_NEW_TAB_ECHO_FORCED_RACE: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'tiny-grow', title: 'Casilla de 1-2 filas que crece tras desplazar el historial', env: { E2E_TINY_GROW_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'input-follow', title: 'Entrada larga: el cursor sigue a la vista (tecleo, scroll manual, rueda, Inicio/Fin, ventana, >1024 columnas, Intro)', env: { E2E_INPUT_FOLLOW_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'long-input', title: 'Entrada larga con comillas: integridad y reserva horizontal', env: { E2E_LONG_INPUT_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'scrollback-output', title: 'Leer el historial mientras llega salida: la vista no baja sola, ni al cambiar de foco o de pestaña, y teclear vuelve al final', env: { E2E_SCROLLBACK_OUTPUT_ONLY: '1' }, timeoutMs: 8 * MINUTE },
            { id: 'unsplit', title: 'Separar pestañas divididas: botón y :panes 1 vuelven a una sola vista sin cerrar ni abrir pestañas, el menú de la pestaña saca una sola y la vuelve a poner, y aviso mientras arranca WSL', env: { E2E_UNSPLIT_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'horizontal', title: 'Integridad horizontal y reflujo de órdenes largas', env: { E2E_HORIZONTAL_ONLY: '1' }, timeoutMs: 20 * MINUTE },
            { id: 'ansi-styles', title: 'Colores ANSI, negrita, subrayado y cursiva (hojas dinámicas de xterm bajo la CSP)', env: { E2E_ANSI_STYLES_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'cursor', title: 'Parpadeo del cursor enfocado y desenfocado', env: { E2E_CURSOR_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'mouse-selection', title: 'Selección de texto con arrastre real del ratón', env: { E2E_MOUSE_SELECTION_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'unicode-widths', title: 'Anchos de emoji y CJK alineados con ConPTY al editar una línea', env: { E2E_UNICODE_WIDTHS_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'inline-images', title: 'Imágenes Sixel e iTerm2: paso por ConPTY, pintado y eco alineado después', env: { E2E_INLINE_IMAGES_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'shell-assist', title: 'Sugerencia del historial con el color elegido en Ajustes en PowerShell 7, Windows PowerShell, cmd (Clink) y bash de WSL (ble.sh)', env: { E2E_SHELL_ASSIST_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'ai-environments', title: 'Asistentes de IA y modelos locales simulados: selector, Claude Code de la app de escritorio, pestaña, Dependencias y acción de cmd en una sola línea', env: { E2E_AI_ENVIRONMENTS_ONLY: '1' }, timeoutMs: 12 * MINUTE },
            { id: 'ai-tui', title: 'IA de terminal a pantalla completa (simulador): ancho visible en su pestaña y al encoger la ventana, desde cmd en pantalla alternativa y en línea, sin parpadeo, sin bloqueo y la shell sigue bien al salir', env: { E2E_AI_TUI_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'ai-real', title: 'IA de terminal reales instaladas (Claude Code, Gemini, Codex, OpenCode, Qwen, Amp) sin iniciar sesión: su primera pantalla al ancho visible, sin barra ni parpadeo, y claude tecleado en cmd con la shell intacta al salir', env: { E2E_AI_REAL_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'appearance', title: 'Temas sobre la base neutra, recolorear todo, tema propio, paleta ANSI y Biblioteca abierta al marcar', env: { E2E_APPEARANCE_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'terminal-links', title: 'Enlaces: Ctrl+clic con confirmación, OSC 8, file:// sin ejecutar, rechazos del backend y desactivación (sin abrir el navegador)', env: { E2E_TERMINAL_LINKS_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'command-palette', title: 'Paleta de comandos: Ctrl+Shift+P, flechas y Escape, filtrado, Ajustes, comandos `:` con eco pegado al prompt, aviso con texto sin enviar, limpiar y nueva pestaña', env: { E2E_COMMAND_PALETTE_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'command-marks', title: 'Marcas de orden OSC 133 en cmd, PowerShell y Git Bash: fin de orden, código de salida, marca de fallo, Intro vacío, eco pegado al prompt, copiar la salida, saltos con el teclado y aviso de orden larga', env: { E2E_COMMAND_MARKS_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'tab-tools', title: 'Pestañas y salida: renombrar con doble clic y paleta, Escape, nombre vacío, el nombre sobrevive al cambio de shell, color desde el menú de la pestaña, guardar el historial en un archivo y buscar una orden escrita para volver a escribirla sin ejecutarla', env: { E2E_TAB_TOOLS_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'context-menu-edit', title: 'Menú contextual: cortar y Supr sobre una parte interior de lo escrito (cmd, PowerShell, Git Bash), portapapeles, cursor de la shell donde estaba la selección y «Buscar» con la selección', env: { E2E_CONTEXT_MENU_EDIT_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'github-account', title: 'Mi GitHub con un gh simulado: sin sesión, gh auth login en una pestaña, cuenta y repositorios, crear, visibilidad, archivar y desarchivar, renombrar, borrar escribiendo el nombre y pidiendo delete_repo, y cerrar sesión', env: { E2E_GITHUB_ACCOUNT_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'settings-search', title: 'Ajustes: índice de apartados, búsqueda en todas las secciones (sin tildes), aviso sin coincidencias, Esc que vacía sin cerrar y explicación de cada fila al pasar el ratón', env: { E2E_SETTINGS_SEARCH_ONLY: '1' }, timeoutMs: 5 * MINUTE },
            { id: 'banner-image', title: 'Imagen a la izquierda del banner: logo de fábrica encima del margen, eco alineado, imagen propia validada, archivo ilegible con aviso, 12 columnas, apagada y restaurada', env: { E2E_BANNER_IMAGE_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'import-suggestion', title: 'Importar repositorios: sugerencia al entrar con cd, importar sin mover, estado de Git del importado, quitar de la lista, no volver a sugerir y apagarla en Ajustes', env: { E2E_IMPORT_SUGGESTION_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'ui-scale', title: 'Tamaño de la interfaz al 80, 100, 150 y 200 %: márgenes, nada fuera de la ventana, la terminal sin escalar, atajos y valor guardado', env: { E2E_UI_SCALE_ONLY: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'low-power', title: 'Modo de bajo consumo: sugerencia en un equipo de 2 hilos (simulado), activar, reflejo en Ajustes y apagar', env: { E2E_LOW_POWER_ONLY: '1' }, timeoutMs: 5 * MINUTE },
            { id: 'fastfetch-matrix', title: 'Banner y fastfetch en cmd, PowerShell y Git Bash: al abrir, tras cls y tras redimensionar, con y sin imagen, sin líneas cortadas', env: { E2E_FASTFETCH_MATRIX_ONLY: '1' }, timeoutMs: 20 * MINUTE },
            { id: 'visual-tour', title: 'Recorrido visual: capturas de Ajustes, Proyectos, Biblioteca y Dependencias, y márgenes mínimos en ambas densidades', env: { E2E_VISUAL_TOUR_ONLY: '1' }, timeoutMs: 15 * MINUTE },
            { id: 'admin-permissions', title: 'Permisos de administrador: sección igual al backend, arranque elevado apagado y persistente, NSudo deshabilitado con motivo o a través de gsudo (simulado), sin RUNASADMIN y sin pedir nunca el UAC', env: { E2E_WINDOWS_ADMIN_ONLY: '1' }, timeoutMs: 10 * MINUTE },
        ],
    },
    full: {
        title: 'Recorrido completo',
        description: 'El E2E completo: ventana, shells y REPL, paneles, menús, ajustes, idiomas, dependencias y redimensionado.',
        scenarios: [
            { id: 'full', title: 'Recorrido completo', env: {}, timeoutMs: 40 * MINUTE },
        ],
    },
    video: {
        title: 'Recorrido completo con vídeo',
        description: 'El mismo recorrido completo grabando vídeo para revisión visual.',
        scenarios: [
            { id: 'full-video', title: 'Recorrido completo con vídeo', env: { E2E_CAPTURE_VIDEO: '1' }, timeoutMs: 45 * MINUTE },
        ],
    },
    downloads: {
        title: 'Descargas reales',
        description: 'pip, npm, Deno, Bun y Go descargan desde la terminal a la carpeta propia y «Vaciar cachés» lo borra (necesita red).',
        network: true,
        scenarios: [
            { id: 'toolchain-downloads', title: 'Descargas reales en la carpeta de cachés', env: { E2E_TOOLCHAIN_STORE_ONLY: '1', E2E_TOOLCHAIN_STORE_DOWNLOAD: '1' }, timeoutMs: 25 * MINUTE },
        ],
    },
    'dependency-audit': {
        title: 'Auditoría del catálogo de dependencias',
        description: 'Recorre todas las secciones, grupos y acciones sin instalar nada, con capturas y vídeo.',
        scenarios: [
            {
                id: 'dependency-audit',
                title: 'Auditoría completa del catálogo',
                env: {
                    E2E_DEPENDENCY_AUDIT_ONLY: '1',
                    E2E_CAPTURE_SCREENSHOTS: '1',
                    E2E_CAPTURE_VIDEO: '1',
                    E2E_FULL_VISUAL_AUDIT: '1',
                    E2E_DEPENDENCY_CAPTURE_EACH_ACTION: '1',
                    E2E_VIDEO_FPS: '15',
                    E2E_VIDEO_NATIVE_SEGMENTS: '1',
                    E2E_DEPENDENCY_TIMEOUT_MS: '900000',
                },
                // La codificación del vídeo va al final y también cuenta: en la
                // build 35 el límite de 75 min cortó una auditoría ya aprobada.
                timeoutMs: 90 * MINUTE,
                quick: {
                    env: {
                        E2E_DEPENDENCY_FIRST_PASS_COUNT_ONLY: '1',
                        E2E_VIDEO_FPS: '8',
                        E2E_VIDEO_NATIVE_SEGMENTS: '0',
                    },
                    timeoutMs: 50 * MINUTE,
                },
            },
        ],
    },
    // Modo reducido: el recorrido completo se hace una vez, sobre la carpeta
    // desempaquetada. El portable y lo instalado llevan los mismos archivos (el
    // build y el instalador lo comprueban por hash): a ellos solo se les prueba
    // lo que cambia, que es arrancar desde su sitio, abrir shells y paneles e
    // invocarlos desde el PATH. Cada forma de distribución deja su vídeo.
    distribution: {
        title: 'Comprobación de la forma de distribución',
        description: 'Prueba corta del portable o de lo instalado: shells, un REPL, paneles y PATH, con vídeo.',
        scenarios: [
            {
                id: 'distribution-shells',
                title: 'Shells y un REPL',
                env: {
                    E2E_SHELL_MATRIX_ONLY: '1',
                    E2E_SHELL_MATRIX_IDS: 'powershell,pwsh,gitbash,wsl:Ubuntu,lang:python',
                    E2E_SHELL_MATRIX_KNOWN_ONLY: '1',
                    E2E_CAPTURE_VIDEO: '1',
                },
                timeoutMs: 10 * MINUTE,
            },
            { id: 'distribution-panels', title: 'Paneles y márgenes', env: { E2E_VISUAL_TOUR_ONLY: '1', E2E_CAPTURE_VIDEO: '1' }, timeoutMs: 10 * MINUTE },
            { id: 'distribution-path', title: 'Invocar desde el PATH', env: { E2E_PATH_INTEGRATION_ONLY: '1' }, timeoutMs: 10 * MINUTE },
        ],
    },
    installer: {
        title: 'Instalador NSIS',
        description: 'Instala (un solo UAC), verifica archivos, registro y accesos directos, ejecuta el recorrido completo sobre lo instalado y desinstala comprobando que no queda nada.',
        machineChange: true,
        scenarios: [],
    },
};

/** Suites que componen cada nivel de validación del build. */
export const VALIDATION_LEVELS = {
    // -FullTests: el recorrido completo ya lo ejecuta el build sobre el
    // ejecutable y el portable; aquí se añaden las regresiones enfocadas.
    full: ['focused'],
    // -ReleaseValidation: todo lo necesario para dar una release por buena.
    release: ['focused', 'video', 'downloads', 'dependency-audit', 'installer'],
    // -QuickValidation: lo mismo sin repetir. La carpeta desempaquetada graba el
    // único recorrido completo (por eso no hay suite `video`), el portable y el
    // instalador pasan `distribution` y cada escenario usa su bloque `quick`.
    quick: ['focused', 'downloads', 'dependency-audit', 'installer'],
};

/** Expande los escenarios (con sus repeticiones) de las suites pedidas. Con
 *  `quick` cada escenario aplica su bloque `quick`, si lo tiene. */
export function planSuites(names, { quick = false } = {}) {
    const plan = [];
    for (const name of names) {
        const suite = SUITES[name];
        if (!suite) throw new Error(`Suite desconocida: ${name}. Disponibles: ${Object.keys(SUITES).join(', ')}`);
        for (const scenario of suite.scenarios) {
            const repeat = Math.max(1, scenario.repeat ?? 1);
            for (let index = 1; index <= repeat; index += 1) {
                plan.push({
                    suite: name,
                    id: repeat > 1 ? `${scenario.id}-${index}` : scenario.id,
                    scenario: scenario.id,
                    title: repeat > 1 ? `${scenario.title} (${index}/${repeat})` : scenario.title,
                    env: { ...scenario.env, ...(quick ? scenario.quick?.env : undefined) },
                    timeoutMs: (quick ? scenario.quick?.timeoutMs : undefined) ?? scenario.timeoutMs,
                });
            }
        }
    }
    return plan;
}
