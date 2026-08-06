const test = require('node:test');
const assert = require('node:assert/strict');
const {
    detectCurrentDirectory,
    wslPathToWindows,
    msysPathToWindows
} = require('../main/currentDir');

test('convierte rutas WSL y MSYS al host', () => {
    assert.equal(wslPathToWindows('/mnt/c/Users/Test/proyecto'), 'C:\\Users\\Test\\proyecto');
    assert.equal(msysPathToWindows('/d/scripts'), 'D:\\scripts');
});

test('detecta prompts cmd, PowerShell, WSL y Docker', () => {
    assert.equal(
        detectCurrentDirectory('C:\\Users\\Test> ', { transport: 'native' }),
        'C:\\Users\\Test'
    );
    assert.equal(
        detectCurrentDirectory('PS D:\\Trabajo> ', { transport: 'native' }),
        'D:\\Trabajo'
    );
    assert.equal(
        detectCurrentDirectory('user@pc:/mnt/c/Users/Test$ ', { transport: 'wsl' }),
        'C:\\Users\\Test'
    );
    assert.equal(
        detectCurrentDirectory('root@abc:/workspace/app# ', {
            transport: 'docker',
            hostRoot: 'C:\\Users\\Test',
            containerRoot: '/workspace'
        }),
        'C:\\Users\\Test\\app'
    );
});

test('una ruta Linux interna usa el recurso de archivos de su distro WSL', () => {
    assert.equal(
        detectCurrentDirectory('user@pc:/home/user$ ', { transport: 'wsl', distro: 'Ubuntu' }, 'C:\\fallback'),
        '\\\\wsl$\\Ubuntu\\home\\user'
    );
});
