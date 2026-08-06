// Impide que una build publique por accidente la identidad o rutas del
// equipo de desarrollo. Solo revisa archivos que electron-builder incluye;
// settings, logs y repositorios clonados viven fuera del ASAR.

const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../main/githubProjects');

const root = path.join(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const catalogPath = path.join(root, 'config', 'project-catalog.json');

function sourceFiles(dir) {
    const result = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...sourceFiles(full));
        else if (entry.isFile() && /\.(?:js|json|html|css)$/i.test(entry.name)) result.push(full);
    });
    return result;
}

function validateReleaseMetadata() {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (pkg.author !== 'WinSlim Project') throw new Error('package.json debe usar "WinSlim Project" como autor de distribución.');
    if (!pkg.description || !/WinSlim/i.test(pkg.description)) throw new Error('La descripción de distribución debe identificar WinSlim.');
    const rawCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (rawCatalog.brand !== 'WinSlim Project') throw new Error('El catálogo debe usar la marca neutra WinSlim Project.');
    const includesLogin = (values, login) => Array.isArray(values)
        && values.some((value) => String(value).toLowerCase() === login.toLowerCase());

    // Identidad Windows (WinSlim Terminal).
    const catalog = loadCatalog(catalogPath, 'win32');
    // Christianlg97 conserva su perfil oficial y su anclado fijo en Proyectos
    // (su repositorio sigue accesible desde la aplicación), pero ya no figura
    // en los créditos de Ajustes › Información, que se alimentan de
    // `developers`. Las tres listas son independientes justamente para eso.
    if (!includesLogin(catalog.owners, 'Christianlg97')
        || !includesLogin(catalog.fixedProfiles, 'Christianlg97')) {
        throw new Error('Christianlg97 debe permanecer como perfil oficial anclado del catálogo de Windows.');
    }
    if (includesLogin(catalog.developers, 'Christianlg97')) {
        throw new Error('Christianlg97 no debe aparecer en los créditos de Ajustes › Información.');
    }
    if (!includesLogin(catalog.fixedProfiles, 'Darkeiser003')
        || !includesLogin(catalog.developers, 'Darkeiser003')
        || includesLogin(catalog.owners, 'Darkeiser003')) {
        throw new Error('Darkeiser003 debe permanecer como desarrollador fijo, sin rol de perfil oficial.');
    }

    // Identidad LTerminal (Linux y macOS): marca propia, así que en Proyectos
    // solo aparece su propio perfil anclado de fábrica.
    ['linux', 'darwin'].forEach((platform) => {
        const other = loadCatalog(catalogPath, platform);
        if (!includesLogin(other.fixedProfiles, 'Darkeiser003')) {
            throw new Error(`El catálogo de ${platform} debe anclar Darkeiser003.`);
        }
        if (other.fixedProfiles.length !== 1) {
            throw new Error(`El catálogo de ${platform} solo debe anclar Darkeiser003; hay ${other.fixedProfiles.length} perfiles.`);
        }
        if (includesLogin(other.developers, 'Christianlg97') || includesLogin(other.owners, 'Christianlg97')) {
            throw new Error(`El catálogo de ${platform} no debe incluir Christianlg97.`);
        }
    });

    const included = [packagePath, ...sourceFiles(path.join(root, 'main')), ...sourceFiles(path.join(root, 'renderer')), ...sourceFiles(path.join(root, 'config')), path.join(root, 'main.js'), path.join(root, 'preload.js')];
    const findings = [];
    included.forEach((file) => {
        const text = fs.readFileSync(file, 'utf8');
        if (/[A-Za-z]:\\Users\\[^\\\s"']+/i.test(text)) findings.push(`${path.relative(root, file)} contiene una ruta de perfil absoluta`);
        if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) findings.push(`${path.relative(root, file)} contiene un correo electrónico`);
    });
    if (findings.length) throw new Error('Datos personales detectados antes de empaquetar:\n- ' + findings.join('\n- '));
    return { files: included.length, author: pkg.author, brand: catalog.brand };
}

if (require.main === module) {
    const result = validateReleaseMetadata();
    console.log(`Metadatos de release válidos: ${result.author}; ${result.files} archivos revisados.`);
}

module.exports = { validateReleaseMetadata };
