const test = require('node:test');
const assert = require('node:assert/strict');
const { identityForPlatform } = require('../main/appIdentity');

test('Windows conserva la identidad WinSlim y Linux usa LTerminal', () => {
    const windows = identityForPlatform('win32');
    const linux = identityForPlatform('linux');
    assert.equal(windows.name, 'WinSlim Terminal');
    assert.equal(windows.slug, 'winslim-terminal');
    assert.equal(linux.name, 'LTerminal');
    assert.equal(linux.slug, 'lterminal');
    assert.equal(linux.desktopFile, 'lterminal.desktop');
    assert.doesNotMatch(JSON.stringify(linux), /winslim/i);
});
