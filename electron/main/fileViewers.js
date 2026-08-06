// main/fileViewers.js
// Qué programa hace falta para abrir un archivo que el sistema no sabe abrir.
//
// Cuando `shell.openPath` falla (no hay ninguna aplicación asociada a esa
// extensión), la app propone instalar un visor adecuado al tipo de archivo.
// La propuesta NO se ejecuta sola: el renderer pide confirmación y, al
// aceptar, el comando se escribe en la terminal visible como cualquier otra
// acción del panel de dependencias.
//
// Los identificadores devueltos aquí son ids de acciones reales del catálogo
// de installActions.js, de modo que instalar un visor desde el aviso y hacerlo
// desde el panel son exactamente la misma operación.

const VIEWER_CATEGORIES = {
    image: {
        label: 'imágenes',
        extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif', '.heic', '.psd']
    },
    video: {
        label: 'vídeo',
        // `.ts` no aparece aquí a propósito: en una terminal de desarrollo es
        // TypeScript mucho más a menudo que un MPEG transport stream.
        extensions: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.mpg', '.mpeg', '.flv']
    },
    audio: {
        label: 'audio',
        extensions: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.mid', '.midi']
    },
    document: {
        label: 'documentos PDF',
        extensions: ['.pdf', '.epub', '.mobi', '.djvu', '.xps', '.cbz', '.cbr']
    },
    archive: {
        label: 'archivos comprimidos',
        extensions: ['.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.zst', '.iso', '.cab', '.lzh']
    },
    code: {
        label: 'código y texto',
        extensions: [
            '.c', '.h', '.cpp', '.hpp', '.cs', '.java', '.kt', '.swift', '.go', '.rs',
            '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.php', '.rb', '.py', '.lua',
            '.sql', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.env',
            '.md', '.markdown', '.txt', '.log', '.csv', '.json', '.xml', '.diff', '.patch'
        ]
    }
};

// Visor recomendado por categoría y plataforma. `actionId` apunta al catálogo
// de installActions.js; `app` es solo el nombre que se muestra al usuario.
const VIEWERS = {
    image: {
        win32: { actionId: 'viewer-image', app: 'ImageGlass' },
        linux: { actionId: 'viewer-image', app: 'Eye of GNOME' },
        darwin: null
    },
    video: {
        win32: { actionId: 'viewer-media', app: 'VLC' },
        linux: { actionId: 'viewer-media', app: 'VLC' },
        darwin: { actionId: 'viewer-media', app: 'VLC' }
    },
    audio: {
        win32: { actionId: 'viewer-media', app: 'VLC' },
        linux: { actionId: 'viewer-media', app: 'VLC' },
        darwin: { actionId: 'viewer-media', app: 'VLC' }
    },
    document: {
        win32: { actionId: 'viewer-document', app: 'SumatraPDF' },
        linux: { actionId: 'viewer-document', app: 'Evince' },
        darwin: null
    },
    archive: {
        win32: { actionId: 'viewer-archive', app: '7-Zip' },
        linux: { actionId: 'viewer-archive', app: 'p7zip' },
        darwin: { actionId: 'viewer-archive', app: 'p7zip' }
    },
    code: {
        win32: { actionId: 'viewer-code', app: 'Visual Studio Code' },
        linux: { actionId: 'viewer-code', app: 'Visual Studio Code' },
        darwin: { actionId: 'viewer-code', app: 'Visual Studio Code' }
    }
};

// ---- Gestores de archivos (abrir una CARPETA) ----
//
// Abrir una carpeta no se parece a abrir un archivo: no hay extensión que
// mirar y no existe "el visor de carpetas". Windows y macOS siempre traen el
// suyo (Explorador, Finder) y `shell.openPath` da con él sin más. En Linux
// depende del escritorio: en una instalación mínima, en un servidor o en un
// escritorio muy recortado puede no haber ninguno registrado, y ahí xdg-open
// falla sin decir por qué. En ese caso la app pregunta con cuál abrirla de
// entre los que haya, y si no hay ninguno ofrece instalarlo.
//
// `cmd` es el ejecutable que se lanza con la carpeta como único argumento:
// todos estos gestores aceptan esa forma.
const FILE_MANAGERS = {
    win32: [
        { id: 'explorer', cmd: 'explorer', app: 'Explorador de Windows' }
    ],
    darwin: [
        { id: 'finder', cmd: 'open', app: 'Finder' }
    ],
    linux: [
        { id: 'nautilus', cmd: 'nautilus', app: 'Archivos (GNOME)', actionId: 'viewer-files-nautilus' },
        { id: 'dolphin', cmd: 'dolphin', app: 'Dolphin (KDE)', actionId: 'viewer-files-dolphin' },
        { id: 'thunar', cmd: 'thunar', app: 'Thunar (Xfce)', actionId: 'viewer-files-thunar' },
        // Estos tres se reconocen si ya están, pero no se ofrecen para
        // instalar: son los gestores propios de un escritorio concreto y
        // llenar el panel con seis instaladores para elegir uno no ayuda.
        { id: 'nemo', cmd: 'nemo', app: 'Nemo (Cinnamon)' },
        { id: 'caja', cmd: 'caja', app: 'Caja (MATE)' },
        { id: 'pcmanfm', cmd: 'pcmanfm', app: 'PCManFM' }
    ]
};

