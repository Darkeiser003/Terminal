import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { patchGtkHook } from './patch-appimage-gtk-hook.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sampleGtkHook = '#!/usr/bin/env bash\nexport GDK_BACKEND=x11 # generated upstream hook\n';
const patchedGtkHook = patchGtkHook(sampleGtkHook);

const files = {
    linux: await readFile(resolve(root, 'linux/build.sh'), 'utf8'),
    linuxWindows: await readFile(resolve(root, 'linux/build-windows.sh'), 'utf8'),
    tauriConfig: await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'),
    cargoManifest: await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8'),
    windows: await readFile(resolve(root, 'windows/build.ps1'), 'utf8'),
    windowsAdminE2e: await readFile(resolve(root, 'windows/e2e-elevated.ps1'), 'utf8'),
    e2eSuiteRunner: await readFile(resolve(root, 'scripts/run-e2e-suite.mjs'), 'utf8'),
    installerTest: await readFile(resolve(root, 'scripts/test-installer.mjs'), 'utf8'),
    configPaths: await readFile(resolve(root, 'src-tauri/src/config/paths.rs'), 'utf8'),
    windowsBat: await readFile(resolve(root, 'windows/build.bat'), 'utf8'),
    winget: await readFile(resolve(root, 'scripts/verify-winget-catalog.mjs'), 'utf8'),
    host: await readFile(resolve(root, 'linux/exercise-host.sh'), 'utf8'),
    smoke: await readFile(resolve(root, 'tests/e2e/smoke.mjs'), 'utf8'),
    e2eNativeDriver: await readFile(resolve(root, 'scripts/e2e-native-driver.mjs'), 'utf8'),
    e2eReport: await readFile(resolve(root, 'scripts/verify-e2e-report.mjs'), 'utf8'),
    package: await readFile(resolve(root, 'package.json'), 'utf8'),
    packageManager: await readFile(resolve(root, 'scripts/package-manager.mjs'), 'utf8'),
    prebuild: await readFile(resolve(root, 'scripts/prebuild.mjs'), 'utf8'),
    buildFrontend: await readFile(resolve(root, 'scripts/build-frontend.mjs'), 'utf8'),
    buildFast: await readFile(resolve(root, 'scripts/build-fast.mjs'), 'utf8'),
    versionRestoreTest: await readFile(resolve(root, 'scripts/test-version-restore.mjs'), 'utf8'),
    links: await readFile(resolve(root, 'scripts/verify-links.mjs'), 'utf8'),
    profileSh: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.sh.in'), 'utf8'),
    profilePs1: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.ps1.in'), 'utf8'),
    releaseHash: await readFile(resolve(root, 'scripts/update-release-hash.mjs'), 'utf8'),
    releaseArtifacts: await readFile(resolve(root, 'scripts/verify-release-artifacts.mjs'), 'utf8'),
    releasePublish: await readFile(resolve(root, 'scripts/publish-release-artifact.mjs'), 'utf8'),
    cargoBuild: await readFile(resolve(root, 'src-tauri/build.rs'), 'utf8'),
    conptyPrepare: await readFile(resolve(root, 'scripts/prepare-conpty.mjs'), 'utf8'),
    wineGuiSmoke: await readFile(resolve(root, 'scripts/wine-gui-smoke.sh'), 'utf8'),
    webview2Preflight: await readFile(resolve(root, 'src-tauri/src/platform/windows/webview2.rs'), 'utf8'),
    singleFilePortable: await readFile(resolve(root, 'scripts/create-single-file-portable.mjs'), 'utf8'),
    viteConfig: await readFile(resolve(root, 'vite.config.ts'), 'utf8'),
    cargoLock: await readFile(resolve(root, 'src-tauri/Cargo.lock'), 'utf8'),
    windowsPlatform: await readFile(resolve(root, 'src-tauri/src/platform/windows/mod.rs'), 'utf8'),
    singleFileRuntime: await readFile(resolve(root, 'src-tauri/src/config/single_file.rs'), 'utf8'),
    windowsPackage: await readFile(resolve(root, 'scripts/package-windows-cross.mjs'), 'utf8'),
    cleanerPs1: await readFile(resolve(root, 'scripts/clean-repository.ps1'), 'utf8'),
    cleanerSh: await readFile(resolve(root, 'scripts/clean-repository.sh'), 'utf8'),
    cleanerTest: await readFile(resolve(root, 'scripts/test-clean-repository.mjs'), 'utf8'),
    versionRestore: await readFile(resolve(root, 'scripts/test-version-restore.mjs'), 'utf8'),
    menuSh: await readFile(resolve(root, 'build-tools/build.sh'), 'utf8'),
    menuPs1: await readFile(resolve(root, 'build-tools/build.ps1'), 'utf8'),
    gitSigning: await readFile(resolve(root, 'build-tools/configure-git-signing.sh'), 'utf8'),
    appApi: await readFile(resolve(root, 'src/lib/api.ts'), 'utf8'),
    pathIntegration: await readFile(resolve(root, 'src-tauri/src/platform/path_integration.rs'), 'utf8'),
    settingsPanel: await readFile(resolve(root, 'src/components/SettingsPanel.svelte'), 'utf8'),
    appState: await readFile(resolve(root, 'src/lib/appState.svelte.ts'), 'utf8'),
    capabilities: await readFile(resolve(root, 'src-tauri/capabilities/default.json'), 'utf8'),
};

