use std::path::{Path, PathBuf};

fn main() {
    // Tauri incrusta `frontendDist` dentro del ejecutable. El hook ejecuta
    // Vite antes que Cargo, pero sin esta dependencia Cargo puede reutilizar
    // un binario anterior cuando el único cambio está en Svelte/CSS. El HTML
    // referencia los assets con hash, por lo que cambia con cualquier bundle
    // nuevo y actúa como sello estable del frontend realmente incrustado.
    println!("cargo:rerun-if-changed=../dist/index.html");
    // Las claves de confianza se incrustan mediante `option_env!` en el
    // código del actualizador. Cargo no invalida una compilación cuando solo
    // cambia una variable de entorno salvo que el build script lo declare;
    // sin estas señales, una build firmada podía reutilizar un ejecutable
    // anterior sin las claves y fallar únicamente al pulsar «Volver a
    // comprobar».
    for variable in [
        "LTERMINAL_UPDATE_PUBLIC_KEY",
        "LTERMINAL_SSH_UPDATE_PUBLIC_KEY",
        "LTERMINAL_SSH_UPDATE_IDENTITY",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
        // Pasar la variable explícitamente a rustc hace que la incrustación
        // sea determinista incluso si Cargo ejecuta el build script con un
        // entorno filtrado. Nunca se incluye la clave privada.
        if let Ok(value) = std::env::var(variable) {
            println!("cargo:rustc-env={variable}={value}");
        }
    }
    copy_conpty_next_to_executable();
    // `cargo test` no pasa por el manifiesto que Tauri incrusta en la app.
    // Sin Common Controls v6, comctl32.dll se carga en modo clásico y la
    // resolución de `TaskDialogIndirect` termina en STATUS_ENTRYPOINT_NOT_FOUND
    // antes de que el ejecutable de tests pueda arrancar.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=windows-test.manifest.rc");
        println!("cargo:rerun-if-changed=windows-test.manifest");
        // Compilar el recurso sin pedirle a Cargo que lo enlace a los bins de
        // la aplicación. El `#[link]` condicionado a `cfg(test)` de lib.rs
        // será quien lo incorpore únicamente al harness unitario.
        embed_resource::compile_for(
            "windows-test.manifest.rc",
            std::iter::empty::<&str>(),
            embed_resource::NONE,
        )
        .manifest_required()
        .expect("No se pudo incrustar el manifiesto de Common Controls en los tests");
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR falta"));
        println!("cargo:rustc-link-search=native={}", out_dir.display());
    }
    // El ejecutable debe arrancar como `asInvoker`. La preferencia de
    // terminal administrativa se aplica desde Rust mediante el relanzamiento
    // UAC, cuando el usuario la activa. Incrustar `requireAdministrator` en
    // todos los perfiles rompe WebDriver/tauri-driver: el navegador no puede
    // atravesar el diálogo UAC y la sesión nunca llega a crear DevTools.
    tauri_build::build()
}

/// En Windows, `portable-pty` carga `conpty.dll` con una ruta relativa, así que
/// la busca en la carpeta del ejecutable. Las builds empaquetadas la instalan
/// ahí con `bundle.resources`; en desarrollo hay que ponerla a mano, porque el
/// binario vive en `target/<perfil>/`.
///
/// La razón de no usar el ConPTY del sistema y la política de vendorización se
/// documentan en la sección «conpty.dll» del README raíz.
fn copy_conpty_next_to_executable() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR falta"));
    let source = manifest.join("vendor").join("conpty");
    let profile_dir = profile_dir().expect("No se pudo localizar el directorio de salida Windows");
    // `LoadLibrary` con ruta relativa mira en la carpeta del ejecutable. La app
    // queda en `target/<perfil>/`, pero los binarios de prueba cuelgan de
    // `target/<perfil>/deps/`, así que las dos necesitan su copia.
    let targets = [profile_dir.clone(), profile_dir.join("deps")];

    for name in ["conpty.dll", "OpenConsole.exe"] {
        let from = source.join(name);
        println!("cargo:rerun-if-changed={}", from.display());
        if !from.is_file() {
            panic!(
                "Falta {}. Ejecuta `node scripts/prepare-conpty.mjs` antes de compilar Windows.",
                from.display()
            );
        }
        for target in &targets {
            std::fs::create_dir_all(target).unwrap_or_else(|error| {
                panic!("No se pudo preparar {}: {error}", target.display())
            });
            let to = target.join(name);
            // Sobrescribir un .dll ya cargado por otra instancia en marcha
            // falla; si el destino ya está y coincide, no hay nada que hacer.
            if same_contents(&from, &to) {
                continue;
            }
            std::fs::copy(&from, &to).unwrap_or_else(|error| {
                panic!("No se pudo copiar {name} a {}: {error}", target.display())
            });
        }
    }
}

/// `OUT_DIR` es `target/<perfil>/build/<paquete>-<hash>/out`; el ejecutable
/// queda tres niveles más arriba.
fn profile_dir() -> Option<PathBuf> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").ok()?);
    let dir = out_dir.ancestors().nth(3)?.to_path_buf();
    dir.is_dir().then_some(dir)
}

fn same_contents(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}
