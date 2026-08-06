const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateUserData } = require('../main/userDataMigration');

test('fusiona preferencias y scripts de las dos rutas sin borrar el origen', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-userdata-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const legacy = path.join(root, 'visible-name');
    const canonical = path.join(root, 'stable-slug');
    fs.mkdirSync(path.join(legacy, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(canonical, 'scripts'), { recursive: true });
    const legacySettings = path.join(legacy, 'settings.json');
    const canonicalSettings = path.join(canonical, 'settings.json');
    fs.writeFileSync(legacySettings, JSON.stringify({ githubPinnedOwners: ['Darkeiser003'], themeId: 'winslim' }));
    fs.writeFileSync(canonicalSettings, JSON.stringify({ themeId: 'silver', scriptsHereDepth: 5 }));
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-02-01T00:00:00Z');
    fs.utimesSync(legacySettings, old, old);
    fs.utimesSync(canonicalSettings, recent, recent);
    fs.writeFileSync(path.join(legacy, 'scripts', 'legacy.sh'), 'echo legacy');

    const result = migrateUserData(legacy, canonical);
    const merged = JSON.parse(fs.readFileSync(canonicalSettings, 'utf8'));
    assert.equal(result.migrated, true);
    assert.equal(merged.themeId, 'silver');
    assert.equal(merged.scriptsHereDepth, 5);
    assert.deepEqual(merged.githubPinnedOwners, ['Darkeiser003']);
    assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'legacy.sh'), 'utf8'), 'echo legacy');
    assert.equal(fs.existsSync(legacySettings), true);
    assert.equal(migrateUserData(legacy, canonical).migrated, false);
});
