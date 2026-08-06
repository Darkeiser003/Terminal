// Configuración Linux deliberadamente separada de la identidad Windows.
// electron-builder carga este archivo únicamente desde `npm run dist:linux`.

const base = require('./package.json').build;

module.exports = {
    ...base,
    appId: 'org.lterminal.app',
    productName: 'LTerminal',
    copyright: 'Copyright © 2026 LTerminal Project',
    extraMetadata: {
        name: 'lterminal',
        productName: 'LTerminal',
        description: 'LTerminal - terminal multipestaña y centro local de herramientas',
        author: 'LTerminal Project',
        desktopName: 'lterminal.desktop'
    },
    linux: {
        ...base.linux,
        executableName: 'lterminal',
        artifactName: 'LTerminal-${version}-${arch}.AppImage'
    }
};
