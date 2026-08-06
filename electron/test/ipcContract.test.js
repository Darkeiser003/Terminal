const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function captures(text, regex) {
    const values = new Set();
    let match;
    while ((match = regex.exec(text)) !== null) values.add(match[1]);
    return values;
}

test('cada llamada IPC expuesta por preload tiene receptor en main', () => {
    const root = path.join(__dirname, '..');
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const called = captures(preload, /ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g);
    const registered = captures(main, /ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g);
    const missing = [...called].filter((channel) => !registered.has(channel));
    assert.deepEqual(missing, []);
});

test('invoke usa handle y send usa on para no dejar promesas o errores silenciosos', () => {
    const root = path.join(__dirname, '..');
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const invoked = captures(preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g);
    const sent = captures(preload, /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g);
    const handled = captures(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g);
    const listened = captures(main, /ipcMain\.on\(\s*['"]([^'"]+)['"]/g);
    assert.deepEqual([...invoked].filter((channel) => !handled.has(channel)), []);
    assert.deepEqual([...sent].filter((channel) => !listened.has(channel)), []);
});
