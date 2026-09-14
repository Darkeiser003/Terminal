import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const files = {
    linux: await readFile(resolve(root, 'linux/build.sh'), 'utf8'),
    linuxWindows: await readFile(resolve(root, 'linux/build-windows.sh'), 'utf8'),
    windows: await readFile(resolve(root, 'windows/build.ps1'), 'utf8'),
    windowsBat: await readFile(resolve(root, 'windows/build.bat'), 'utf8'),
    winget: await readFile(resolve(root, 'scripts/verify-winget-catalog.mjs'), 'utf8'),
    host: await readFile(resolve(root, 'linux/exercise-host.sh'), 'utf8'),
    smoke: await readFile(resolve(root, 'tests/e2e/smoke.mjs'), 'utf8'),
    e2eReport: await readFile(resolve(root, 'scripts/verify-e2e-report.mjs'), 'utf8'),
    package: await readFile(resolve(root, 'package.json'), 'utf8'),
    links: await readFile(resolve(root, 'scripts/verify-links.mjs'), 'utf8'),
    profileSh: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.sh.in'), 'utf8'),
    profilePs1: await readFile(resolve(root, 'src-tauri/resources/profile-bootstrap.ps1.in'), 'utf8'),
    releaseHash: await readFile(resolve(root, 'scripts/update-release-hash.mjs'), 'utf8'),
    cargoBuild: await readFile(resolve(root, 'src-tauri/build.rs'), 'utf8'),
    cleanerPs1: await readFile(resolve(root, 'scripts/clean-repository.ps1'), 'utf8'),
    cleanerSh: await readFile(resolve(root, 'scripts/clean-repository.sh'), 'utf8'),
    cleanerTest: await readFile(resolve(root, 'scripts/test-clean-repository.mjs'), 'utf8'),
    versionRestore: await readFile(resolve(root, 'scripts/test-version-restore.mjs'), 'utf8'),
    menuSh: await readFile(resolve(root, 'build-tools/build.sh'), 'utf8'),
    menuPs1: await readFile(resolve(root, 'build-tools/build.ps1'), 'utf8'),
    gitSigning: await readFile(resolve(root, 'build-tools/configure-git-signing.sh'), 'utf8'),
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
const cleanerPsDirectories = files.cleanerPs1.slice(
    files.cleanerPs1.indexOf('$generatedDirectories = @('),
    files.cleanerPs1.indexOf(')\n\n$directoryTargets', files.cleanerPs1.indexOf('$generatedDirectories = @(')),
)
const cleanerShDirectories = files.cleanerSh.slice(
    files.cleanerSh.indexOf('generated_directories=('),
    files.cleanerSh.indexOf(')\n\nassert_project_target', files.cleanerSh.indexOf('generated_directories=(')),
)
const wineRustStart = files.linuxWindows.indexOf('run_wine_rust_tests() {');
const wineRustEnd = files.linuxWindows.indexOf('\nwebview2_registry_key()', wineRustStart);
const wineRustBlock = wineRustStart >= 0 && wineRustEnd > wineRustStart
    ? files.linuxWindows.slice(wineRustStart, wineRustEnd)
    : '';

const checks = [
    ['El menú Linux reúne desarrollo, builds, pruebas, smoke y limpieza', ['Desarrollo y preview', 'Compilar', 'Pruebas y smoke sin recompilar', 'Limpiar cachés', 'linux/build.sh', 'linux/build-windows.sh', 'linux/validate-release.sh', 'scripts/clean-repository.sh'].every((marker) => files.menuSh.includes(marker))],
    ['La firma de commits se configura de forma explícita, local y separada de las builds', files.menuSh.includes('--setup-git-signing') && files.menuSh.includes('Configurar firma SSH de commits para GitHub') && files.gitSigning.includes('git config --local') && files.gitSigning.includes('commit.gpgsign true') && files.gitSigning.includes('Key type: Signing key') && files.gitSigning.includes('no sube')],
    ['El menú ofrece builds completas, rápidas y validación cruzada extensa con nombres orientados al resultado', ['AppImage Linux (release completa)', 'AppImage Linux (iteración rápida)', 'aplicación portable Windows desde Linux', 'suite Rust bajo Wine', '--full-tests', '--wine-repeats', '--cross-windows', '--no-extended-tests', '--skip-checks'].every((marker) => files.menuSh.includes(marker))],
    ['El menú puede validar el binario Linux existente correcto sin recompilarlo', files.menuSh.includes('E2E_BINARY="$binary"') && files.menuSh.includes('npm run e2e') && files.menuSh.includes('linux/validate-release.sh') && files.menuSh.includes('$ROOT/src-tauri/target/release/winslim-terminal')],
    ['El menú PowerShell ofrece las mismas categorías, builds nativas y pruebas Wine', ['Desarrollo y preview', 'Compilar', 'Pruebas y smoke sin recompilar', 'Limpiar cachés', 'windows/build.ps1', 'linux/build.sh', 'linux/build-windows.sh', 'suite Rust bajo Wine', '--full-tests', '--wine-repeats', 'scripts/clean-repository.ps1', "src-tauri/target/release/winslim-terminal"].every((marker) => files.menuPs1.includes(marker)) && !files.menuPs1.includes('$IsWindows')],
    ['Los menús usan la versión del proyecto sin volver a abrir el cuestionario del builder', files.menuSh.includes('--non-interactive') && files.menuPs1.includes('-NonInteractive')],
    ['Los menús de build verifican dependencias antes de ejecutarlas', files.menuSh.includes('¿Permitir instalar automáticamente dependencias') && files.menuPs1.includes('¿Continuar?')],
    ['Los menús bloquean la limpieza si falla la vista previa', files.menuSh.includes('RUN_ACTION_STATUS=$status') && files.menuSh.includes('preview_status="$RUN_ACTION_STATUS"') && files.menuSh.includes('La vista previa falló; se cancela la limpieza') && files.menuPs1.includes('$script:LastMenuActionStatus = $exitCode') && files.menuPs1.includes('$script:LastMenuActionStatus = 1') && files.menuPs1.includes('if ($script:LastMenuActionStatus -ne 0)')],
    ['Los menús bloquean la limpieza si falla la vista previa', files.menuSh.includes('RUN_ACTION_STATUS=$status') && files.menuSh.includes('preview_status="$RUN_ACTION_STATUS"') && files.menuSh.includes('La vista previa falló; se cancela la limpieza') && files.menuPs1.includes('$script:LastMenuActionStatus = $exitCode') && files.menuPs1.includes('$script:LastMenuActionStatus = 1') && files.menuPs1.includes('if ($script:LastMenuActionStatus -ne 0)')],
    ['Cargo invalida el ejecutable cuando cambia el frontend incrustado', files.cargoBuild.includes('cargo:rerun-if-changed=../dist/index.html')],
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
    ['Linux rechaza Git Bash/MSYS como builder Windows y dirige al script nativo', files.linux.includes('MINGW*|MSYS*|CYGWIN*') && files.linux.includes('windows\\\\build.ps1') && files.linux.includes('linux/build.sh solo compila la release Linux')],
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
    ['Windows ejecuta tests ampliados por defecto salvo exclusión explícita', files.windows.includes('$runExtendedTests') && files.windows.includes('$NoExtendedTests') && files.windows.includes('activada por defecto') && !files.windows.includes('Read-Host \'¿Ejecutar también')],
    ['Los probes REPL de Windows sobreviven al entrecomillado de PowerShell 5.1', files.windows.includes("print('LTERMINAL_REPL_OK')") && files.windows.includes("puts 'LTERMINAL_REPL_OK'") && files.windows.includes("echo 'LTERMINAL_REPL_OK';") && !files.windows.includes("'print(\"LTERMINAL_REPL_OK\")'")],
    ['Los probes REPL exigen salida real además del código cero', files.windows.includes('[switch]$CaptureOutput') && files.windows.includes("Expect = 'LTERMINAL_REPL_OK'") && files.windows.includes('no produjo el marcador esperado')],
    ['La sonda de Windows Terminal no abre su diálogo gráfico', files.windows.includes("Detect = 'wt.exe'") && files.windows.includes('$wt.FileVersionInfo.ProductVersion') && !files.windows.includes("Exe = 'wt.exe'; Args = @('--version')")],
    ['Un alias WindowsApps roto se clasifica como ausente sin abortar la batería', files.windows.includes('return 9009') && files.windows.includes('$probeCode -eq 9009') && files.windows.includes('su ejecutable real no está disponible')],
    ['FullTests no exige instalar todo el catálogo y StrictTests sí', files.windows.includes('$StrictTests.IsPresent -and $missingProbes.Count -gt 0') && files.windows.includes('$strictExtendedTests -and $failedProbes.Count -gt 0')],
    ['Windows ofrece modo rápido explícito y evita combinaciones ambiguas', files.windows.includes('$NoExtendedTests') && files.windows.includes('no se puede combinar') && files.package.includes('dist:win:fast') && files.package.includes('-NoExtendedTests')],
    ['El comando de release Windows ejecuta la batería completa', files.package.includes('dist:win') && files.package.includes('-FullTests')],
    ['Windows conserva una ruta rápida explícita', files.package.includes('dist:win:fast') && files.package.includes('windows/build.ps1 -NoRun -NonInteractive -NoExtendedTests')],
    ['Windows ofrece perfil release comprimido y desarrollo rápido', files.windows.includes('[switch]$Fast') && files.windows.includes('CARGO_PROFILE_RELEASE_LTO') && files.windows.includes('CARGO_PROFILE_RELEASE_INCREMENTAL') && files.windows.includes('WinSlimTerminal-$version$distSuffix') && files.windows.includes('WinSlimTerminal-Unpacked-$version$zipSuffix.zip') && files.package.includes('-Fast')],
    ['El lanzador BAT documenta el perfil rápido', files.windowsBat.includes('build.bat -Fast')],
    ['Windows cruzado ofrece perfil de desarrollo rápido', files.linuxWindows.includes('--fast') && files.linuxWindows.includes('CARGO_PROFILE_RELEASE_LTO=false') && files.package.includes('dist:win:linux:fast')],
    ['Windows cruzado desde Linux publica la carpeta y el ZIP en release/ o release/dev', files.linuxWindows.includes('package-windows-cross.mjs') && files.linuxWindows.includes('WinSlimTerminal-$VERSION_OVERRIDE$release_suffix') && files.linuxWindows.includes('WinSlimTerminal-Unpacked-$VERSION_OVERRIDE$release_suffix.zip') && files.linuxWindows.includes('release_out="$release_out/dev"')],
    ['La publicación Windows cruzada valida runtime, ZIP, hashes y firma antes de informar rutas', files.linuxWindows.includes('ensure_zip') && files.linuxWindows.includes('verify-release-artifacts.mjs') && files.linuxWindows.includes('sign-release-manifest.mjs') && files.linuxWindows.includes('Manifiesto de la release Windows firmado y verificado')],
    ['Los comandos npm rápidos omiten las fases caras de forma explícita', files.package.includes('dist:win:fast') && files.package.includes('-SkipChecks') && files.package.includes('dist:linux:fast') && files.package.includes('--no-extended-tests') && files.package.includes('dist:win:linux:fast') && files.package.includes('--skip-checks')],
    ['Windows ofrece instalador offline de WebView2', files.windows.includes('$Installer') && files.windows.includes('tauri.windows.installer.conf.json') && files.windows.includes('bundle\\nsis')],
    ['Windows instala automáticamente tauri-driver cuando E2E lo necesita', files.windows.includes('se instalará automáticamente con cargo') && !files.windows.includes("-and $InstallE2eDriver -and") && files.windows.includes('tauri-driver no apareció en PATH')],
    ['Windows prepara Edge WebDriver compatible sin exigir Microsoft Edge', files.windows.includes('Get-WebView2RuntimeVersion') && sourceHasHttpsEndpoint(files.windows, 'msedgedriver.microsoft.com', /^\/LATEST_RELEASE_[^/]+_WINDOWS$/) && sourceHasHttpsEndpoint(files.windows, 'msedgedriver.microsoft.com', /^\/[^/]+\/edgedriver_[^/]+\.zip$/) && files.windows.includes('sin instalar Microsoft Edge') && files.windows.includes('$env:TAURI_NATIVE_DRIVER = $nativeE2eDriver')],
    ['Linux puede lanzar E2E', files.linux.includes('npm run e2e')],
    ['Linux publica el AppImage aunque falle el E2E y deja diagnóstico final', files.linux.includes('if ! APPIMAGE_EXTRACT_AND_RUN=') && files.linux.includes('TAURI_NATIVE_DRIVER=') && files.linux.includes('post_build_issue "E2E falló') && files.linux.includes('POST_BUILD_FAILURE')],
    ['E2E Linux pasa el driver nativo', files.linux.includes('TAURI_NATIVE_DRIVER=')],
    ['Windows puede lanzar E2E', files.windows.includes("@('run', 'e2e')")],
    ['Windows automatiza la propia release sin recompilar un segundo perfil', files.windows.includes('$env:E2E_BINARY = Join-Path $distDir') && !files.windows.includes("@('run', 'e2e:build')")],
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
    ['Build Windows cruzada copia los recursos declarados por el manifiesto', files.linuxWindows.includes('tauri.conf.json') && files.linuxWindows.includes('Object.entries(resources)') && files.linuxWindows.includes('cp "$PROJECT_ROOT/$resource"')],
    ['Build Windows nativa encuentra WebView2Loader de Cargo', files.windows.includes('webview2-com-sys-') && files.windows.includes('out\\\\x64') && files.windows.includes('Get-ChildItem')],
    ['Windows importa el entorno MSVC completo antes de Cargo', files.windows.includes('VsDevCmd.bat') && files.windows.includes('$env:ComSpec') && files.windows.includes('/d /s /c') && files.windows.includes('&& set') && files.windows.includes("Test-Command 'cl.exe'")],
    ['Build Windows fija el directorio de trabajo y el log del smoke', files.windows.includes('-WorkingDirectory $distDir') && files.windows.includes('$env:LTERMINAL_LOG_FILE = $logPath')],
    ['Build Windows no corta la batería ante una sonda fallida', files.windows.includes('$failedProbes') && files.windows.includes('se continúa para no ocultar')],
    ['Build Windows fija el mismo log para smoke y E2E', files.windows.includes('$previousE2eLogFile') && files.windows.includes('$env:LTERMINAL_LOG_FILE = $logPath')],
    ['Build Windows deja el informe E2E en una ruta explícita', files.windows.includes('$env:LTERMINAL_SMOKE_REPORT') && files.windows.includes('winslim-terminal-e2e-')],
    ['Build Windows rechaza un E2E sin informe pasado', files.windows.includes('Assert-E2eReport') && files.windows.includes("$report.status -ne 'passed'") && files.windows.includes('$report.logValidated -ne $true')],
    ['Build Windows no confunde el mensaje de éxito del verificador E2E con un fallo', files.windows.includes('$reportOutputFailed') && files.windows.includes('informe E2E (?:incompleto|no es|no valid') && files.windows.includes('Informe E2E verificado')],
    ['Build Windows exige las once fases antes de aceptar el E2E', files.windows.includes('$phases.Count -lt 11') && files.windows.includes('$events.Count -lt 11')],
    ['Linux y Windows rechazan informes E2E parciales', files.linux.includes('verify-e2e-report.mjs') && files.windows.includes('verify-e2e-report.mjs') && files.e2eReport.includes('pestañas, división y redimensionado') && files.e2eReport.includes('showQuickActions') && files.e2eReport.includes('multi-pane-minimum') && files.e2eReport.includes('tab-isolation')],
    ['E2E valida paneles útiles sin exigir que el compositor amplíe la ventana', files.smoke.includes('assertPaneGeometry') && files.smoke.includes('geometryValid: true') && !files.smoke.includes("'ampliación de la ventana al dividir'")],
    ['E2E Windows aísla su UDF y refleja el archivo para EdgeDriver', files.smoke.includes('E2E_WEBVIEW2_USER_DATA_FOLDER') && files.smoke.includes('webviewOptions = { userDataFolder: webviewUserDataFolder }') && files.smoke.includes("join(webviewUserDataFolder, 'EBWebView', 'DevToolsActivePort')") && files.smoke.includes('bridgeWebView2DevToolsActivePort')],
    ['Build Windows deja terminar el E2E antes de cerrar por sondas estrictas', e2eBlock >= 0 && strictProbeThrow > e2eBlock],
    ['Windows prepara WebView2 antes de generar NSIS', installerBlock >= 0 && installerBinaryBuild > installerBlock && installerLoaderPreparation > installerBinaryBuild && installerBundleBuild > installerLoaderPreparation],
    ['Windows rechaza un instalador NSIS truncado', files.windows.includes('Length -lt 1MB') && files.windows.includes('instalador NSIS parece incompleto')],
    ['Windows publica el instalador NSIS junto al ZIP y verifica la copia', files.windows.includes('WinSlimTerminal-$version$zipSuffix-x64-setup.exe') && files.windows.includes('Copy-Item -LiteralPath $installerPath.FullName -Destination $installerReleasePath') && files.windows.includes('La copia del instalador NSIS no coincide') && files.windows.includes('SHA256 instalador')],
    ['Windows conserva hashes de todas las variantes de release', files.windows.includes('scripts/update-release-hash.mjs') && files.windows.includes('$checksumManifest') && !files.windows.includes("Set-Content (Join-Path $releaseOut 'SHA256SUMS.txt')")],
    ['Windows permite diferir la firma explícitamente a un job publisher aislado y la exige por defecto en CI', files.windows.includes("$env:LTERMINAL_REQUIRE_SIGNING -match '^(1|true|yes)$'") && files.windows.includes("$env:CI -match '^(1|true|yes)$'") && files.windows.includes('LTERMINAL_REQUIRE_SIGNING')],
    ['Linux conserva artefactos y hashes de todas las variantes de release', files.linux.includes('scripts/update-release-hash.mjs') && files.linux.includes('No borres AppImage ni SHA256SUMS anteriores') && !files.linux.includes('rm -f "$RELEASE_DIR"/LTerminal-*.AppImage')],
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
    ['Linux fija el ajuste WebKit en el AppImage', files.linux.includes('GTK_HOOK') && files.linux.includes('WEBKIT_DISABLE_DMABUF_RENDERER')],
    ['Linux muestra tiempos por paso y tiempo total de build', files.linux.includes('BUILD_STARTED_SECONDS') && files.linux.includes('STEP_STARTED_SECONDS') && files.linux.includes('Tiempo del paso anterior') && files.linux.includes('Tiempo total')],
    ['Los limpiadores protegen release/ y no la borran como una salida generada', files.cleanerPs1.includes('$ReleaseRoot') && files.cleanerPs1.includes('pertenece a release/:') && !cleanerPsDirectories.includes("'release'") && files.cleanerSh.includes('release_root') && files.cleanerSh.includes('Ruta protegida (release/)') && !cleanerShDirectories.includes(' release')],
    ['El limpiador Windows cubre temporales E2E, logs AppData y cachés privadas', files.cleanerPs1.includes('winslim-terminal-e2e-captures-*') && files.cleanerPs1.includes('winslim-terminal-webview2-e2e-*') && files.cleanerPs1.includes("Join-Path $dataRoot 'logs'") && files.cleanerPs1.includes("'appimage'" ) && files.cleanerPs1.includes('activePids')],
    ['El limpiador Linux cubre temporales E2E, logs y cachés sin tocar Tauri global', files.cleanerSh.includes('lterminal-e2e-report.*') && files.cleanerSh.includes('config_root/lterminal') && files.cleanerSh.includes('cache_root/lterminal') && files.cleanerSh.includes('caché global de') && files.cleanerSh.includes('kill -0')],
    ['Los limpiadores cubren temporales de build con nombre propio y filtran extracciones AppImage por identidad y actividad', files.cleanerSh.includes('lterminal-version-backup.*') && files.cleanerSh.includes('lterminal-build-smoke.*') && files.cleanerSh.includes('lterminal-release-audit-captures.*') && files.cleanerSh.includes('appimage_extraction_has_live_process') && files.cleanerSh.includes('usr/share/applications/LTerminal.desktop') && files.cleanerPs1.includes('lterminal-version-backup.*') && files.cleanerPs1.includes('lterminal-build-smoke.*') && files.cleanerPs1.includes('lterminal-release-audit-captures.*') && files.cleanerPs1.includes('Test-LiveProcessInDirectory') && files.cleanerPs1.includes('usr/share/applications/LTerminal.desktop')],
    ['PowerShell normaliza separadores finales de rutas Unix y Windows', files.cleanerPs1.includes('Get-NormalizedDirectoryPath') && files.cleanerPs1.includes('[char]47') && files.cleanerPs1.includes('[char]92')],
    ['Los limpiadores clasifican el staging de node_modules Windows como salida del proyecto', files.cleanerSh.includes('for candidate in "$project_root"/.node_modules.windows.*') && files.cleanerSh.includes('add_project_directory "$candidate"') && !files.cleanerSh.slice(files.cleanerSh.indexOf('external_targets=()')).includes('"$project_root"/.node_modules.windows.*') && files.cleanerPs1.includes('.node_modules.windows.*')],
    ['Los limpiadores no siguen enlaces simbólicos ni junctions al borrar salidas', files.cleanerSh.includes('IFS=\'/\' read -r -a path_parts') && files.cleanerSh.includes('external_target_has_symlink_parent') && files.cleanerSh.includes('[[ -L "$ancestor" ]]') && files.cleanerPs1.includes('[IO.FileAttributes]::ReparsePoint') && files.cleanerPs1.includes('Test-ExternalPathHasReparseParent') && files.cleanerPs1.includes('Remove-DirectoryTreeSafely')],
    ['La regresión del limpiador se ejecuta en las validaciones locales y completas', files.package.includes('"test:cleaner": "node scripts/test-clean-repository.mjs"') && files.package.includes('npm run test:cleaner') && files.cleanerTest.includes("await symlink(source, join(project, 'dist'), 'dir')") && files.cleanerTest.includes("await symlink(externalData, join(config, 'winslim-terminal'), 'dir')") && files.cleanerTest.includes('el destino del enlace no se borra') && files.cleanerTest.includes('no se atraviesa el enlace de la carpeta de configuración')],
    ['El E2E detecta espacios duplicados por keypress y prueba unidades de rueda', files.smoke.includes("const spaceProbe = 'space probe  keeps columns'") && files.smoke.includes("recordEvent('space-input-length'") && files.smoke.includes('WheelEvent.DOM_DELTA_LINE') && files.smoke.includes('WheelEvent.DOM_DELTA_PAGE')],
    ['Linux invalida node_modules de otra plataforma antes de svelte-check', files.linux.includes('linux_native_dependencies_ready') && files.linux.includes('@rollup/rollup-linux-x64-gnu') && files.linux.includes('@esbuild/linux-x64')],
    ['Linux aísla node_modules Windows y lo restaura al terminar', files.linux.includes('NODE_MODULES_RESTORE') && files.linux.includes('restore_node_modules') && files.linux.includes('@tauri-apps/cli-win32-x64-msvc') && files.linux.includes('trap on_exit EXIT')],
    ['La cross-build Windows acepta modo no interactivo', files.linuxWindows.includes('--non-interactive') && files.linuxWindows.includes('NON_INTERACTIVE')],
    ['La cross-build Windows permite fijar la versión antes de compilar', files.linuxWindows.includes('--version') && files.linuxWindows.includes('CURRENT_VERSION') && files.linuxWindows.includes('set-package-version.mjs') && files.linuxWindows.includes('Versión seleccionada')],
    ['Linux propaga errores de restauración aunque la build hubiera terminado bien', files.linux.includes('Falta la copia de seguridad del manifiesto') && files.linux.includes('exit 1') && files.linux.includes('cmp -s') && files.linux.includes('trap on_exit EXIT')],
    ['Windows cruzado propaga errores de restauración aunque la build hubiera terminado bien', files.linuxWindows.includes('Falta la copia de seguridad del manifiesto') && files.linuxWindows.includes('exit 1') && files.linuxWindows.includes('cmp -s') && files.linuxWindows.includes('trap on_exit EXIT')],
    ['Windows nativo detecta copias ausentes y restaura también al salir por error', files.windows.includes('falta la copia de seguridad') && files.windows.includes('No está disponible la copia de seguridad de los manifiestos') && files.windows.includes('Backup-VersionManifests') && files.windows.includes('Restore-VersionManifests') && files.windows.includes('finally')],
    ['Wine usa smoke headless por defecto y conserva GUI optativa', files.linuxWindows.includes('[ "${LTERMINAL_WINE_GUI_SMOKE:-0}" = "1" ] || headless_smoke=1') && files.linuxWindows.includes('LTERMINAL_WINE_HEADLESS_SMOKE=1') && files.linuxWindows.includes('Smoke headless Wine')],
    ['Wine headless valida el backend de sesión del ejecutable Windows', files.linuxWindows.includes("'Smoke Wine headless completado'") && files.linuxWindows.includes("'pty spawneado'") && files.linuxWindows.includes('LTERMINAL_TEST_UNDER_WINE=1')],
    ['La batería PE bajo Wine usa el prefijo aislado compartido con el smoke', wineRustBlock.includes('WINE_SMOKE_PREFIX:-${WINEPREFIX:-$HOME/.cache/lterminal/wine-smoke-prefix}') && wineRustBlock.includes('mkdir -p "$wine_test_prefix"') && wineRustBlock.includes('WINEPREFIX="$wine_test_prefix"') && wineRustBlock.includes('cargo test')],
    ['La regresión de versión fuerza fallos de build y de restauración y compara manifiestos', files.package.includes('test:version-restore') && files.versionRestore.includes('LTERMINAL_TEST_FAIL_AFTER_VERSION') && files.versionRestore.includes('LTERMINAL_TEST_REMOVE_VERSION_BACKUP') && files.versionRestore.includes('LTERMINAL_TEST_EXIT_AFTER_VERSION') && files.versionRestore.includes('assert.deepEqual(snapshot(), before')],
    ['La regresión de versión corre en check:local y check y restaura el checkout si falla', [...files.package.matchAll(/npm run test:version-restore/g)].length >= 2 && files.versionRestore.includes('timeout: 20_000') && files.versionRestore.includes('if (!existsSync(path) || !readFileSync(path).equals(contents)) writeFileSync(path, contents)') && files.versionRestore.includes("console.log('SKIP: pruebas de scripts Bash")],
    ['El E2E simula Shift+rueda y exige preventDefault', files.smoke.includes("new WheelEvent('wheel'") && files.smoke.includes('shiftKey: true') && files.smoke.includes('defaultPrevented')],
    ['La cross-build Windows valida SemVer antes de comprobar dependencias', files.linuxWindows.includes('La versión indicada no es SemVer válida') && files.linuxWindows.indexOf('La versión indicada no es SemVer válida') < files.linuxWindows.indexOf('ensure_node_and_rust')],
    ['Linux elige una compresión AppImage compatible con su runtime de smoke', files.linux.includes('APPIMAGE_POST_COMP="${LTERMINAL_APPIMAGE_POST_COMP:-zstd}"') && files.linux.includes('APPIMAGE_POST_COMP="${LTERMINAL_APPIMAGE_POST_COMP:-gzip}"') && files.linux.includes('XZ no es compatible')],
    ['Linux detecta la versión de linuxdeploy aunque informe por stderr y actualiza RELR si hace falta', files.linux.includes('--version 2>&1 || true') && files.linux.includes('LINUXDEPLOY_CACHE') && files.linux.includes('LINUXDEPLOY_BUILD') && files.linux.includes('linuxdeploy-x86_64.AppImage') && files.linux.includes('LTERMINAL_APPIMAGE_NO_STRIP')],
    ['Linux valida AppStream y evita la heurística de nombre del empaquetador', files.linux.includes('LDAI_NO_APPSTREAM') && files.linux.includes('appstreamcli validate --no-net') && files.linux.includes('--no-appstream')],
    ['Linux conserva stripping por defecto', files.linux.includes('unset NO_STRIP') && files.linux.includes('LTERMINAL_APPIMAGE_NO_STRIP')],
    ['Linux evita la copia conflictiva de GIO TLS', files.linux.includes('libgiognutls.so') && files.linux.includes('rm -f "$APPDIR/usr/lib/gio/modules/libgiognutls.so"')],
    ['Smoke Windows valida el token de arranque', files.windows.includes('$smokeToken')],
    ['Smoke Windows admite Wine y Proton en entornos aislados', files.linuxWindows.includes('LTERMINAL_WINE_RUNNER') && files.linuxWindows.includes('LTERMINAL_PROTON') && files.linuxWindows.includes('STEAM_COMPAT_DATA_PATH') && files.linuxWindows.includes('tracked_files')],
    ['Smoke Windows exige el marcador de éxito y deja margen al arranque asíncrono del PTY', files.windows.includes('function Test-SmokeReady') && files.windows.includes('sessionMatch') && files.windows.includes('Frontend y terminal preparados') && files.windows.includes('$attempt -lt 45') && !files.windows.includes("notmatch 'Frontend preparado pero sin sesión PTY'")],
    ['Los tests Windows bajo Wine toleran compilaciones frías y explican el timeout', files.linuxWindows.includes('LTERMINAL_WINE_TEST_TIMEOUT:-1800') && files.linuxWindows.includes('superó ${timeout_seconds}s')],
    ['Windows aísla las descargas de dependencias en un temporal propio y elimina la carpeta al finalizar', files.windows.includes('winslim-terminal-build-$PID-') && files.windows.includes("Join-Path $script:BuildTempDir 'node-v22.14.0-x64.msi'") && files.windows.includes("Join-Path $script:BuildTempDir 'rustup-init.exe'") && files.windows.includes('Remove-Item -LiteralPath $script:BuildTempDir -Recurse -Force') && files.cleanerPs1.includes("'winslim-terminal-build-*'") && files.cleanerSh.includes('winslim-terminal-build-*')],
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