function sourceHasHttpsEndpoint(source, expectedHost, pathPattern) {
    const candidates = source.match(/https:\/\/[^'"`\s]+/g) ?? [];
    return candidates.some((candidate) => {
        try {
            const endpoint = new URL(candidate);
            return endpoint.protocol === 'https:'
                && endpoint.hostname.toLowerCase() === expectedHost
                && endpoint.username === ''
                && endpoint.password === ''
                && endpoint.port === ''
                && endpoint.search === ''
                && endpoint.hash === ''
                && pathPattern.test(endpoint.pathname);
        } catch {
            return false;
        }
    });
}

const installerBlock = files.windows.indexOf('if ($Installer) {');
const installerBinaryBuild = files.windows.indexOf("$code = Invoke-TauriBuild @('run', 'tauri', '--', 'build', '--no-bundle')", installerBlock);
const installerLoaderPreparation = files.windows.indexOf('Ensure-WebView2Loader | Out-Null', installerBlock);
const installerBundleBuild = files.windows.indexOf('tauri.windows.installer.conf.json', installerBlock);
const e2eBlock = files.windows.indexOf("Write-Step 'E2E ampliado");
const strictProbeThrow = files.windows.indexOf('if ($strictProbeFailure)');
const invokeNativeStart = files.windows.indexOf('function Invoke-Native {');
const invokeNativeEnd = files.windows.indexOf('\nfunction Assert-E2eReport', invokeNativeStart);
const invokeNativeBlock = invokeNativeStart >= 0 && invokeNativeEnd > invokeNativeStart
    ? files.windows.slice(invokeNativeStart, invokeNativeEnd)
    : '';
const crossLinuxStart = files.windows.indexOf('function Invoke-CrossLinuxTests {');
const crossLinuxEnd = files.windows.indexOf('if ($CrossLinux)', crossLinuxStart);
const crossLinuxBlock = crossLinuxStart >= 0 && crossLinuxEnd > crossLinuxStart
    ? files.windows.slice(crossLinuxStart, crossLinuxEnd)
    : '';
const windowsVersionPrompt = files.windows.indexOf('Versión de release')
const windowsRequirementsStep = files.windows.indexOf("Write-Step 'Comprobando requisitos'")
const linuxVersionPrompt = files.linux.indexOf('Versión de release')
const linuxRequirementsStep = files.linux.indexOf('step "Comprobando requisitos"')
// Las listas de carpetas que borran los limpiadores: la completa y la del
// modo ligero, desde la primera lista hasta la línea en blanco que las
// cierra. Si no se encuentran, el recorte queda vacío y la comprobación de
// abajo falla en vez de pasar sin comprobar nada.
function sliceBetween(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    const end = start < 0 ? -1 : text.indexOf(endMarker, start);
    return start < 0 || end < 0 ? '' : text.slice(start, end);
}
const cleanerPsDirectories = sliceBetween(files.cleanerPs1, '$fullGeneratedDirectories = @(', '\n\n$directoryTargets');
const cleanerShDirectories = sliceBetween(files.cleanerSh, 'generated_directories=(', '\n\nassert_project_target');
const wineRustStart = files.linuxWindows.indexOf('run_wine_rust_tests() {');
const wineRustEnd = files.linuxWindows.indexOf('\nwebview2_registry_key()', wineRustStart);
const wineRustBlock = wineRustStart >= 0 && wineRustEnd > wineRustStart
    ? files.linuxWindows.slice(wineRustStart, wineRustEnd)
    : '';

const checks = [
    ['La build de Windows termina con un resumen de release, pruebas, informes, vídeos, capturas y logs guardados en artifacts/builds', files.windows.includes('function Write-BuildSummary') && /\nWrite-BuildSummary\n/u.test(files.windows) && files.windows.includes("artifacts\\builds\\WTerminal-") && files.windows.includes("$env:E2E_CAPTURE_DIR = Join-Path $e2eUnpackedDir 'capturas'") && files.windows.includes("$env:E2E_CAPTURE_DIR = Join-Path $e2ePortableDir 'capturas'") && files.windows.includes("Copy-Item -LiteralPath $logPath -Destination (Join-Path $artifactsDir 'wterminal-main.log')")],
    ['Con -VideoTest cada forma de distribución graba su vídeo (desempaquetado, portable e instalador)', files.windows.includes("if ($VideoTest.IsPresent) { $env:E2E_CAPTURE_VIDEO = '1' }") && files.e2eSuiteRunner.includes("video: options.suites.includes('video')") && files.installerTest.includes("env: video ? { E2E_CAPTURE_VIDEO: '1' } : {}")],
    ['Los builds frontend admiten npm y pnpm, incluido npm exec', files.packageManager.includes('npm_config_user_agent') && files.packageManager.includes("return 'pnpm'") && files.packageManager.includes("args[0] === 'exec'") && files.prebuild.includes("from './package-manager.mjs'") && files.buildFrontend.includes("from './package-manager.mjs'")],
    ['Windows fija el userconfig de npm para no heredar allow-scripts ambiguo', files.windows.includes("$npmUserConfig = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.npmrc'") && files.windows.includes("$npmConfigArgs + @('ci')") && files.windows.includes("$npmConfigArgs + @('install')") && files.windows.includes('campo') && files.windows.includes('allowScripts del package.json')],
    ['El JavaScript usa un único estándar moderno (ES2023) en Windows y Linux, sin objetivos de navegador antiguos', files.viteConfig.includes("target: 'es2023'") && !/safari\d|chrome\d/u.test(files.viteConfig.replace(/\/\/.*$/gmu, '')) && files.viteConfig.includes('WebKitGTK 2.40') && (() => { const match = files.cargoLock.match(/name = "wry"\r?\nversion = "0\.(\d+)\./u); return Boolean(match) && Number(match[1]) >= 50; })()],
    ['release/ de Windows solo guarda lo que se sube a GitHub; lo intermedio y lo de desarrollo van a src-tauri/target/dist', files.windows.includes("$distRoot = Join-Path $TauriDir 'target\\dist'") && files.windows.includes('$distDir = Join-Path $distRoot "WTerminal-$version$distSuffix"') && files.windows.includes("$releaseArtifactOut = if ($Fast) { Join-Path $distRoot 'dev' } else { $releaseArtifactRoot }") && files.windows.includes("$releaseOut = Join-Path $distRoot 'dev'") && files.windows.includes("release-anterior") && !files.windows.includes('Join-Path $ProjectRoot "release\\WTerminal-')],
    ['El build rápido ejecuta el frontend directamente y no necesita npm', files.package.includes('"build:fast"') && files.package.includes('scripts/build-fast.mjs') && files.buildFast.includes('process.execPath') && files.buildFast.includes('build-frontend.mjs')],
    ['El builder Windows conserva rutas inyectadas, restaura un VsDevCmd incompleto y mantiene la build pnpm sin TTY', files.windows.includes('$existingPath = $env:Path') && files.windows.includes("$env:Path = $pathEntries -join ';'") && files.windows.includes('$previousEnvironment = [Environment]::GetEnvironmentVariables(\'Process\')') && files.windows.includes("$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'") && files.windows.includes('--config.verifyDepsBeforeRun=false') && files.windows.includes('install --lockfile=false') && files.windows.includes('$script:UsingPnpmNpmShim = $true') && files.windows.includes('node_modules\\@tauri-apps\\cli\\tauri.js')],
    ['El builder Windows no trunca las claves multilínea al importar VsDevCmd', files.windows.includes('$preservedMultilineEnvironment') && files.windows.includes('LTERMINAL_SIGNING_PRIVATE_KEY') && files.windows.includes('LTERMINAL_UPDATE_PUBLIC_KEY') && files.windows.includes('$matches[1] -in $preservedMultilineEnvironment')],
    ['Windows carga automáticamente las claves locales fuera de CI', files.windows.includes('Import-LocalSigningMaterial') && files.windows.includes('LTERMINAL_SIGNING_PRIVATE_KEY_FILE') && files.windows.includes('LTERMINAL_UPDATE_PUBLIC_KEY_FILE') && files.windows.includes('release-signing-private.pem') && files.windows.includes('release-signing-public.hex') && files.windows.includes("$env:CI -match '^(1|true|yes)$'" ) && files.windows.includes("[Environment]::GetFolderPath('Desktop')")],
    ['La prueba de restauración Windows no depende de instalar toolchains antes de probar el rollback', files.windows.includes('$runVersionRecoveryTest') && files.windows.includes('Restore-VersionManifests') && files.versionRestoreTest.includes('wterminal)-version-\\d+')],
    ['El modo terminal limpio oculta y restaura las decoraciones nativas al cargar, guardar, recargar y restablecer', files.appApi.includes('setWindowDecorations(visible: boolean)') && files.appApi.includes('getCurrentWindow().setDecorations(visible)') && files.appState.includes('await this.syncWindowDecorations(prefs.preferences)') && files.appState.includes('await this.syncWindowDecorations(after, before)') && files.appState.includes('await this.syncWindowDecorations(payload.preferences, before)') && files.appState.includes('await this.syncWindowDecorations(payload.preferences, this.preferences)') && files.capabilities.includes('core:window:allow-set-decorations')],
    ['El menú Linux reúne desarrollo, builds, pruebas, smoke y limpieza', ['Desarrollo y preview', 'Compilar', 'Pruebas y smoke sin recompilar', 'Limpiar cachés', 'linux/build.sh', 'linux/build-windows.sh', 'linux/validate-release.sh', 'scripts/clean-repository.sh'].every((marker) => files.menuSh.includes(marker))],
    ['La firma de commits se configura de forma explícita, local y separada de las builds', files.menuSh.includes('--setup-git-signing') && files.menuSh.includes('Configurar firma SSH de commits para GitHub') && files.gitSigning.includes('git config --local') && files.gitSigning.includes('commit.gpgsign true') && files.gitSigning.includes('Key type: Signing key') && files.gitSigning.includes('no sube')],
    ['El menú ofrece builds completas, rápidas, selectivas y validación cruzada extensa', ['AppImage Linux (release completa)', 'AppImage Linux (iteración rápida)', 'aplicación portable Windows desde Linux', 'suite Rust bajo Wine', 'preview web funcional', 'sin pruebas ampliadas', '--full-tests', '--wine-repeats', '--cross-windows', '--no-extended-tests', '--skip-checks'].every((marker) => files.menuSh.includes(marker))],
    ['El menú puede validar el binario Linux existente correcto sin recompilarlo', files.menuSh.includes('E2E_BINARY="$binary"') && files.menuSh.includes('package-scripts.mjs run e2e') && files.menuSh.includes('linux/validate-release.sh') && files.menuSh.includes('$ROOT/src-tauri/target/release/lterminal')],
    ['El menú PowerShell ofrece las mismas categorías, builds nativas, selectivas y pruebas Wine', ['Desarrollo y preview', 'Compilar', 'Pruebas y smoke sin recompilar', 'Limpiar cachés', 'windows/build.ps1', 'linux/build.sh', 'linux/build-windows.sh', 'suite Rust bajo Wine', 'preview web funcional', 'sin pruebas ampliadas', '--full-tests', '--wine-repeats', 'scripts/clean-repository.ps1', 'wterminal.exe'].every((marker) => files.menuPs1.includes(marker)) && !files.menuPs1.includes('$IsWindows')],
    ['PATH añade y retira WTerminal con alcance de usuario en Windows y Linux y se prueba en E2E', files.pathIntegration.includes('HKEY_CURRENT_USER') && files.pathIntegration.includes('join(".local/bin/wterminal")') && files.pathIntegration.includes('update_shell_files') && files.settingsPanel.includes('settings-path-integration') && files.appApi.includes('path_integration_set') && files.smoke.includes('E2E_PATH_INTEGRATION_ONLY') && files.smoke.includes("recordEvent('path-integration-toggle'") && files.e2eReport.includes("focusedScenario === 'path-integration'") && files.smoke.includes('restauración de la integración de WTerminal en PATH')],
    ['Los builders Linux, Windows cruzado y Windows nativo aceptan LTERMINAL_RELEASE_DIR', files.linux.includes('LTERMINAL_RELEASE_DIR') && files.linuxWindows.includes('LTERMINAL_RELEASE_DIR') && files.windows.includes('$env:LTERMINAL_RELEASE_DIR')],
    ['Una build Linux limpia propaga --clean al target Windows cruzado', files.linux.includes('[ "$CLEAN" -eq 1 ] && cross_args+=(--clean)')],
    ['Los menús usan la versión del proyecto sin volver a abrir el cuestionario del builder', files.menuSh.includes('--non-interactive') && files.menuPs1.includes('-NonInteractive')],
    ['Los menús de build verifican dependencias antes de ejecutarlas', files.menuSh.includes('¿Permitir instalar automáticamente dependencias') && files.menuPs1.includes('¿Continuar?')],
    ['Los menús bloquean la limpieza si falla la vista previa', files.menuSh.includes('RUN_ACTION_STATUS=$status') && files.menuSh.includes('preview_status="$RUN_ACTION_STATUS"') && files.menuSh.includes('La vista previa falló; se cancela la limpieza') && files.menuPs1.includes('$script:LastMenuActionStatus = $exitCode') && files.menuPs1.includes('$script:LastMenuActionStatus = 1') && files.menuPs1.includes('if ($script:LastMenuActionStatus -ne 0)')],
    ['Los menús bloquean la limpieza si falla la vista previa', files.menuSh.includes('RUN_ACTION_STATUS=$status') && files.menuSh.includes('preview_status="$RUN_ACTION_STATUS"') && files.menuSh.includes('La vista previa falló; se cancela la limpieza') && files.menuPs1.includes('$script:LastMenuActionStatus = $exitCode') && files.menuPs1.includes('$script:LastMenuActionStatus = 1') && files.menuPs1.includes('if ($script:LastMenuActionStatus -ne 0)')],
    ['Cargo invalida el ejecutable cuando cambia el frontend incrustado', files.cargoBuild.includes('cargo:rerun-if-changed=../dist/index.html')],
    ['Cargo recompila el actualizador cuando cambian las claves incrustadas', files.cargoBuild.includes('cargo:rerun-if-env-changed={variable}') && files.cargoBuild.includes('cargo:rustc-env={variable}') && ['LTERMINAL_UPDATE_PUBLIC_KEY', 'LTERMINAL_SSH_UPDATE_PUBLIC_KEY', 'LTERMINAL_SSH_UPDATE_IDENTITY'].every((key) => files.cargoBuild.includes(`"${key}"`))],
    ['Windows carga la confianza antes de compilar y bloquea una release sin claves', files.windows.includes('Import-UpdateTrustMaterialForBuild') && files.windows.indexOf('Import-UpdateTrustMaterialForBuild') < files.windows.indexOf('function Invoke-TauriBuild') && files.windows.includes('Faltan las claves públicas de confianza antes de compilar')],
    ['El build obtiene ConPTY desde un paquete oficial fijado, verifica SHA-512/ZIP y omite solo el prefijo API no navegable', files.conptyPrepare.includes('Microsoft.Windows.Console.ConPTY') && files.conptyPrepare.includes('1.24.260710001') && files.conptyPrepare.includes('verifyNugetSha512') && files.conptyPrepare.includes('extractConptyAssets') && files.conptyPrepare.includes('link-check: ignore') && files.links.includes('isLinkCheckIgnored(content, match.index)')],
    ['Los builds Windows nativo y cruzado preparan ConPTY antes de comprobar/compilar', files.windows.includes("Invoke-Native 'node' @('scripts/prepare-conpty.mjs')") && files.linuxWindows.includes('node "$PROJECT_ROOT/scripts/prepare-conpty.mjs"') && files.windows.indexOf("Invoke-Native 'node' @('scripts/prepare-conpty.mjs')") < files.windows.indexOf("Write-Step 'Instalando dependencias del frontend") && files.linuxWindows.indexOf('node "$PROJECT_ROOT/scripts/prepare-conpty.mjs"') < files.linuxWindows.indexOf('cargo check --manifest-path')],
    ['La compilación Windows falla pronto y claramente si faltan los recursos ConPTY preparados', files.cargoBuild.includes('Falta {}. Ejecuta `node scripts/prepare-conpty.mjs`') && files.cargoBuild.includes('std::fs::copy(&from, &to).unwrap_or_else')],
    ['Linux ejecuta la batería estática', files.linux.includes('npm run check')],
    ['El build comprueba los registros de instalación', files.package.includes('check:install-sources') && files.linux.includes('npm run check') && files.windows.includes("'check'")],
    ['Un timeout Git queda como aviso y no congela la release', files.links.includes('warning: lastError.startsWith(\'timeout\')') && files.links.includes('GIT_LINK_CHECK_TIMEOUT_MS ?? 15000')],
    ['El verificador de enlaces respeta la plataforma y los fixtures', files.links.includes('LTERMINAL_LINK_CHECK_PLATFORM') && files.links.includes('fuente AUR exclusiva de Linux') && files.links.includes('link-check:')],
    ['Windows ejecuta la batería estática', files.windows.includes("@('run', 'check')")],
    ['PowerShell 5.1 recibe el script Windows como UTF-8 con BOM', files.windows.charCodeAt(0) === 0xFEFF],
    ['Windows fija UTF-8 para la salida de procesos nativos', files.windows.includes('[Console]::OutputEncoding = $utf8NoBom') && files.windows.includes('$OutputEncoding = $utf8NoBom')],
    ['Windows muestra tiempos por paso y tiempo total de build', files.windows.includes('$script:BuildStartedAt') && files.windows.includes('Tiempo del paso anterior') && files.windows.includes('Tiempo total')],
    ['Windows ofrece selector interactivo con valores predeterminados y conserva CI', files.windows.includes('Read-BuildChoice') && files.windows.includes('$interactiveBuild') && files.windows.includes('$hasExplicitBuildOptions') && files.windows.includes('$isCiEnvironment') && files.windows.includes('Enter conserva el valor actual')],
    ['Windows solicita la versión al inicio junto a la configuración', windowsVersionPrompt >= 0 && windowsRequirementsStep > windowsVersionPrompt && files.windows.includes('$canPromptVersion') && files.windows.includes('$printedBuildConfigHeader')],
    ['Windows rechaza argumentos desconocidos y conflictos antes de tocar dependencias', files.windows.includes('Argumento(s) no reconocido(s)') && files.windows.includes("$NoExtendedTests.IsPresent -and ($FullTests.IsPresent -or $StrictTests.IsPresent)") && files.windows.indexOf('Argumento(s) no reconocido(s)') < files.windows.indexOf('$WindowsDir')],
    ['Windows valida SemVer antes de comprobar el toolchain', files.windows.includes('$semverPattern') && files.windows.includes('La versión indicada no es SemVer válida') && files.windows.indexOf('$semverPattern') < files.windows.indexOf("Write-Step 'Comprobando requisitos")],
    ['Windows rechaza una versión vacía indicada explícitamente', files.windows.includes('$versionWasExplicit') && files.windows.includes('La versión no puede estar vacía.')],
    ['Windows captura stderr de Java sin convertirlo en NativeCommandError', files.windows.includes('$isJavaProbe = [IO.Path]::GetFileNameWithoutExtension($Command) -ieq \'java\'') && files.windows.includes('New-Object System.Diagnostics.ProcessStartInfo') && files.windows.includes('$processInfo.RedirectStandardError = $true') && files.windows.includes('$process.WaitForExit()') && files.windows.includes('$exitCode = [int]$process.ExitCode')],
    ['Windows une stderr informativo de comandos nativos sin falsos NativeCommandError', files.windows.includes('$nativeOutput = @(& $Command @Arguments 2> $stderrPath)') && files.windows.includes('el código de salida sigue siendo la única señal de fallo')],
    ['Windows no oculta el código nativo con una variable LASTEXITCODE local', invokeNativeBlock.includes('$exitCode = [int]$LASTEXITCODE') && !/\$LASTEXITCODE\s*=/.test(invokeNativeBlock)],
    ['Windows no empaqueta un ejecutable antiguo cuando Tauri deja errores aunque npm devuelva cero', files.windows.includes("Invoke-Native 'npm' $Arguments -CaptureOutput") && files.windows.includes('$script:LastNativeOutput -match') && files.windows.includes('failed to build app') && files.windows.includes('could not compile')],
    ['Windows no convierte avisos stderr de rustc en fallos al buscar rust-lld', files.windows.includes('$sysrootOutput = @(& rustc --print sysroot 2>&1)') && files.windows.includes("$ErrorActionPreference = 'Continue'") && files.windows.includes("Where-Object { $_ -match '^[A-Za-z]:\\\\|^/' }")],
    ['WinGet evita falsos fallos por consultas concurrentes y reintenta tras actualizar la fuente', files.winget.includes('LTERMINAL_WINGET_CONCURRENCY') && files.winget.includes('?? 1') && files.winget.includes("source', 'update")],
    ['Windows ofrece comprobaciones externas offline sin saltar tests locales', files.windows.includes('$AllowOfflineChecks') && files.windows.includes("$env:LTERMINAL_LINK_CHECK = 'warn'") && files.windows.includes("$env:LTERMINAL_INSTALL_SOURCE_CHECK = 'warn'") && files.windows.includes("$env:LTERMINAL_WINGET_CHECK = 'warn'")],
    ['Windows documenta una ayuda no destructiva para la build', files.windows.includes('[Alias(\'h\')][switch]$Help') && files.windows.includes('if ($Help)') && files.windowsBat.includes('build.bat -Help') && files.windowsBat.includes('Ayuda mostrada; no se ejecuto') && files.windowsBat.includes('for %%A in (%*)')],
    ['Linux ofrece test ampliado', files.linux.includes('--extended-tests') && files.linux.includes('--full-tests')],
    ['Linux tiene modo no interactivo', files.linux.includes('--non-interactive') && files.linux.includes('NON_INTERACTIVE')],
    ['Linux rechaza Git Bash/MSYS como builder Windows y dirige al script nativo', files.linux.includes('MINGW*|MSYS*|CYGWIN*') && files.linux.includes('windows\\build.ps1') && files.linux.includes('linux/build.sh solo compila la release Linux')],
    ['Linux carga automáticamente las claves de firma locales fuera de CI', files.linux.includes('load_local_signing_material') && files.linux.includes('release-signing-private.pem') && files.linux.includes('release-signing-public.hex') && files.linux.includes('[ -n "${CI:-}" ] && return 0')],
    ['Linux no declara verificada una firma que no haya comprobado', files.linux.includes('Falta LTERMINAL_UPDATE_PUBLIC_KEY') && files.linux.includes('--verify') && files.linux.includes('rm -f "$RELEASE_DIR/SHA256SUMS.txt.sig"')],
    ['Linux ofrece selector interactivo con valores predeterminados y conserva CI', files.linux.includes('ask_build_choice') && files.linux.includes('configure_interactive_options') && files.linux.includes('EXPLICIT_OPTIONS') && files.linux.includes('${CI:-}') && files.linux.includes('Enter conserva el valor actual')],
    ['Linux solicita la versión al inicio junto a la configuración', linuxVersionPrompt >= 0 && linuxRequirementsStep > linuxVersionPrompt && files.linux.includes('can_prompt') && files.linux.includes('CURRENT_VERSION')],
    ['Linux ofrece modo explícito sin red', files.linux.includes('--allow-offline-checks') && files.linux.includes('LTERMINAL_LINK_CHECK=warn')],
    ['Linux activa tests ampliados por defecto', files.linux.includes('EXTENDED_TESTS=1') && files.linux.includes('--no-extended-tests')],
    ['Linux rechaza combinaciones contradictorias de tests ampliados', files.linux.includes('EXTENDED_MODE=""') && files.linux.includes('--full-tests/--extended-tests no se puede combinar') && files.linux.includes('--no-extended-tests no se puede combinar')],
    ['Linux acepta --version con valor separado o con igual y valida SemVer pronto', files.linux.includes('--version=*)') && files.linux.includes('La versión indicada no es SemVer válida') && files.linux.indexOf('La versión indicada no es SemVer válida') < files.linux.indexOf('Comprobando requisitos')],
    ['Linux valida rutas de driver ausentes y no consume el siguiente flag', files.linux.includes('E2E_DRIVER_PATH') && files.linux.includes('[[ "$1" == -* ]]') && files.linux.includes('--e2e-driver=*)')],
    ['Linux ofrece perfil release comprimido y desarrollo rápido', files.linux.includes('--fast') && files.linux.includes('CARGO_PROFILE_RELEASE_LTO=false') && files.linux.includes('CARGO_PROFILE_RELEASE_LTO=true') && files.linux.includes('CARGO_PROFILE_RELEASE_INCREMENTAL=true') && files.linux.includes('RELEASE_DIR/dev') && files.linux.includes('-dev.AppImage')],
    ['Linux prepara herramientas opcionales del host', files.linux.includes('install_extended_test_tools') && files.linux.includes('gcc-fortran') && files.linux.includes('com.usebottles.bottles')],
    ['Linux evita actualizar todo el sistema al instalar herramientas', files.linux.includes('pacman_install()') && files.linux.includes('LTERMINAL_ALLOW_SYSTEM_UPGRADE') && files.linux.includes('pacman -S --needed --noconfirm')],
    ['Windows cruzado evita actualizar todo el sistema al instalar MinGW/Wine', !files.linuxWindows.includes('pacman -Syu') && files.linuxWindows.includes('pacman -S --needed --noconfirm')],
    ['Linux detecta bloqueos de pacman sin borrarlos automáticamente', files.linux.includes('wait_for_pacman_lock()') && files.linux.includes('/var/lib/pacman/db.lck') && files.linux.includes('No se eliminará automáticamente')],
    ['Host smoke reconoce Bottles Flatpak', files.host.includes('com.usebottles.bottles') && files.host.includes('probe_bottles')],
    ['Linux ofrece instalación del driver E2E', files.linux.includes('--install-e2e-driver')],
    ['Linux acepta ruta explícita del driver E2E', files.linux.includes('--e2e-driver')],
    ['Linux contempla repositorio y helper AUR para WebKitWebDriver', files.linux.includes('webkit2gtk-driver') && files.linux.includes('paru') && files.linux.includes('yay')],
    ['Windows ejecuta las suites estandarizadas: regresiones con la batería y validación de release completa', files.windows.includes('[switch]$ReleaseValidation')
        && files.windows.includes("if ($runExtendedTests -and -not $NoFocusedTests.IsPresent) { $suiteNames += 'focused' }")
        && ['video', 'downloads', 'dependency-audit', 'installer'].every((suite) => files.windows.includes(`$suiteNames += '${suite}'`))
        && files.windows.includes("@('scripts/run-e2e-suite.mjs', '--binary'")
        && files.windows.includes("$suiteArgs += @('--installer', $installerReleasePath")
        && files.windows.includes('Validación omitida:')
        && files.windows.includes("$env:WTERMINAL_EXPECTED_RELEASE_ARTIFACTS = ($publishedArtifacts -join ';')")
        && files.windows.includes('$publishedArtifacts += (Split-Path $installerReleasePath -Leaf)')
        && files.windows.indexOf("Write-Step \"Suites E2E estandarizadas") > files.windows.indexOf('Validación preventiva final')
        && files.package.includes('"dist:win:validate"') && files.package.includes('-ReleaseValidation')
        && files.menuPs1.includes("'-ReleaseValidation'") && files.menuPs1.includes('scripts/run-e2e-suite.mjs')],
    ['Windows ejecuta tests ampliados por defecto salvo exclusión explícita',files.windows.includes('$runExtendedTests') && files.windows.includes('$NoExtendedTests') && files.windows.includes('activada por defecto') && !files.windows.includes('Read-Host \'¿Ejecutar también')],
    ['Los probes REPL de Windows sobreviven al entrecomillado de PowerShell 5.1', files.windows.includes("print('LTERMINAL_REPL_OK')") && files.windows.includes("puts 'LTERMINAL_REPL_OK'") && files.windows.includes("echo 'LTERMINAL_REPL_OK';") && !files.windows.includes("'print(\"LTERMINAL_REPL_OK\")'")],
    ['Windows resuelve herramientas instaladas fuera del PATH y omite VMware sin distribución automatizable', files.windows.includes('Resolve-ProbeExecutable') && files.windows.includes('MariaDB*') && files.windows.includes('WSCore') && !files.windows.includes("Name = 'VMware'")],
    ['Los probes REPL exigen salida real además del código cero', files.windows.includes('[switch]$CaptureOutput') && files.windows.includes("Expect = 'LTERMINAL_REPL_OK'") && files.windows.includes('no produjo el marcador esperado')],
    ['La sonda de Windows Terminal no abre su diálogo gráfico', files.windows.includes("Detect = 'wt.exe'") && files.windows.includes('$wt.FileVersionInfo.ProductVersion') && !files.windows.includes("Exe = 'wt.exe'; Args = @('--version')")],
    ['Un alias WindowsApps roto se clasifica como ausente sin abortar la batería', files.windows.includes('return 9009') && files.windows.includes('$probeCode -eq 9009') && files.windows.includes('su ejecutable real no está disponible')],
    ['FullTests no exige instalar todo el catálogo y StrictTests sí', files.windows.includes('$StrictTests.IsPresent -and $missingProbes.Count -gt 0') && files.windows.includes('$strictExtendedTests -and $failedProbes.Count -gt 0')],
    ['Windows ofrece modo rápido explícito y evita combinaciones ambiguas', files.windows.includes('$NoExtendedTests') && files.windows.includes('no se puede combinar') && files.package.includes('dist:win:fast') && files.package.includes('-NoExtendedTests')],
    ['El comando de release Windows ejecuta la batería completa', files.package.includes('dist:win') && files.package.includes('-FullTests')],
    ['Windows conserva una ruta rápida explícita', files.package.includes('dist:win:fast') && files.package.includes('windows/build.ps1 -NoRun -NonInteractive -NoExtendedTests')],
    ['Windows ofrece perfil release comprimido y desarrollo rápido', files.windows.includes('[switch]$Fast') && files.windows.includes('CARGO_PROFILE_RELEASE_LTO') && files.windows.includes('CARGO_PROFILE_RELEASE_INCREMENTAL') && files.windows.includes('WTerminal-$version$distSuffix') && files.windows.includes('WTerminal-Unpacked-$version$zipSuffix.zip') && files.package.includes('-Fast')],
    ['El lanzador BAT documenta el perfil rápido', files.windowsBat.includes('build.bat -Fast')],
    ['Windows cruzado ofrece perfil de desarrollo rápido', files.linuxWindows.includes('--fast') && files.linuxWindows.includes('CARGO_PROFILE_RELEASE_LTO=false') && files.package.includes('dist:win:linux:fast')],
    ['Windows cruzado desde Linux publica la carpeta y el ZIP en el destino configurable release/', files.linuxWindows.includes('package-windows-cross.mjs') && files.linuxWindows.includes('WTerminal-$VERSION_OVERRIDE$release_suffix') && files.linuxWindows.includes('WTerminal-Unpacked-$VERSION_OVERRIDE$release_suffix.zip') && files.linuxWindows.includes('LTERMINAL_RELEASE_DIR') && files.linuxWindows.includes('release_out="$release_out/dev"')],
    ['La publicación Windows cruzada valida runtime, ZIP, hashes y firma antes de informar rutas', files.linuxWindows.includes('ensure_zip') && files.linuxWindows.includes('verify-release-artifacts.mjs') && files.linuxWindows.includes('sign-release-manifest.mjs') && files.linuxWindows.includes('Manifiesto de la release Windows firmado y verificado')],
    ['El portable Windows puede incluir y auto-instalar el bootstrapper WebView2 antes de crear la ventana', files.linuxWindows.includes('LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER') && files.windowsPackage.includes('--webview2-installer') && files.windowsPackage.includes('MicrosoftEdgeWebView2Setup.exe') && files.webview2Preflight.includes('ensure_runtime()') && files.webview2Preflight.includes('/silent') && files.webview2Preflight.includes('/install')],
    ['La validación de releases inspecciona el bootstrapper WebView2 si se distribuye', files.releaseArtifacts.includes('Bootstrapper WebView2 es PE Windows') && files.releaseArtifacts.includes('MicrosoftEdgeWebView2Setup.exe')],
    ['Los comandos npm rápidos omiten las fases caras de forma explícita', files.package.includes('dist:win:fast') && files.package.includes('-SkipChecks') && files.package.includes('dist:linux:fast') && files.package.includes('--no-extended-tests') && files.package.includes('dist:win:linux:fast') && files.package.includes('--skip-checks')],
    ['El portable de un solo archivo usa su ConPTY y su WebView2 embebidos sin archivos al lado', files.windowsPlatform.includes('crate::single_file::CONPTY_FILES') && files.windowsPlatform.includes('LoadLibraryExW') && files.windowsPlatform.includes('runtime_cache_root()') && files.webview2Preflight.includes('EmbeddedInstaller::extract()') && files.singleFileRuntime.includes('fn certificate_table(') && files.singleFileRuntime.includes('pub fn verify_executable(')],
    ['Windows ofrece instalador offline de WebView2 y bootstrapper opcional para el portable', files.windows.includes('$Installer') && files.windows.includes('tauri.windows.installer.conf.json') && files.windows.includes('bundle\\nsis') && files.windows.includes('Find-PortableWebView2Bootstrapper') && files.windows.includes('LTERMINAL_INCLUDE_WEBVIEW2_BOOTSTRAPPER') && files.windows.includes('MicrosoftEdgeWebView2Setup.exe')],
    ['Windows instala automáticamente tauri-driver cuando E2E lo necesita', files.windows.includes('se instalará automáticamente con cargo') && !files.windows.includes("-and $InstallE2eDriver -and") && files.windows.includes('tauri-driver no apareció en PATH')],
    ['Windows prepara Edge WebDriver compatible sin exigir Microsoft Edge', files.windows.includes('Get-WebView2RuntimeVersion') && sourceHasHttpsEndpoint(files.windows, 'msedgedriver.microsoft.com', /^\/LATEST_RELEASE_[^/]+_WINDOWS$/) && sourceHasHttpsEndpoint(files.windows, 'msedgedriver.microsoft.com', /^\/[^/]+\/edgedriver_[^/]+\.zip$/) && files.windows.includes('sin instalar Microsoft Edge') && files.windows.includes('$env:TAURI_NATIVE_DRIVER = $nativeE2eDriver')],
    ['Linux puede lanzar E2E', files.linux.includes('npm run e2e')],
    ['Linux publica el AppImage aunque falle el E2E y deja diagnóstico final', files.linux.includes('if ! APPIMAGE_EXTRACT_AND_RUN=') && files.linux.includes('TAURI_NATIVE_DRIVER=') && files.linux.includes('post_build_issue "E2E falló') && files.linux.includes('POST_BUILD_FAILURE')],
    ['E2E Linux pasa el driver nativo', files.linux.includes('TAURI_NATIVE_DRIVER=')],
    ['Windows puede lanzar E2E', files.windows.includes("@('run', 'e2e')")],
    ['El E2E administrativo exige elevación, aísla datos y confirma que siendo administrador NSudo se abre directo sin marca RUNASADMIN', files.windowsAdminE2e.includes('$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)') && files.windowsAdminE2e.includes("$env:APPDATA = $runRoot") && files.windowsAdminE2e.includes("$env:LTERMINAL_E2E_APP_DATA_DIR = $runRoot") && files.windowsAdminE2e.includes("$env:E2E_WINDOWS_ADMIN_ONLY = '1'") && files.configPaths.includes('LTERMINAL_E2E_TESTING') && files.configPaths.includes('LTERMINAL_E2E_APP_DATA_DIR') && files.windowsAdminE2e.includes('windows-admin-permissions') && files.windowsAdminE2e.includes("launcher -ne 'direct'") && files.windowsAdminE2e.includes('restartVisible -ne $false') && files.windowsAdminE2e.includes('runAsAdminFlag -ne $false') && files.windowsAdminE2e.includes('focusedScenario') && files.package.includes('e2e:admin')],
    ['Windows automatiza la propia release sin recompilar un segundo perfil', files.windows.includes('$env:E2E_BINARY = Join-Path $distDir') && !files.windows.includes("@('run', 'e2e:build')")],
    ['E2E Windows descubre automáticamente el Edge WebDriver compatible con WebView2 desde PATH o caché', files.smoke.includes('resolveWindowsNativeDriver(projectRoot)') && files.smoke.includes('process.env.TAURI_NATIVE_DRIVER = nativeDriver') && files.e2eNativeDriver.includes('F3017226-FE2A-4295-8BDF-00C3A9A7E4C5') && files.e2eNativeDriver.includes('e2e-driver') && files.e2eNativeDriver.includes('isCompatibleDriverVersion')],
    ['E2E localiza el log actual de WTerminal en Windows y mantiene el nombre anterior como fallback', files.smoke.includes("['wterminal', 'winslim-terminal']") && files.smoke.includes("join(configRoot, name, 'logs', 'main.log')")],
    ['El smoke Windows aísla perfil, log y RUNASADMIN; restaura el entorno y el valor exacto de compatibilidad', files.windows.includes('$appCompatValueName = Join-Path $distDir') && files.windows.includes('$appCompatWithoutRunAsAdmin') && files.windows.includes('Remove-ItemProperty -LiteralPath $appCompatLayersKey') && files.windows.includes('New-ItemProperty -LiteralPath $appCompatLayersKey -Name $appCompatValueName') && files.windows.includes("$env:LTERMINAL_E2E_TESTING = '1'") && files.windows.includes('$env:LTERMINAL_E2E_APP_DATA_DIR = $smokeAppDataDir') && files.windows.includes("$logPath = Join-Path $script:BuildTempDir 'smoke\\main.log'") && files.windows.includes('No se pudo restaurar exactamente la compatibilidad AppCompat')],
    ['Build Windows cruzada fija el target GNU x64', files.linuxWindows.includes('x86_64-pc-windows-gnu')],
    ['Build Windows cruzada evita exports PE internos', files.linuxWindows.includes('exclude-all-symbols')],
    ['Build Windows cruzada compila tests y ramas cfg(windows) con avisos estrictos', files.linuxWindows.includes('cargo check --manifest-path') && files.linuxWindows.includes('--tests --target "$TARGET"') && files.linuxWindows.includes('-D warnings')],
    ['Build Windows cruzada recompila el frontend', files.linuxWindows.includes('npm run build')],
    ['Build Windows cruzada activa el protocolo Tauri', files.linuxWindows.includes('--features tauri/custom-protocol')],
    ['Build Windows cruzada verifica los recursos runtime', ['conpty.dll', 'OpenConsole.exe', 'WebView2Loader.dll'].every((asset) => files.linuxWindows.includes(asset))],
    ['Build Windows cruzada valida la estructura PE x64', files.linuxWindows.includes('verify-release-artifacts.mjs') && files.linuxWindows.includes('--windows-dir')],
    ['Build Linux valida la estructura ELF/AppImage', files.linux.includes('verify-release-artifacts.mjs') && files.linux.includes('--appdir')],
    ['Build Windows nativa valida la estructura PE x64', files.windows.includes('verify-release-artifacts.mjs') && files.windows.includes('--windows-dir')],
    ['Build Windows cruzada ofrece smoke Wine con salida y PTY verificables', files.linuxWindows.includes('--wine-smoke') && files.linuxWindows.includes('LTERMINAL_SMOKE_AUTO_EXIT=1') && files.linuxWindows.includes('smoke_token') && files.linuxWindows.includes('Frontend y terminal preparados') && files.linuxWindows.includes('timeout')],
    ['Build Windows cruzada localiza e instala WebView2 automáticamente', files.linuxWindows.includes('prepare_wine_webview2_prefix') && files.linuxWindows.includes('download_webview2_installer') && files.linuxWindows.includes('WEBVIEW2_INSTALL_URL') && files.linuxWindows.includes('LTERMINAL_WINE_WEBVIEW2_AUTO_INSTALL')],
    ['Build Windows cruzada propaga modo sin red', files.linuxWindows.includes('--allow-offline-checks') && files.linuxWindows.includes('LTERMINAL_LINK_CHECK=warn')],
    ['Build Windows cruzada admite repeticiones Wine', files.linuxWindows.includes('--wine-repeats') && files.linuxWindows.includes('WINE_REPEATS=3')],
    ['Build Windows cruzada ejecuta la batería Rust PE bajo Wine en modo completo', files.linuxWindows.includes('RUN_WINE_TESTS=1') && files.linuxWindows.includes('LTERMINAL_TEST_UNDER_WINE=1') && files.linuxWindows.includes('CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER=wine') && files.linuxWindows.includes('--test-threads=1')],
    ['Build Linux puede iniciar pruebas Windows cruzadas', files.linux.includes('--cross-windows') && files.linux.includes('build-windows.sh')],
    ['La build Linux propaga el perfil rápido a Windows cruzado', files.linux.includes('FAST_BUILD') && files.linux.includes('cross_args+=(--fast)')],
    ['Build Windows nativa copia WebView2Loader', files.windows.includes("@('WebView2Loader.dll')")],
    ['Build Windows nativa copia todos los recursos declarados', files.windows.includes('bundle.resources') && files.windows.includes('resourceCount') && files.windows.includes('Copy-Item $source $destination')],
    ['Cargo y Tauri publican el mismo binario wterminal', /\[\[bin\]\][\s\S]*?name\s*=\s*"wterminal"/.test(files.cargoManifest) && files.tauriConfig.includes('"mainBinaryName": "wterminal"')],
    ['Build Windows cruzada resuelve recursos desde src-tauri y bloquea escapes del proyecto', files.linuxWindows.includes('realpath -e -- "$TAURI_DIR/$source"') && files.linuxWindows.includes('"$PROJECT_ROOT"/*') && files.linuxWindows.includes("*'\\'*)") && files.linuxWindows.includes('cp "$resource_source" "$RELEASE_DIR/$destination"')],
    ['Build Windows cruzada permite avisos legales en la raíz declarados como ../', files.tauriConfig.includes('"../THIRD-PARTY-NOTICES.txt": "THIRD-PARTY-NOTICES.txt"')],
    ['Build Windows nativa encuentra WebView2Loader de Cargo', files.windows.includes('webview2-com-sys-') && files.windows.includes('out\\\\x64') && files.windows.includes('Get-ChildItem')],
    ['Windows importa el entorno MSVC completo antes de Cargo', files.windows.includes('VsDevCmd.bat') && files.windows.includes('$env:ComSpec') && files.windows.includes('/d /s /c') && files.windows.includes('&& set') && files.windows.includes("Test-Command 'cl.exe'")],
    ['Build Windows fija el directorio de trabajo y el log del smoke', files.windows.includes('-WorkingDirectory $distDir') && files.windows.includes('$env:LTERMINAL_LOG_FILE = $logPath')],
    ['Build Windows no corta la batería ante una sonda fallida', files.windows.includes('$failedProbes') && files.windows.includes('se continúa para no ocultar')],
    ['Build Windows fija el mismo log para smoke y E2E', files.windows.includes('$previousE2eLogFile') && files.windows.includes('$env:LTERMINAL_LOG_FILE = $logPath')],
    ['Build Windows deja el informe E2E en una ruta explícita', files.windows.includes('$env:LTERMINAL_SMOKE_REPORT') && files.windows.includes('wterminal-e2e-')],
    ['Build Windows rechaza un E2E sin informe pasado', files.windows.includes('Assert-E2eReport') && files.windows.includes("$report.status -ne 'passed'") && files.windows.includes('$report.logValidated -ne $true')],
    ['Build Windows no confunde el mensaje de éxito del verificador E2E con un fallo', files.windows.includes('$reportOutputFailed') && files.windows.includes('informe E2E (?:incompleto|no es|no valid') && files.windows.includes('Informe E2E verificado')],
    ['Build Windows exige las once fases antes de aceptar el E2E', files.windows.includes('$phases.Count -lt 11') && files.windows.includes('$events.Count -lt 11')],
    ['Linux y Windows rechazan informes E2E parciales', files.linux.includes('verify-e2e-report.mjs') && files.windows.includes('verify-e2e-report.mjs') && files.e2eReport.includes('pestañas, división y redimensionado') && files.e2eReport.includes("event?.type === 'ltools-ui-source'") && files.e2eReport.includes('multi-pane-minimum') && files.e2eReport.includes('tab-isolation')],
    ['E2E valida paneles útiles sin exigir que el compositor amplíe la ventana', files.smoke.includes('assertPaneGeometry') && files.smoke.includes('geometryValid: true') && !files.smoke.includes("'ampliación de la ventana al dividir'")],
    ['E2E Windows aísla su UDF y refleja el archivo para EdgeDriver', files.smoke.includes('E2E_WEBVIEW2_USER_DATA_FOLDER') && files.smoke.includes('webviewOptions = { userDataFolder: webviewUserDataFolder }') && files.smoke.includes("join(webviewUserDataFolder, 'EBWebView', 'DevToolsActivePort')") && files.smoke.includes('bridgeWebView2DevToolsActivePort')],
    ['Build Windows deja terminar el E2E antes de cerrar por sondas estrictas', e2eBlock >= 0 && strictProbeThrow > e2eBlock],
    ['Windows prepara WebView2 antes de generar NSIS', installerBlock >= 0 && installerBinaryBuild > installerBlock && installerLoaderPreparation > installerBinaryBuild && installerBundleBuild > installerLoaderPreparation],
    ['Windows rechaza un NSIS sin runtime offline', files.windows.includes('Length -lt 100MB') && files.windows.includes('runtime WebView2 offline')],
    ['Windows publica el instalador NSIS junto al ZIP y verifica la copia', files.windows.includes('WTerminal-$version$zipSuffix-x64-setup.exe') && files.windows.includes('Copy-Item -LiteralPath $installerPath.FullName -Destination $installerReleasePath') && files.windows.includes('La copia del instalador NSIS no coincide') && files.windows.includes('SHA256 instalador')],
    ['Windows conserva hashes de todas las variantes de release', files.windows.includes('scripts/update-release-hash.mjs') && files.windows.includes('$checksumManifest') && !files.windows.includes("Set-Content (Join-Path $releaseOut 'SHA256SUMS.txt')")],
    ['Windows permite diferir la firma explícitamente a un job publisher aislado y la exige por defecto en CI', files.windows.includes("$env:LTERMINAL_REQUIRE_SIGNING -match '^(1|true|yes)$'") && files.windows.includes("$env:CI -match '^(1|true|yes)$'") && files.windows.includes('LTERMINAL_REQUIRE_SIGNING')],
    ['Linux conserva artefactos y hashes de todas las variantes de release', files.linux.includes('scripts/update-release-hash.mjs') && files.linux.includes('No borres AppImage ni SHA256SUMS anteriores') && !files.linux.includes('rm -f "$RELEASE_DIR"/LTerminal-*.AppImage')],
    ['Linux publica AppImages mediante rename atómico para permitir actualizar una instancia abierta', files.linux.includes('scripts/publish-release-artifact.mjs') && files.releasePublish.includes('await rename(temporaryPath, destinationPath)') && !files.linux.includes('cp "$APPIMAGE" "$RELEASE_DIR/$RELEASE_NAME"')],
    ['El actualizador de hashes hace upsert por artefacto y escribe atómicamente', files.releaseHash.includes('fields[1].replace(/^\\*/, \'\') !== artifact') && files.releaseHash.includes('await rename(temporary, target)') && files.releaseHash.includes('kept.push(`${hash}  ${artifact}`)')],
    ['Windows puede iniciar pruebas Linux cruzadas', files.windows.includes('$CrossLinux') && files.windows.includes('Invoke-CrossLinuxTests')],
    ['Windows conserva el artefacto si la build WSL devuelve un código distinto de cero', crossLinuxBlock.includes("$code = Invoke-Native 'wsl.exe'") && crossLinuxBlock.includes('if ($code -ne 0)') && crossLinuxBlock.includes('Add-PostBuildIssue')],
    ['Windows propaga el perfil y exclusiones de tests a WSL', files.windows.includes('$linuxFlags') && files.windows.includes('if ($Fast)') && files.windows.includes('--no-extended-tests')],
    ['Windows instala WSL si falta', files.windows.includes('Microsoft.WSL') && files.windows.includes('--install') && files.windows.includes('Ubuntu')],
    ['Windows convierte la ruta del proyecto para WSL', files.windows.includes('wslpath') && files.windows.includes('wslRoot')],
    ['Windows ejecuta el build Linux completo dentro de WSL', files.windows.includes('--full-tests') && files.windows.includes('--install-e2e-driver') && files.windows.includes('wsl.exe')],
    ['WSL no puede quedarse esperando una versión', files.windows.includes('--non-interactive')],
    ['Smoke Linux valida el token y los hitos reales de arranque', files.linux.includes('LTERMINAL_SMOKE_TOKEN') && files.linux.includes('LTERMINAL_LOG_FILE') && files.linux.includes('pty spawneado') && files.linux.includes('Frontend y terminal preparados')],
    ['Smoke Linux se ejecuta en una sesión propia y se cierra al terminar', files.linux.includes('setsid env') && files.linux.includes('cleanup_smoke_process') && files.linux.includes('restore_version_manifests') && files.linux.includes('trap on_exit EXIT')],
    ['Smoke Linux tolera sondas frías lentas sin bloquear la interfaz', files.linux.includes('LTERMINAL_SMOKE_READY_TIMEOUT') && files.linux.includes('SMOKE_READY_TIMEOUT=45')],
    ['Smoke Linux fuerza una ejecución reproducible del AppImage', files.linux.includes('APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"')],
    ['Smoke Linux verifica el offset con runtimes clásicos en vez de ejecutar --appimage-version', files.linux.includes('--appimage-offset') && files.linux.includes('APPIMAGE_RUNTIME_OFFSET') && !files.linux.includes('$APPIMAGE --appimage-version')],
    ['Smoke Linux distingue el dispositivo FUSE ausente del helper instalado', files.linux.includes('[[ ! -c /dev/fuse ]]') && files.linux.includes('no valida el doble clic con montaje FUSE')],
    ['Linux fija el ajuste WebKit en el AppImage', files.linux.includes('GTK_HOOK') && files.linux.includes('WEBKIT_DISABLE_DMABUF_RENDERER')],
    ['Linux muestra tiempos por paso y tiempo total de build', files.linux.includes('BUILD_STARTED_SECONDS') && files.linux.includes('STEP_STARTED_SECONDS') && files.linux.includes('Tiempo del paso anterior') && files.linux.includes('Tiempo total')],
    ['Los limpiadores protegen release/ y no la borran como salida generada', cleanerPsDirectories.includes("'node_modules'") && cleanerPsDirectories.includes("'src-tauri/target/dist/release-anterior'") && cleanerShDirectories.includes('node_modules') && cleanerShDirectories.includes('src-tauri/target/dist/release-anterior') && files.cleanerPs1.includes('$ReleaseRoots') && files.cleanerPs1.includes('pertenece a release/:') && !cleanerPsDirectories.includes("'release'") && !cleanerPsDirectories.includes("'releases'") && files.cleanerSh.includes('release_root') && !files.cleanerSh.includes('releases_root') && files.cleanerSh.includes('Ruta protegida (release/)') && !cleanerShDirectories.includes(' release') && !cleanerShDirectories.includes(' releases')],
    ['El limpiador Windows cubre temporales E2E, logs AppData y cachés privadas', files.cleanerPs1.includes('winslim-terminal-e2e-captures-*') && files.cleanerPs1.includes('winslim-terminal-webview2-e2e-*') && files.cleanerPs1.includes("Join-Path $dataRoot 'logs'") && files.cleanerPs1.includes("'appimage'" ) && files.cleanerPs1.includes('activePids')],
    ['El limpiador Linux cubre temporales E2E, logs y cachés sin tocar Tauri global', files.cleanerSh.includes('lterminal-e2e-report.*') && files.cleanerSh.includes('config_root/lterminal') && files.cleanerSh.includes('cache_root/lterminal') && files.cleanerSh.includes('caché global de') && files.cleanerSh.includes('kill -0')],
    ['Los limpiadores cubren temporales de build con nombre propio y filtran extracciones AppImage por identidad y actividad', files.cleanerSh.includes('lterminal-version-backup.*') && files.cleanerSh.includes('lterminal-build-smoke.*') && files.cleanerSh.includes('lterminal-release-audit-captures.*') && files.cleanerSh.includes('appimage_extraction_has_live_process') && files.cleanerSh.includes('usr/share/applications/LTerminal.desktop') && files.cleanerPs1.includes('lterminal-version-backup.*') && files.cleanerPs1.includes('lterminal-build-smoke.*') && files.cleanerPs1.includes('lterminal-release-audit-captures.*') && files.cleanerPs1.includes('Test-LiveProcessInDirectory') && files.cleanerPs1.includes('usr/share/applications/LTerminal.desktop')],
    ['PowerShell normaliza separadores finales de rutas Unix y Windows', files.cleanerPs1.includes('Get-NormalizedDirectoryPath') && files.cleanerPs1.includes('[char]47') && files.cleanerPs1.includes('[char]92')],
    ['Los limpiadores clasifican el staging de node_modules Windows como salida del proyecto', files.cleanerSh.includes('for candidate in "$project_root"/.node_modules.windows.*') && files.cleanerSh.includes('add_project_directory "$candidate"') && !files.cleanerSh.slice(files.cleanerSh.indexOf('external_targets=()')).includes('"$project_root"/.node_modules.windows.*') && files.cleanerPs1.includes('.node_modules.windows.*')],
    ['Los limpiadores no siguen enlaces simbólicos ni junctions al borrar salidas', files.cleanerSh.includes('IFS=\'/\' read -r -a path_parts') && files.cleanerSh.includes('external_target_has_symlink_parent') && files.cleanerSh.includes('[[ -L "$ancestor" ]]') && files.cleanerPs1.includes('[IO.FileAttributes]::ReparsePoint') && files.cleanerPs1.includes('Test-ExternalPathHasReparseParent') && files.cleanerPs1.includes('Remove-DirectoryTreeSafely')],
    ['Los limpiadores tienen un modo ligero que conserva dependencias y conocen los restos actuales de WTerminal', files.cleanerSh.includes('--light') && files.cleanerSh.includes('--keep-days') && files.cleanerSh.includes('src-tauri/target/dist/release-anterior') && files.cleanerSh.includes('wterminal-e2e-*') && files.cleanerSh.includes('"$temp_root/wterminal"') && files.cleanerPs1.includes('[switch]$Light') && files.cleanerPs1.includes('$KeepDays') && files.cleanerPs1.includes("'src-tauri/target/dist/release-anterior'") && files.cleanerPs1.includes("'wterminal-e2e-*'") && files.cleanerPs1.includes("(Join-Path $TempRoot 'wterminal')") && files.cleanerPs1.includes('DoNotExpandEnvironmentNames') && files.cleanerTest.includes("'--light', '--keep-days', '3', '--apply'")],
    ['La regresión del limpiador protege release/ en Bash y PowerShell', files.package.includes('"test:cleaner": "node scripts/test-clean-repository.mjs"') && files.package.includes('package-scripts.mjs run test:cleaner') && files.cleanerTest.includes("await symlink(source, join(project, 'dist'), 'dir')") && files.cleanerTest.includes("await symlink(externalData, join(config, 'winslim-terminal'), 'dir')") && !files.cleanerTest.includes('releases/') && files.cleanerTest.includes('PowerShell conserva release/') && files.cleanerTest.includes('el destino del enlace no se borra') && files.cleanerTest.includes('no se atraviesa el enlace de la carpeta de configuración')],
    ['El E2E detecta espacios duplicados por keypress y prueba unidades de rueda', files.smoke.includes("const spaceProbe = 'space probe  keeps columns'") && files.smoke.includes("recordEvent('space-input-length'") && files.smoke.includes('WheelEvent.DOM_DELTA_LINE') && files.smoke.includes('WheelEvent.DOM_DELTA_PAGE')],
    ['Linux valida el binario opcional de esbuild como archivo ejecutable, sin importarlo como módulo', files.linux.includes('linux_native_dependencies_ready') && files.linux.includes('@rollup/rollup-linux-x64-gnu') && files.linux.includes("require.resolve('@esbuild/linux-x64/bin/esbuild')") && files.linux.includes('constants.X_OK') && !files.linux.includes("require('@esbuild/linux-x64')")],
    ['Linux aísla node_modules Windows y lo restaura al terminar', files.linux.includes('NODE_MODULES_RESTORE') && files.linux.includes('restore_node_modules') && files.linux.includes('@tauri-apps/cli-win32-x64-msvc') && files.linux.includes('trap on_exit EXIT')],
    ['La cross-build Windows acepta modo no interactivo', files.linuxWindows.includes('--non-interactive') && files.linuxWindows.includes('NON_INTERACTIVE')],
    ['La cross-build Windows permite fijar la versión antes de compilar', files.linuxWindows.includes('--version') && files.linuxWindows.includes('CURRENT_VERSION') && files.linuxWindows.includes('set-package-version.mjs') && files.linuxWindows.includes('Versión seleccionada')],
    ['Linux propaga errores de restauración aunque la build hubiera terminado bien', files.linux.includes('Falta la copia de seguridad del manifiesto') && files.linux.includes('exit 1') && files.linux.includes('cmp -s') && files.linux.includes('trap on_exit EXIT')],
    ['Windows cruzado propaga errores de restauración aunque la build hubiera terminado bien', files.linuxWindows.includes('Falta la copia de seguridad del manifiesto') && files.linuxWindows.includes('exit 1') && files.linuxWindows.includes('cmp -s') && files.linuxWindows.includes('trap on_exit EXIT')],
    ['Windows nativo detecta copias ausentes y restaura también al salir por error', files.windows.includes('falta la copia de seguridad') && files.windows.includes('No está disponible la copia de seguridad de los manifiestos') && files.windows.includes('Backup-VersionManifests') && files.windows.includes('Restore-VersionManifests') && files.windows.includes('finally')],
    ['Wine usa smoke headless por defecto y valida GUI optativa con display sano y captura visible', files.linuxWindows.includes('[ "${LTERMINAL_WINE_GUI_SMOKE:-0}" = "1" ] || headless_smoke=1') && files.linuxWindows.includes('LTERMINAL_WINE_HEADLESS_SMOKE=1') && files.linuxWindows.includes('Smoke headless Wine') && files.linuxWindows.includes('timeout 5 xdpyinfo') && files.linuxWindows.includes('wine-gui-smoke.sh') && files.wineGuiSmoke.includes('xdotool search --onlyvisible --name') && files.wineGuiSmoke.includes('WINE_GUI_CAPTURE_OK=') && files.wineGuiSmoke.includes("value >= 0.10")],
    ['Wine headless valida el backend de sesión del ejecutable Windows', files.linuxWindows.includes("'Smoke Wine headless completado'") && files.linuxWindows.includes("'pty spawneado'") && files.linuxWindows.includes('LTERMINAL_TEST_UNDER_WINE=1')],
    ['La batería PE bajo Wine usa el prefijo aislado compartido con el smoke', wineRustBlock.includes('WINE_SMOKE_PREFIX:-${WINEPREFIX:-$HOME/.cache/lterminal/wine-smoke-prefix}') && wineRustBlock.includes('mkdir -p "$wine_test_prefix"') && wineRustBlock.includes('WINEPREFIX="$wine_test_prefix"') && wineRustBlock.includes('cargo test')],
    ['La regresión de versión fuerza fallos de build y de restauración y compara manifiestos', files.package.includes('test:version-restore') && files.versionRestore.includes('LTERMINAL_TEST_FAIL_AFTER_VERSION') && files.versionRestore.includes('LTERMINAL_TEST_REMOVE_VERSION_BACKUP') && files.versionRestore.includes('LTERMINAL_TEST_EXIT_AFTER_VERSION') && files.versionRestore.includes('assert.deepEqual(snapshot(), before')],
    ['La regresión de versión corre en check:local y check y restaura el checkout si falla', [...files.package.matchAll(/package-scripts\.mjs run test:version-restore/g)].length >= 2 && files.versionRestore.includes("process.platform === 'win32' ? 90_000 : 20_000") && [...files.versionRestore.matchAll(/timeout: childTimeoutMs/g)].length === 2 && files.versionRestore.includes('if (!existsSync(path) || !readFileSync(path).equals(contents)) writeFileSync(path, contents)') && files.versionRestore.includes("console.log('SKIP: pruebas de scripts Bash")],
    ['El E2E simula Shift+rueda y exige preventDefault', files.smoke.includes("new WheelEvent('wheel'") && files.smoke.includes('shiftKey: true') && files.smoke.includes('defaultPrevented')],
    ['La cross-build Windows valida SemVer antes de comprobar dependencias', files.linuxWindows.includes('La versión indicada no es SemVer válida') && files.linuxWindows.indexOf('La versión indicada no es SemVer válida') < files.linuxWindows.indexOf('ensure_node_and_rust')],
    ['Linux usa Zstandard, requerido por el mksquashfs integrado en linuxdeploy, y rechaza configuraciones incompatibles antes del empaquetado', files.linux.includes('APPIMAGE_COMP="${LTERMINAL_APPIMAGE_COMP:-zstd}"') && files.linux.includes('APPIMAGE_COMP" != "zstd"') && files.linux.includes('linuxdeploy requiere LTERMINAL_APPIMAGE_COMP=zstd') && files.linux.includes('LDAI_COMP="$APPIMAGE_COMP"')],
    ['Linux selecciona/cacha un runtime type2 compatible con Zstandard y permite overrides explícitos', files.linux.includes('runtime-$APPIMAGE_ARCH-zstd') && files.linux.includes('type2-runtime/releases/download/continuous/runtime-$APPIMAGE_ARCH') && files.linux.includes('LTERMINAL_APPIMAGE_RUNTIME') && files.linux.includes('LTERMINAL_APPIMAGE_POST_COMP')],
    ['El hook GTK elige Wayland solo si el socket vive y conserva fallback X11/override; el parche es idempotente', files.linux.includes('patch-appimage-gtk-hook.mjs') && patchedGtkHook.includes('export GDK_BACKEND=wayland') && patchedGtkHook.includes('export GDK_BACKEND=x11') && patchedGtkHook.includes('LTERMINAL_GDK_BACKEND') && !patchedGtkHook.includes('export GDK_BACKEND=x11 # generated upstream hook') && patchGtkHook(patchedGtkHook) === patchedGtkHook],
    ['El modo terminal limpio oculta/restaura las decoraciones nativas en carga, guardado, reset y recarga', files.appApi.includes('setWindowDecorations(visible: boolean)') && files.appState.includes('await this.syncWindowDecorations(prefs.preferences)') && files.appState.includes('await this.syncWindowDecorations(after, before)') && files.appState.includes('await this.syncWindowDecorations(payload.preferences, before)') && files.appState.includes('await this.syncWindowDecorations(payload.preferences, this.preferences)') && files.capabilities.includes('core:window:allow-set-decorations')],
    ['Linux detecta la versión de linuxdeploy aunque informe por stderr y actualiza RELR si hace falta', files.linux.includes('--version 2>&1 || true') && files.linux.includes('LINUXDEPLOY_CACHE') && files.linux.includes('LINUXDEPLOY_BUILD') && files.linux.includes('linuxdeploy-x86_64.AppImage') && files.linux.includes('LTERMINAL_APPIMAGE_NO_STRIP')],
    ['Linux valida AppStream y evita la heurística de nombre del empaquetador', files.linux.includes('LDAI_NO_APPSTREAM') && files.linux.includes('appstreamcli validate --no-net') && files.linux.includes('--no-appstream')],
    ['Linux conserva stripping por defecto', files.linux.includes('unset NO_STRIP') && files.linux.includes('LTERMINAL_APPIMAGE_NO_STRIP')],
    ['Linux evita la copia conflictiva de GIO TLS', files.linux.includes('libgiognutls.so') && files.linux.includes('rm -f "$APPDIR/usr/lib/gio/modules/libgiognutls.so"')],
    ['Smoke Windows valida el token de arranque y evita perderlo al elevar por UAC', files.windows.includes('$smokeToken') && files.windows.includes("$env:LTERMINAL_E2E_DISABLE_ADMIN = '1'") && files.windows.includes('$previousDisableAdmin')],
    ['Smoke Windows no registra su ejecutable portable en el PATH persistente', files.windows.includes("$env:LTERMINAL_E2E_DISABLE_PATH_AUTO = '1'") && files.windows.includes('$previousDisablePathAuto') && files.smoke.includes('LTERMINAL_E2E_DISABLE_PATH_AUTO')],
    ['El portable es un único .exe que arranca sin extraer: la build lo verifica y pasa el E2E completo con él solo en una carpeta vacía', files.windows.includes("Join-Path $script:BuildTempDir 'single-file-e2e'") && files.windows.includes("'scripts/create-single-file-portable.mjs', '--verify', $portableAlone, '--input', $distDir") && files.windows.includes('$env:E2E_BINARY = $portableAlone') && files.windows.includes("$env:E2E_EXPECT_SINGLE_FILE = '1'") && files.windows.includes('El portable dejó archivos junto a sí') && files.smoke.includes('ConPTY del portable de un solo archivo listo') && !files.windows.includes('sfx-e2e-payload') && !/7z\.sfx|RunProgram=/u.test(files.singleFilePortable)],
    ['Smoke Windows admite Wine y Proton en entornos aislados', files.linuxWindows.includes('LTERMINAL_WINE_RUNNER') && files.linuxWindows.includes('LTERMINAL_PROTON') && files.linuxWindows.includes('STEAM_COMPAT_DATA_PATH') && files.linuxWindows.includes('tracked_files')],
    ['Smoke Windows exige el marcador de éxito y deja margen al arranque asíncrono del PTY', files.windows.includes('function Test-SmokeReady') && files.windows.includes('sessionMatch') && files.windows.includes('Frontend y terminal preparados') && files.windows.includes('$attempt -lt 45') && !files.windows.includes("notmatch 'Frontend preparado pero sin sesión PTY'")],
    ['Los tests Windows bajo Wine toleran compilaciones frías y explican el timeout', files.linuxWindows.includes('LTERMINAL_WINE_TEST_TIMEOUT:-1800') && files.linuxWindows.includes('superó ${timeout_seconds}s')],
    ['Windows aísla las descargas y usa un runtime LTS compatible en un temporal propio', files.windows.includes('wterminal-build-$PID-') && files.windows.includes("$nodeFallbackVersion = '22.22.2'") && files.windows.includes('node-v$nodeFallbackVersion-x64.msi') && files.windows.includes("Join-Path $script:BuildTempDir 'rustup-init.exe'") && files.windows.includes('Remove-Item -LiteralPath $script:BuildTempDir -Recurse -Force') && files.cleanerPs1.includes("'winslim-terminal-build-*'") && files.cleanerSh.includes('winslim-terminal-build-*')],
    ['Linux valida que la sesión gráfica sea accesible', files.linux.includes('graphical_session_available') && files.linux.includes('xdpyinfo')],
    ['Linux elimina binarios cruzados antes de empaquetar', files.linux.includes('com.winslim.terminal') && files.linux.includes('stale_binary')],
    ['Linux limpia metadata cruzada del AppDir antes de empaquetar', files.linux.includes('STALE_APPDIR') && files.linux.includes('stale_appdir_file') && files.linux.includes('com.winslim.terminal.metainfo.xml')],
    ['Linux limpia metadata cruzada también durante la recuperación', files.linux.includes('APPDIR_RECOVERY/usr/share/metainfo/com.winslim.terminal.metainfo.xml')],
    ['Linux limpia el staging appimage_deb cruzado', files.linux.includes('appimage_deb') && files.linux.includes('BUNDLE_OUTPUT')],
    ['Linux valida el ejecutable y desktop del AppDir', files.linux.includes('APPDIR/usr/bin/lterminal') && files.linux.includes("LTerminal.desktop")],
    ['Los fallos Linux muestran log', files.linux.includes('tail -n 80')],
    ['Los fallos Windows muestran log', files.windows.includes('Get-Content $Path -Tail') && files.windows.includes('Show-SmokeDiagnostics $logPath $smokeToken')],
    ['La prueba E2E exige un binario', files.smoke.includes('E2E_BINARY')],
    ['La prueba de host comprueba Git', files.host.includes('probe Git')],
    ['Perfil Linux detecta la aplicación', files.profileSh.includes('find_existing_app')],
    ['Perfil Linux valida el sistema operativo', files.profileSh.includes('necesita Linux')],
    ['Perfil Linux instala desde GitHub', files.profileSh.includes('releases/latest')],
    ['Perfil Linux entrega --import-profile', files.profileSh.includes('--import-profile')],
    ['Perfil Linux usa su nombre de archivo', files.profileSh.includes('LTerminal-profile.lterminal-profile')],
    ['Perfil Windows detecta la aplicación', files.profilePs1.includes('Find-Terminal')],
    ['Perfil Windows valida el sistema operativo', files.profilePs1.includes('necesita Windows')],
    ['Perfil Windows instala desde la API oficial HTTPS de GitHub', sourceHasHttpsEndpoint(files.profilePs1, 'api.github.com', /^\/repos\/\$ProfileRepository\/releases\/latest$/)],
    ['Perfil Windows entrega --import-profile', files.profilePs1.includes('--import-profile')],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
    throw new Error(`Comprobaciones de scripts de build fallidas:\n- ${failures.join('\n- ')}`);
}

console.log(`Scripts de build verificados (${checks.length} comprobaciones).`);
