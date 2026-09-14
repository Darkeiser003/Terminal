import assert from 'node:assert/strict';
import { containsExactHttpsUrl } from '../tests/e2e/terminal-url-matcher.mjs';

const validProfile = 'Perfil: https://github.com/Darkeiser003\n';
assert.equal(containsExactHttpsUrl(validProfile, 'https://github.com/Darkeiser003'), true);
assert.equal(containsExactHttpsUrl(
    'Proyecto: https://github.com/Darkeiser003/Infraestructura-Web',
    'https://github.com/Darkeiser003/Infraestructura-Web',
), true);

for (const hostile of [
    'https://github.com/Darkeiser003.attacker.invalid',
    'https://github.com.attacker.invalid/Darkeiser003',
    'https://github.com/other/Darkeiser003',
    'https://github.com/Darkeiser003?next=https://attacker.invalid',
    'https://github.com/Darkeiser003#https://attacker.invalid',
    'https://github.com@attacker.invalid/Darkeiser003',
    'http://github.com/Darkeiser003',
    'https://github.com/other/../Darkeiser003',
]) {
    assert.equal(
        containsExactHttpsUrl(hostile, 'https://github.com/Darkeiser003'),
        false,
        `No debe aceptar una URL que solo contiene el prefijo esperado: ${hostile}`,
    );
}

assert.equal(containsExactHttpsUrl(validProfile, 'not a URL'), false);
console.log('Matcher E2E de URL exacta verificado (10 casos).');
