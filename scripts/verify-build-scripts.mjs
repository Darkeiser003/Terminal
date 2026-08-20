import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const files = {
    linux: await readFile(resolve(root, 'linux/build.sh'), 'utf8'),
    windows: await readFile(resolve(root, 'windows/build.ps1'), 'utf8'),
    host: await readFile(resolve(root, 'linux/exercise-host.sh'), 'utf8'),
    smoke: await readFile(resolve(root, 'tests/e2e/smoke.mjs'), 'utf8'),
    profileSh: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.sh.in'), 'utf8'),
    profilePs1: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.ps1.in'), 'utf8'),
};

const checks = [
    ['Linux ejecuta la batería estática', files.linux.includes('npm run check')],
    ['Windows ejecuta la batería estática', files.windows.includes("@('run', 'check')")],
    ['Linux ofrece test ampliado', files.linux.includes('--extended-tests') && files.linux.includes('--full-tests')],
    ['Linux ofrece instalación del driver E2E', files.linux.includes('--install-e2e-driver')],
    ['Linux acepta ruta explícita del driver E2E', files.linux.includes('--e2e-driver')],
    ['Linux contempla repositorio y helper AUR para WebKitWebDriver', files.linux.includes('webkit2gtk-driver') && files.linux.includes('paru') && files.linux.includes('yay')],
    ['Windows ofrece test ampliado', files.windows.includes('$runExtendedTests') && files.windows.includes('$FullTests')],
    ['Windows puede instalar tauri-driver para E2E', files.windows.includes('$InstallE2eDriver')],
    ['Linux puede lanzar E2E', files.linux.includes('npm run e2e')],
    ['E2E Linux pasa el driver nativo', files.linux.includes('TAURI_NATIVE_DRIVER=')],
    ['Windows puede lanzar E2E', files.windows.includes("@('run', 'e2e')")],
    ['Smoke Linux valida el token de arranque', files.linux.includes('LTERMINAL_SMOKE_TOKEN')],
    ['Smoke Linux fuerza una ejecución reproducible del AppImage', files.linux.includes('APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"')],
    ['Linux fija el ajuste WebKit en el AppImage', files.linux.includes('GTK_HOOK') && files.linux.includes('WEBKIT_DISABLE_DMABUF_RENDERER')],
    ['Linux evita la copia conflictiva de GIO TLS', files.linux.includes('libgiognutls.so') && files.linux.includes('rm -f "$APPDIR/usr/lib/gio/modules/libgiognutls.so"')],
    ['Smoke Windows valida el token de arranque', files.windows.includes('$smokeToken')],
    ['Linux valida que la sesión gráfica sea accesible', files.linux.includes('graphical_session_available') && files.linux.includes('xdpyinfo')],
    ['Linux elimina binarios cruzados antes de empaquetar', files.linux.includes('com.winslim.terminal') && files.linux.includes('stale_binary')],
    ['Linux limpia metadata cruzada del AppDir antes de empaquetar', files.linux.includes('STALE_APPDIR') && files.linux.includes('stale_appdir_file') && files.linux.includes('com.winslim.terminal.metainfo.xml')],
    ['Linux limpia metadata cruzada también durante la recuperación', files.linux.includes('APPDIR_RECOVERY/usr/share/metainfo/com.winslim.terminal.metainfo.xml')],
    ['Linux limpia el staging appimage_deb cruzado', files.linux.includes('appimage_deb') && files.linux.includes('BUNDLE_OUTPUT')],
    ['Linux valida el ejecutable y desktop del AppDir', files.linux.includes('APPDIR/usr/bin/lterminal') && files.linux.includes("LTerminal.desktop")],
    ['Los fallos Linux muestran log', files.linux.includes('tail -n 80')],
    ['Los fallos Windows muestran log', files.windows.includes('Get-Content $logPath -Tail')],
    ['La prueba E2E exige un binario', files.smoke.includes('E2E_BINARY')],
    ['La prueba de host comprueba Git', files.host.includes('probe Git')],
    ['Perfil Linux detecta la aplicación', files.profileSh.includes('find_existing_app')],
    ['Perfil Linux valida el sistema operativo', files.profileSh.includes('necesita Linux')],
    ['Perfil Linux instala desde GitHub', files.profileSh.includes('releases/latest')],
    ['Perfil Linux entrega --import-profile', files.profileSh.includes('--import-profile')],
    ['Perfil Linux usa su nombre de archivo', files.profileSh.includes('LTerminal-profile.lterminal-profile')],
    ['Perfil Windows detecta la aplicación', files.profilePs1.includes('Find-Terminal')],
    ['Perfil Windows valida el sistema operativo', files.profilePs1.includes('necesita Windows')],
    ['Perfil Windows instala desde GitHub', files.profilePs1.includes('api.github.com')],
    ['Perfil Windows entrega --import-profile', files.profilePs1.includes('--import-profile')],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
    throw new Error(`Comprobaciones de scripts de build fallidas:\n- ${failures.join('\n- ')}`);
}

console.log(`Scripts de build verificados (${checks.length} comprobaciones).`);