function platformKeyFor(platform) {
    return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
}

function fileManagersFor(platform) {
    return FILE_MANAGERS[platformKeyFor(platform)] || [];
}

// Separa los gestores que se pueden usar ya de los que habría que instalar.
// `isInstalled` se inyecta (which/isToolInstalled) para poder probar esto sin
// depender de lo que tenga la máquina donde corren las pruebas.
function fileManagerChoices(platform, isInstalled) {
    const all = fileManagersFor(platform);
    const installed = all.filter((manager) => isInstalled(manager.cmd));
    return {
        installed: installed.map(({ id, app, cmd }) => ({ id, app, cmd })),
        installable: all
            .filter((manager) => manager.actionId && !installed.includes(manager))
            .map(({ id, app, actionId }) => ({ id, app, actionId }))
    };
}

function fileManagerById(platform, id) {
    return fileManagersFor(platform).find((manager) => manager.id === id) || null;
}

// Cada escritorio trae su propio gestor, y es el que el usuario reconoce como
// "el explorador de archivos" de su sistema. Con varios instalados —algo
// normal: instalar una aplicación KDE arrastra Dolphin a un GNOME— elegir por
// escritorio acierta mucho más que quedarse con el primero de la lista.
//
// `$XDG_CURRENT_DESKTOP` puede traer varios separados por dos puntos
// ("ubuntu:GNOME"), así que se busca por contenido y no por igualdad.
const DESKTOP_MANAGERS = [
    { match: /KDE|PLASMA/, id: 'dolphin' },
    { match: /GNOME|UNITY|PANTHEON/, id: 'nautilus' },
    { match: /XFCE/, id: 'thunar' },
    { match: /CINNAMON|X-CINNAMON/, id: 'nemo' },
    { match: /MATE/, id: 'caja' },
    { match: /LXQT|LXDE/, id: 'pcmanfm' }
];

function fileManagerForDesktop(desktop, isInstalled) {
    const nombre = String(desktop || '').toUpperCase();
    if (!nombre) return null;
    const entrada = DESKTOP_MANAGERS.find((candidato) => candidato.match.test(nombre));
    if (!entrada) return null;
    const manager = fileManagerById('linux', entrada.id);
    return manager && isInstalled(manager.cmd) ? manager : null;
}

function viewerCategoryFor(extension) {
    const ext = String(extension || '').toLowerCase();
    if (!ext) return null;
    const found = Object.keys(VIEWER_CATEGORIES)
        .find((category) => VIEWER_CATEGORIES[category].extensions.includes(ext));
    return found || null;
}

// Sugerencia para un archivo concreto, o null si no hay ninguna que ofrecer
// (extensión desconocida, o plataforma donde el sistema ya trae visor: macOS
// abre imágenes y PDF con Vista Previa, así que ahí no se propone nada).
function suggestViewer(extension, platform) {
    const category = viewerCategoryFor(extension);
    if (!category) return null;
    const platformKey = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    const viewer = VIEWERS[category] && VIEWERS[category][platformKey];
    if (!viewer) return null;
    return {
        category,
        categoryLabel: VIEWER_CATEGORIES[category].label,
        app: viewer.app,
        actionId: viewer.actionId
    };
}

module.exports = {
    suggestViewer, viewerCategoryFor, VIEWER_CATEGORIES, VIEWERS,
    fileManagersFor, fileManagerChoices, fileManagerById, fileManagerForDesktop, FILE_MANAGERS
};
