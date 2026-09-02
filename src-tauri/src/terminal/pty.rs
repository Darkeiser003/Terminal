//! El pseudo-terminal de cada pestaña.
//!
//! Sustituye a `node-pty`: `portable-pty` da la misma abstracción (ConPTY en
//! Windows, `forkpty` en Unix) sin módulo nativo que recompilar por versión de
//! Node ni DLL que empaquetar aparte.
//!
//! Este módulo no sabe nada de Tauri ni de pestañas a propósito: recibe dos
//! callbacks y los llama desde el hilo lector. Quien los conecta con la ventana
//! es `tabs.rs`, y así el troceado de la salida se puede probar sin arrancar
//! nada.

use std::io::{Read, Write};
use std::path::Path;

use parking_lot::Mutex;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::platform::traits::ProcessPlatform;
use crate::stream::{ClearSplitter, PtyEvent, Utf8Decoder};

/// En Windows la app no usa el ConPTY del sistema, sino una `conpty.dll`
/// propia que va junto al ejecutable: con el backend del sistema la shell
/// muere al nacer con `STATUS_DLL_INIT_FAILED` en los Windows recortados para
/// los que está pensada esta terminal. El porqué completo está en la sección
/// «conpty.dll» del README raíz.
///
/// Devuelve la ruta si está donde `portable-pty` la va a buscar. Que falte no
/// impide arrancar —el sistema puede tener un ConPTY que funcione— pero deja
/// constancia en el log, que si no es un cuelgue de varios minutos sin
/// explicación.
pub fn sideloaded_conpty() -> Option<std::path::PathBuf> {
    crate::platform::host().sideloaded_conpty()
}

/// Cuánto se lee del pty de una vez. La salida de un `cat` de un archivo
/// grande llega en ráfagas: leer de 64 KiB evita despertar al hilo por cada
/// línea.
const READ_BUFFER_BYTES: usize = 64 * 1024;

/// Tamaño de la ventana, no el 80x24 de manual. La shell escribe su primer
/// prompt en cuanto arranca, antes de que el frontend haya podido medir nada;
/// nacer con el tamaño real evita que ese prompt se reajuste después. El
/// El banner pertenece al PTY y se emite una sola vez durante la inicialización.
/// Los resize posteriores solo ajustan dimensiones y no vuelven a imprimirlo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub cols: u16,
    pub rows: u16,
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport { cols: 80, rows: 24 }
    }
}

