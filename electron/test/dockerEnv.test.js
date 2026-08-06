const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImages, parseRunningContainers } = require('../main/dockerEnv');

test('cuenta contenedores Docker activos sin confundirlos con imágenes', () => {
    const containers = parseRunningContainers('web\tnginx:latest\ndb\tmysql:8.4\n');
    const images = parseImages('nginx:latest\nmysql:8.4\n<none>:<none>\n');
    assert.deepEqual(containers, [
        { name: 'web', image: 'nginx:latest' },
        { name: 'db', image: 'mysql:8.4' }
    ]);
    assert.deepEqual(images, ['nginx:latest', 'mysql:8.4']);
    assert.equal(containers.length, 2);
});
