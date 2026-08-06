// Identidad visible y rutas propias por plataforma. Mantener esta decisión en
// un solo módulo evita que una build Linux herede accidentalmente la marca de
// Windows o que aparezcan nombres distintos en ventana, banner, logs y PTY.

const IDENTITIES = Object.freeze({
    win32: Object.freeze({
        name: 'WinSlim Terminal',
        slug: 'winslim-terminal',
        userAgent: 'WinSlim-Terminal',
        projectsFolderName: 'WinSlim Projects',
        desktopFile: null
    }),
    linux: Object.freeze({
        name: 'LTerminal',
        slug: 'lterminal',
        userAgent: 'LTerminal',
        projectsFolderName: 'LTerminal Projects',
        desktopFile: 'lterminal.desktop'
    }),
    darwin: Object.freeze({
        name: 'LTerminal',
        slug: 'lterminal',
        userAgent: 'LTerminal',
        projectsFolderName: 'LTerminal Projects',
        desktopFile: null
    })
});

function identityForPlatform(platform) {
    return IDENTITIES[platform] || IDENTITIES.linux;
}

module.exports = { IDENTITIES, identityForPlatform };