impl From<Viewport> for PtySize {
    fn from(viewport: Viewport) -> PtySize {
        PtySize {
            rows: viewport.rows,
            cols: viewport.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

pub struct SpawnConfig<'a> {
    pub exe: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub viewport: Viewport,
}

/// Un pty vivo. Al soltarlo se cierra el maestro, lo que hace que el hilo
/// lector termine solo.
pub struct PtySession {
    // `MasterPty` es `Send` pero no `Sync`, y la sesión se comparte entre el
    // hilo de la UI y los de lectura/espera. El mutex es lo que la vuelve
    // compartible; además serializa los `resize`, que en ConPTY repintan el
    // buffer entero.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl PtySession {
    pub fn write(&self, data: &str) -> std::io::Result<()> {
        let mut writer = self.writer.lock();
        writer.write_all(data.as_bytes())?;
        writer.flush()
    }

    pub fn resize(&self, viewport: Viewport) -> anyhow::Result<()> {
        self.master.lock().resize(viewport.into())?;
        Ok(())
    }

    pub fn kill(&self) {
        // Un pty ya terminado devuelve error aquí; no es un fallo.
        let _ = self.killer.lock().kill();
    }
}

/// Arranca la shell y deja dos hilos en marcha: uno leyendo la salida y otro
/// esperando a que el proceso termine.
///
/// `on_event` recibe la salida ya decodificada y con los marcadores de limpieza
/// separados. `on_exit` recibe el código de salida (o `None` si el proceso
/// murió por una señal).
pub fn spawn<E, X>(
    config: SpawnConfig<'_>,
    mut on_event: E,
    on_exit: X,
) -> anyhow::Result<PtySession>
where
    E: FnMut(PtyEvent) + Send + 'static,
    X: FnOnce(Option<i32>) + Send + 'static,
{
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system.openpty(config.viewport.into())?;

    let mut command = CommandBuilder::new(config.exe);
    for arg in config.args {
        command.arg(arg);
    }
    command.cwd(config.cwd);
    // La shell hereda el entorno útil de la app, incluido un PATH refrescado.
    // Al correr dentro de un AppImage se excluyen sus cargadores/bibliotecas
    // privadas: filtrar esos valores evita que git y otras herramientas del
    // sistema intenten enlazar contra `/tmp/.mount_*/usr/lib`.
    for (key, value) in crate::process::child_environment() {
        command.env(key, value);
    }
    command.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(command)?;
    // El esclavo tiene que soltarse aquí: mientras siga abierto en el proceso
    // padre, el maestro nunca ve EOF y el hilo lector no terminaría al salir la
    // shell.
    drop(pair.slave);

    let killer = child.clone_killer();
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    std::thread::Builder::new()
        .name("pty-reader".into())
        .spawn(move || read_loop(reader, &mut on_event))?;

    std::thread::Builder::new()
        .name("pty-waiter".into())
        .spawn(move || {
            let code = wait_for_exit(child);
            on_exit(code);
        })?;

    Ok(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
    })
}

fn read_loop<E>(mut reader: Box<dyn Read + Send>, on_event: &mut E)
where
    E: FnMut(PtyEvent),
{
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut decoder = Utf8Decoder::new();
    let mut splitter = ClearSplitter::new();

    loop {
        match reader.read(&mut buffer) {
            // EOF: la shell cerró su extremo.
            Ok(0) => break,
            Ok(read) => {
                let text = decoder.push(&buffer[..read]);
                if text.is_empty() {
                    continue;
                }
                for event in splitter.push(&text) {
                    on_event(event);
                }
            }
            // En Windows, cerrar el pty hace que la lectura falle en vez de dar
            // EOF. En los dos casos significa lo mismo: no habrá más salida.
            Err(_) => break,
        }
    }
}

fn wait_for_exit(mut child: Box<dyn Child + Send + Sync>) -> Option<i32> {
    let status = child.wait().ok()?;
    Some(status.exit_code() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn conpty_disponible_en_este_runtime() -> bool {
        // Wine enlaza y ejecuta la lógica Windows, pero todavía no implementa
        // CreatePseudoConsole con la fidelidad necesaria para portable-pty.
        // Solo la batería cruzada pone este marcador: en Windows nativo estas
        // pruebas continúan siendo obligatorias.
        !(cfg!(windows) && std::env::var("LTERMINAL_TEST_UNDER_WINE").as_deref() == Ok("1"))
    }

    fn shell_echo(text: &str) -> (String, Vec<String>) {
        if cfg!(windows) {
            (
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
                vec!["/c".into(), format!("echo {text}")],
            )
        } else {
            (
                "/bin/sh".into(),
                vec!["-c".into(), format!("printf '{text}'")],
            )
        }
    }

    #[test]
    fn el_viewport_por_defecto_es_80x24() {
        let size: PtySize = Viewport::default().into();
        assert_eq!((size.cols, size.rows), (80, 24));
    }

    #[test]
    fn una_shell_que_imprime_y_sale_entrega_su_salida_y_su_codigo() {
        if !conpty_disponible_en_este_runtime() {
            eprintln!("ConPTY se valida en Windows nativo; Wine no implementa esta API.");
            return;
        }
        let (exe, args) = shell_echo("hola-pty");
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let cwd = std::env::temp_dir();

        let session = spawn(
            SpawnConfig {
                exe: &exe,
                args: &args,
                cwd: &cwd,
                viewport: Viewport::default(),
            },
            move |event| {
                if let PtyEvent::Data(text) = event {
                    let _ = data_tx.send(text);
                }
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("el pty arranca");

        let code = exit_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("la shell termina");
        assert_eq!(code, Some(0));

        let mut salida = String::new();
        while let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(500)) {
            salida.push_str(&chunk);
        }
        assert!(salida.contains("hola-pty"), "salida inesperada: {salida:?}");

        // Matar un pty ya terminado no debe entrar en pánico.
        session.kill();
    }

    #[test]
    fn un_ejecutable_inexistente_devuelve_error_en_vez_de_colgarse() {
        let cwd = std::env::temp_dir();
        let result = spawn(
            SpawnConfig {
                exe: "ejecutable-que-no-existe-en-ningun-sistema",
                args: &[],
                cwd: &cwd,
                viewport: Viewport::default(),
            },
            |_| {},
            |_| {},
        );
        assert!(result.is_err());
    }

    #[test]
    fn se_puede_redimensionar_una_sesion_viva() {
        if !conpty_disponible_en_este_runtime() {
            eprintln!("ConPTY se valida en Windows nativo; Wine no implementa esta API.");
            return;
        }
        let exe = if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            "/bin/sh".to_string()
        };
        let cwd = std::env::temp_dir();
        let session = spawn(
            SpawnConfig {
                exe: &exe,
                args: &[],
                cwd: &cwd,
                viewport: Viewport::default(),
            },
            |_| {},
            |_| {},
        )
        .expect("el pty arranca");

        assert!(session
            .resize(Viewport {
                cols: 120,
                rows: 40
            })
            .is_ok());
        session.kill();
    }
}
