// preload.js - Puente seguro entre el renderer (sandboxed) y el proceso principal.
// La mayoría de canales llevan un tabId como primer argumento: cada pestaña
// tiene su propio pty en main.js, y el proceso principal necesita saber a
// cuál se refiere cada llamada (todas las pestañas de una ventana comparten
// el mismo renderer/webContents).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminalAPI', {
    // Señal de integración: solo se emite cuando el JavaScript del renderer
    // terminó de construir la UI y enlazarla con las pestañas reales.
    signalRendererReady: () => ipcRenderer.send('app:renderer-ready'),

    // ---- Pestañas ----
    listTabs: () => ipcRenderer.invoke('tabs:list'),
    createTab: (envId) => ipcRenderer.invoke('tabs:create', envId),
    closeTab: (tabId) => ipcRenderer.send('tabs:close', tabId),
    activateTab: (tabId) => ipcRenderer.send('tabs:activate', tabId),
    // Avisa a main.js de que ya existe un xterm para esta pestaña, para que
    // entregue la salida que el pty produjo antes de que estuviera listo.
    markTabReady: (tabId) => ipcRenderer.send('tabs:ready', tabId),
    // Confirma que una pestaña realmente se cerró en main.js (matar el pty
    // no distingue por sí solo "el usuario la cerró" de "el proceso terminó
    // solo"), con el id de la pestaña que debería pasar a estar activa.
    onTabClosed: (callback) => {
        const listener = (_event, tabId, newActiveTabId) => callback(tabId, newActiveTabId);
        ipcRenderer.on('tab-closed', listener);
        return () => ipcRenderer.removeListener('tab-closed', listener);
    },

    // ---- pty de una pestaña concreta ----
    onData: (callback) => {
        const listener = (_event, tabId, data) => callback(tabId, data);
        ipcRenderer.on('pty-data', listener);
        return () => ipcRenderer.removeListener('pty-data', listener);
    },
    onExit: (callback) => {
        const listener = (_event, tabId, code) => callback(tabId, code);
        ipcRenderer.on('pty-exit', listener);
        return () => ipcRenderer.removeListener('pty-exit', listener);
    },
    // La shell acaba de ejecutar clear/cls: hay que vaciar de verdad la
    // pestaña (pantalla + historial), algo que las secuencias que emite
    // ConPTY no consiguen por sí solas.
    onClear: (callback) => {
        const listener = (_event, tabId) => callback(tabId);
        ipcRenderer.on('pty-clear', listener);
        return () => ipcRenderer.removeListener('pty-clear', listener);
    },
    sendInput: (tabId, data) => ipcRenderer.send('pty-input', tabId, data),
    resize: (tabId, cols, rows) => ipcRenderer.send('pty-resize', tabId, cols, rows),

    // Entornos (shells): cmd, PowerShell, WSL, bash, zsh, fish, sh...
    listEnvironments: (tabId) => ipcRenderer.invoke('env:list', tabId),
    refreshEnvironments: (tabId) => ipcRenderer.invoke('env:refresh', tabId),
    switchEnvironment: (tabId, envId) => ipcRenderer.invoke('env:switch', tabId, envId),
    onEnvironmentChanged: (callback) => {
        const listener = (_event, tabId, info) => callback(tabId, info);
        ipcRenderer.on('env-changed', listener);
        return () => ipcRenderer.removeListener('env-changed', listener);
    },
    // La lista de entornos puede crecer sola después del arranque (p. ej.
    // cuando Docker termina de arrancar y aparecen sus imágenes/contenedores).
    onEnvironmentsUpdated: (callback) => {
        const listener = (_event, envs) => callback(envs);
        ipcRenderer.on('envs-updated', listener);
        return () => ipcRenderer.removeListener('envs-updated', listener);
    },

    // Entorno y dependencias adicionales (WSL, winget, brew, apt, etc.)
    listInstallActions: () => ipcRenderer.invoke('install:list'),
    runInstallAction: (tabId, actionId) => ipcRenderer.invoke('install:run', tabId, actionId),

    // Preferencias persistentes y validadas por main.js.
    getPreferences: () => ipcRenderer.invoke('settings:get'),
    savePreferences: (preferences) => ipcRenderer.invoke('settings:save', preferences),
    resetPreferences: () => ipcRenderer.invoke('settings:reset'),

    // Se dispara cuando la shell activa responde "comando no encontrado"
    // para una herramienta conocida (docker, git, node, python...), para
    // poder sugerir instalarla desde la propia terminal.
    onCommandNotFound: (callback) => {
        const listener = (_event, tabId, suggestion) => callback(tabId, suggestion);
        ipcRenderer.on('command-not-found', listener);
        return () => ipcRenderer.removeListener('command-not-found', listener);
    },

    // Proyectos GitHub públicos. La red, validación de URLs y comandos git
    // viven en main.js; el renderer solo recibe datos reducidos.
    getProjectsState: () => ipcRenderer.invoke('projects:state'),
    lookupGithub: (target) => ipcRenderer.invoke('projects:lookup', target),
    pinGithub: (kind, value, pinned) => ipcRenderer.invoke('projects:pin', { kind, value, pinned }),
    chooseProjectsFolder: () => ipcRenderer.invoke('projects:chooseFolder'),
    runGithubProject: (tabId, fullName) => ipcRenderer.invoke('projects:run', tabId, fullName),
    // Releases: consultar la última publicada y descargar uno de sus adjuntos.
    // El renderer manda el nombre del archivo, no su URL: la descarga solo
    // acepta adjuntos de la release que main.js acaba de devolver.
    getLatestRelease: (fullName) => ipcRenderer.invoke('projects:release', fullName),
    downloadRelease: (tabId, fullName, assetName) =>
        ipcRenderer.invoke('projects:downloadRelease', tabId, fullName, assetName),
    openGithub: (target) => ipcRenderer.invoke('projects:openGithub', target),

    // Lanzador rápido de scripts: busca .ps1/.bat/.cmd/.sh/.py/.js/.vbs en
    // la carpeta de scripts (y utilidades VBS de WinSlim si existen) y arma
    // el comando correcto (bypass de PowerShell, chmod +x, admin) para
    // lanzarlos en el entorno de la pestaña activa.
    listScripts: (categories) => ipcRenderer.invoke('scripts:list', categories),
    listScriptsHere: (tabId, categories, depth) => ipcRenderer.invoke('scripts:listHere', tabId, categories, depth),
    chooseScriptsFolder: (categories) => ipcRenderer.invoke('scripts:chooseFolder', categories),
    chooseHereFolder: (tabId, categories, depth) => ipcRenderer.invoke('scripts:chooseHereFolder', tabId, categories, depth),
    runScript: (tabId, scriptPath, asAdmin, args) => ipcRenderer.invoke('scripts:run', tabId, { path: scriptPath, asAdmin: !!asAdmin, args: args || '' }),
    cdToItem: (tabId, itemPath) => ipcRenderer.send('scripts:cd', tabId, itemPath),
    openItem: (itemPath) => ipcRenderer.invoke('scripts:open', itemPath),
    // Selector nativo de archivo/carpeta para los scripts que necesitan una
    // ruta como argumento.
    pickScriptTarget: (mode) => ipcRenderer.invoke('scripts:pickTarget', mode),

    // Explorador lateral: sigue el directorio actual de la pestaña y permite
    // navegar, crear archivos/carpetas y abrir con la aplicación del sistema.
    // main.js valida que todo ocurra dentro de la carpeta que se está viendo.
    listDirectory: (tabId, dir) => ipcRenderer.invoke('explorer:list', tabId, dir),
    followTerminalDirectory: (tabId) => ipcRenderer.invoke('explorer:follow', tabId),
    createDirectoryEntry: (tabId, name, kind) => ipcRenderer.invoke('explorer:create', tabId, name, kind),
    openDirectoryEntry: (tabId, itemPath) => ipcRenderer.invoke('explorer:open', tabId, itemPath),
    // Abrir una CARPETA en el gestor de archivos del sistema. Si no hay
    // ninguno, main.js devuelve con qué se puede abrir o instalar, y la
    // elección vuelve por openDirectoryWith con el identificador de la tabla
    // (nunca con una ruta a un ejecutable).
    openDirectoryInSystem: (tabId, itemPath) => ipcRenderer.invoke('explorer:openDirectory', tabId, itemPath),
    openDirectoryWith: (tabId, itemPath, managerId, remember) =>
        ipcRenderer.invoke('explorer:openDirectoryWith', tabId, itemPath, managerId, remember === true),
    cdToExplorerDirectory: (tabId) => ipcRenderer.invoke('explorer:cd', tabId),
    // Menú contextual del explorador. `mode` es 'copy' o 'cut'; lo que se pega
    // lo recuerda main.js, no el renderer, para que la ruta de origen sea
    // siempre una que el proceso principal validó contra la carpeta abierta.
    renameDirectoryEntry: (tabId, itemPath, newName) => ipcRenderer.invoke('explorer:rename', tabId, itemPath, newName),
    clipDirectoryEntry: (tabId, itemPath, mode) => ipcRenderer.invoke('explorer:clip', tabId, itemPath, mode),
    pasteDirectoryEntry: (tabId) => ipcRenderer.invoke('explorer:paste', tabId),
    trashDirectoryEntry: (tabId, itemPath) => ipcRenderer.invoke('explorer:trash', tabId, itemPath),

    // Portapapeles del sistema, para copiar/pegar con el botón derecho y con
    // Ctrl+Shift+C / Ctrl+Shift+V dentro de la terminal.
    writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
    readClipboard: () => ipcRenderer.invoke('clipboard:read'),

    // Logging: errores del renderer se reenvían al log de main.js; el botón
    // "Ver logs" abre la carpeta con el explorador de archivos del SO.
    reportRendererError: (payload) => ipcRenderer.send('log:renderer-error', payload),
    openLogFolder: () => ipcRenderer.invoke('log:open-folder')
});
