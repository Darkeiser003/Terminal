// Comprueba, sin WSL, cómo elige `prepareWslBashWithBlesh` la distro del E2E de
// bash: cada caso es un fallo real (build 22: Ubuntu sin contestar; Fedora 44
// sin `awk`, donde ble.sh se quedaba en bucle).
import assert from 'node:assert/strict';
import { prepareWslBashWithBlesh } from './prepare-e2e-shell-tools.mjs';

async function run({ preferred = '', names, probes = {}, installs = {}, platform = 'win32' }) {
    const calls = { probe: [], install: [], pauses: 0, log: [] };
    const next = (table, name, fallback) => {
        if (!(name in table)) return fallback;
        const queue = table[name];
        if (!Array.isArray(queue)) return queue;
        return queue.length > 1 ? queue.shift() : queue[0];
    };
    const result = await prepareWslBashWithBlesh(preferred, 'herramientas', (line) => calls.log.push(line), {
        platform,
        listDistros: async () => names,
        probe: async (name) => {
            calls.probe.push(name);
            return next(probes, name, 'ok');
        },
        install: async (name) => {
            calls.install.push(name);
            const outcome = next(installs, name, 'ok');
            if (outcome !== 'ok') throw new Error(outcome);
            return `/blesh/${name}`;
        },
        pause: async () => { calls.pauses += 1; },
    });
    return { result, ...calls };
}

// Fuera de Windows no hay WSL: ni siquiera se lista.
assert.equal((await run({ names: ['Ubuntu'], platform: 'linux' })).result, null);
assert.equal((await run({ names: [] })).result, null);

// La pedida va primero, y Ubuntu antes que las demás.
{
    const { result, probe } = await run({ preferred: 'Debian', names: ['Alpine', 'Ubuntu', 'Debian'] });
    assert.deepEqual(result, { distro: 'Debian', bleshPath: '/blesh/Debian' });
    assert.deepEqual(probe, ['Debian']);
}
assert.equal((await run({ names: ['Alpine', 'Ubuntu'] })).result.distro, 'Ubuntu');

// Una distro pedida que no existe no se prueba.
{
    const { result, probe } = await run({ preferred: 'NoExiste', names: ['Ubuntu'] });
    assert.equal(result.distro, 'Ubuntu');
    assert.deepEqual(probe, ['Ubuntu']);
}

// Le falta algo: no se reintenta y no se intenta instalar (Fedora 44 sin awk).
{
    const { result, probe, install, pauses } = await run({
        names: ['FedoraLinux-44', 'Ubuntu'],
        preferred: 'FedoraLinux-44',
        probes: { 'FedoraLinux-44': 'falta: awk' },
    });
    assert.equal(result.distro, 'Ubuntu');
    assert.deepEqual(probe, ['FedoraLinux-44', 'Ubuntu']);
    assert.deepEqual(install, ['Ubuntu']);
    assert.equal(pauses, 0);
}

// Ubuntu no contesta a la primera: se reintenta y no se salta a otra distro.
{
    const { result, probe, pauses } = await run({
        names: ['Ubuntu', 'FedoraLinux-44'],
        probes: { Ubuntu: [null, null, 'ok'] },
    });
    assert.equal(result.distro, 'Ubuntu');
    assert.deepEqual(probe, ['Ubuntu', 'Ubuntu', 'Ubuntu']);
    assert.equal(pauses, 2);
}

// Agotados los 3 intentos, pasa a la siguiente; las demás tienen un solo intento.
{
    const { result, probe, pauses } = await run({
        names: ['Ubuntu', 'Alpine', 'Debian'],
        probes: { Ubuntu: null, Alpine: null },
    });
    assert.equal(result.distro, 'Debian');
    assert.deepEqual(probe, ['Ubuntu', 'Ubuntu', 'Ubuntu', 'Alpine', 'Debian']);
    assert.equal(pauses, 2);
}

// ble.sh no se instala: se reintenta y, si sigue fallando, cede el turno.
{
    const { result, install, log } = await run({
        names: ['Ubuntu', 'Debian'],
        installs: { Ubuntu: 'falta espacio' },
    });
    assert.equal(result.distro, 'Debian');
    assert.deepEqual(install, ['Ubuntu', 'Ubuntu', 'Ubuntu', 'Debian']);
    assert.ok(log.some((line) => line.includes('no se instaló en Ubuntu') && line.includes('falta espacio')));
}

// Ninguna sirve.
assert.equal((await run({ names: ['Ubuntu', 'Alpine'], probes: { Ubuntu: 'falta: ps', Alpine: null } })).result, null);

console.log('Elección de distro del E2E de bash verificada: 10 casos sin WSL.');
