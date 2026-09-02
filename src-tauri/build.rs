use std::path::{Path, PathBuf};

fn main() {
    copy_conpty_next_to_executable();
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
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest.join("vendor").join("conpty");
    let Some(profile_dir) = profile_dir() else {
        println!(
            "cargo:warning=No se pudo localizar la carpeta del ejecutable para copiar conpty.dll"
        );
        return;
    };
    // `LoadLibrary` con ruta relativa mira en la carpeta del ejecutable. La app
    // queda en `target/<perfil>/`, pero los binarios de prueba cuelgan de
    // `target/<perfil>/deps/`, así que las dos necesitan su copia.
    let targets = [profile_dir.clone(), profile_dir.join("deps")];

    for name in ["conpty.dll", "OpenConsole.exe"] {
        let from = source.join(name);
        println!("cargo:rerun-if-changed={}", from.display());
        if !from.exists() {
            println!(
                "cargo:warning=Falta {}: las pestañas no arrancarán en Windows",
                from.display()
            );
            continue;
        }
        for target in &targets {
            if !target.is_dir() {
                continue;
            }
            let to = target.join(name);
            // Sobrescribir un .dll ya cargado por otra instancia en marcha
            // falla; si el destino ya está y coincide, no hay nada que hacer.
            if same_contents(&from, &to) {
                continue;
            }
            if let Err(error) = std::fs::copy(&from, &to) {
                println!(
                    "cargo:warning=No se pudo copiar {name} a {}: {error}",
                    target.display()
                );
            }
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
