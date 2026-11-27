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
use std::process::{Child as ProcessChild, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Agrupar la salida desde el primer byte: la pestaña nace con el ancho
    /// exacto (IA, Python en Windows). Ver [`PtySession::set_coalesce`].
    pub coalesce: bool,
    /// Variables que se añaden al entorno heredado: la clave guardada de una
    /// IA (`environments::ai_keys::spawn_env`). Casi siempre, ninguna.
    pub extra_env: &'a [(String, String)],
}

/// Un pty vivo. Al soltar la sesión se termina el proceso y se cierra el
/// maestro, por lo que también acaba el hilo lector.
pub struct PtySession {
    backend: PtyBackend,
    process_id: Option<u32>,
    /// Serializa los cambios de geometría y las escrituras que afectan a la
    /// misma ConPTY. Una acción del panel puede redimensionar y escribir casi
    /// a la vez; sin esta compuerta cmd podía procesar el comando con la
    /// anchura anterior y envolverlo antes de que xterm recibiera el resize.
    operation: Mutex<()>,
    /// Al cerrar, matar también los procesos que lanzó el de la pestaña. Solo
    /// en los REPL: `elm.CMD` abre cmd → node → elm.exe → node, y matar solo
    /// cmd dejaba huérfano a elm.exe con su caché bloqueada; el siguiente REPL
    /// de Elm moría con «resource busy (file is locked)». Una shell no lo usa:
    /// un programa con ventana que se abra desde ella debe sobrevivir a la
    /// pestaña, como en cualquier terminal.
    kill_tree: std::sync::atomic::AtomicBool,
    /// Lo que decide cómo entrega el hilo lector: agrupar a pantalla completa
    /// ([`Self::set_coalesce`]) y retener el eco de una orden de una acción
    /// ([`Self::hold_echo`]).
    control: Arc<ReadControl>,
}

/// Cómo entrega `read_loop` lo que lee. Lo comparten la sesión, que lo cambia,
/// y el hilo lector, que lo consulta en cada lectura.
pub(crate) struct ReadControl {
    /// Agrupar lo que ConPTY entrega seguido antes de pasarlo a la pestaña.
    coalesce: AtomicBool,
    /// Retener la salida hasta este instante o hasta ver tantos saltos de
    /// línea (el Intro de la orden), lo que llegue antes.
    echo_hold: Mutex<Option<(Instant, usize)>>,
    /// Lo leído y lo entregado: el aviso de fin espera a que esté todo
    /// entregado ([`OutputActivity::wait_drained`]).
    activity: Arc<OutputActivity>,
}

/// Cuánto tiene que llevar callada la salida, ya entregada entera, para dar
/// por terminada una pestaña cuyo proceso salió.
const EXIT_QUIET: Duration = Duration::from_millis(100);
/// Lo que más se retrasa el aviso de fin aunque siga llegando salida.
const EXIT_DRAIN_MAX: Duration = Duration::from_millis(1500);

/// El hilo que espera al proceso y el que lee su salida van por libre. En
/// ConPTY las últimas líneas llegan después de que el proceso sale: Grok
/// escribía «API key required…» y salía en 0,3 s, y el aviso de fin se
/// adelantaba a ese texto (13-11, larga 60: la pestaña no ofreció la clave y
/// «Proceso finalizado» salió encima del error). Con esto el fin espera a la
/// salida: el hilo lector cuenta lo que lee y lo que entrega.
pub(crate) struct OutputActivity {
    read: AtomicU64,
    delivered: AtomicU64,
    last_read: Mutex<Instant>,
}

impl OutputActivity {
    fn new() -> Self {
        OutputActivity {
            read: AtomicU64::new(0),
            delivered: AtomicU64::new(0),
            last_read: Mutex::new(Instant::now()),
        }
    }

    fn note_read(&self) {
        *self.last_read.lock() = Instant::now();
        self.read.fetch_add(1, Ordering::SeqCst);
    }

    fn note_delivered(&self, chunks: u64) {
        self.delivered.fetch_add(chunks, Ordering::SeqCst);
    }

    /// Vuelve cuando todo lo leído está entregado y no llega nada desde hace
    /// `quiet`, o a los `max` como mucho.
    pub(crate) fn wait_drained(&self, quiet: Duration, max: Duration) {
        let started = Instant::now();
        loop {
            let pending = self.read.load(Ordering::SeqCst) != self.delivered.load(Ordering::SeqCst);
            if !pending && self.last_read.lock().elapsed() >= quiet {
                return;
            }
            if started.elapsed() >= max {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl ReadControl {
    pub(crate) fn new(coalesce: bool) -> Self {
        ReadControl {
            coalesce: AtomicBool::new(coalesce),
            echo_hold: Mutex::new(None),
            activity: Arc::new(OutputActivity::new()),
        }
    }

    /// La retención pendiente, si sigue en plazo. Se consume: la recoge la
    /// primera lectura que llega después de pedirla.
    fn take_echo_hold(&self) -> Option<(Instant, usize)> {
        let (until, newlines) = self.echo_hold.lock().take()?;
        (until > Instant::now()).then_some((until, newlines))
    }
}

enum PtyBackend {
    Native {
        // `MasterPty` es `Send` pero no `Sync`, y la sesión se comparte entre
        // el hilo de la UI y los de lectura/espera. El mutex es lo que la
        // vuelve compartible; además serializa los `resize`, que en ConPTY
        // repintan el buffer entero.
        master: Mutex<Box<dyn MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    },
    Pipe {
        // Wine no implementa CreatePseudoConsole con la fidelidad que exige
        // portable-pty. Este backend, usado solo en validaciones Wine, mantiene
        // stdin/stdout/stderr para ejecutar comandos básicos, pero no emula
        // modos de terminal, señales ni resize. Windows nativo sigue usando
        // exclusivamente ConPTY.
        writer: Mutex<ChildStdin>,
        child: Arc<Mutex<ProcessChild>>,
    },
}

impl PtySession {
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    pub fn write(&self, data: &str) -> std::io::Result<()> {
        let _operation = self.operation.lock();
        match &self.backend {
            PtyBackend::Native { writer, .. } => {
                let mut writer = writer.lock();
                writer.write_all(data.as_bytes())?;
                writer.flush()
            }
            PtyBackend::Pipe { writer, .. } => {
                let mut writer = writer.lock();
                writer.write_all(data.as_bytes())?;
                writer.flush()
            }
        }
    }

    pub fn resize(&self, viewport: Viewport) -> anyhow::Result<()> {
        let _operation = self.operation.lock();
        match &self.backend {
            PtyBackend::Native { master, .. } => master.lock().resize(viewport.into())?,
            // Las pipes no tienen una geometría que cambiar. El frontend aún
            // puede enviar resize durante el arranque y se ignora solo en el
            // entorno Wine de validación.
            PtyBackend::Pipe { .. } => {}
        }
        Ok(())
    }

    /// Agrupa la salida mientras la pestaña usa el ancho exacto (una IA,
    /// Python en Windows, vim). Un programa que dibuja con la API de consola
    /// llega muy troceado: con pyreadline3, cada tecla del REPL de Python son
    /// 63-127 lecturas en 13-26 ms, y cada una era un evento con su escritura
    /// y su repintado en el frontend (~250 ms por letra). Fuera de ese modo no
    /// se agrupa: la reserva horizontal de las shells mide la salida trozo a
    /// trozo, y agruparla para todas rompió la suite `horizontal` (10-11).
    pub fn set_coalesce(&self, on: bool) {
        self.control.coalesce.store(on, Ordering::Relaxed);
    }

    /// Una acción (instalar, actualizar…) va a escribir una orden entera y el
    /// usuario la quiere ver de una vez (`actionCommandsAtOnce`). La shell
    /// recibe las teclas de golpe, pero Clink, PSReadLine o ble.sh repintan la
    /// línea a cada una y la orden se veía escribir letra a letra. Si la shell
    /// empieza a repintar antes de `max`, se retiene la salida hasta ver
    /// `newlines` saltos de línea (los Intro escritos) mientras siga llegando
    /// eco ([`ECHO_HOLD_GAP`], [`ECHO_HOLD_TOTAL`]), y se entrega junta. Si
    /// algo sale antes de tiempo, se entrega igual: nunca se pierde nada,
    /// como mucho se ve como antes.
    pub fn hold_echo(&self, max: Duration, newlines: usize) {
        *self.control.echo_hold.lock() = Some((Instant::now() + max, newlines.max(1)));
    }

    /// Vuelve cuando todo lo leído está entregado a la pestaña y la shell lleva
    /// `quiet` sin escribir, o a los `max` como mucho. Para escribir una orden
    /// en cola cuando una shell recién abierta ya ha pintado su prompt.
    pub fn wait_output_quiet(&self, quiet: Duration, max: Duration) {
        self.control.activity.wait_drained(quiet, max);
    }

    /// Ver `kill_tree`.
    pub fn kill_whole_tree_on_close(&self) {
        self.kill_tree
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn kill(&self) {
        // El árbol primero, mientras el padre sigue vivo: `taskkill /T`
        // recorre los hijos desde él y con el padre muerto ya no los encuentra.
        #[cfg(windows)]
        if self.kill_tree.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(pid) = self.process_id {
                let _ = crate::process::hidden_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
        }
        // Un pty ya terminado devuelve error aquí; no es un fallo.
        match &self.backend {
            PtyBackend::Native { killer, .. } => {
                let _ = killer.lock().kill();
            }
            PtyBackend::Pipe { child, .. } => {
                let _ = child.lock().kill();
            }
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Soltar el último dueño de una sesión debe cerrar también el proceso,
        // incluso si el hilo de conexión no pudo aceptar el resultado del spawn.
        self.kill();
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
    if cfg!(windows) && std::env::var("LTERMINAL_TEST_UNDER_WINE").as_deref() == Ok("1") {
        return spawn_pipe(config, on_event, on_exit);
    }

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system.openpty(config.viewport.into())?;

    // Windows no puede crear directamente un proceso cuyo módulo sea un
    // script `.bat`/`.cmd`. Algunos REPL instalados por winget (Groovy,
    // ts-node y otros launchers) se detectan precisamente como esos scripts;
    // sin este envoltorio la pestaña se crea vacía aunque el binario exista.
    // Ejecutarlos bajo cmd conserva el PTY y permite que los argumentos sigan
    // llegando al launcher como una línea interactiva normal.
    let is_windows_script = cfg!(windows)
        && (config.exe.to_ascii_lowercase().ends_with(".bat")
            || config.exe.to_ascii_lowercase().ends_with(".cmd"));
    let mut command = if is_windows_script {
        let mut command = CommandBuilder::new("cmd.exe");
        command.arg("/d");
        command.arg("/s");
        command.arg("/c");
        // `cmd /c` interpreta una ruta absoluta con espacios como varias
        // palabras cuando portable-pty compone la línea de CreateProcess.
        // La ruta procede de `which`, así que el nombre del launcher ya está
        // disponible en PATH; usar solo el nombre evita que `C:\Program` se
        // convierta en el supuesto comando. El cwd del usuario se conserva.
        let launcher = std::path::Path::new(config.exe)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(config.exe);
        command.arg(launcher);
        command
    } else {
        CommandBuilder::new(config.exe)
    };
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
    crate::process::sanitize_pty_child_environment(&mut command);
    // Windows PowerShell 5.1 no debe heredar el `PSModulePath` de PowerShell
    // 7: perdería su carpeta de módulos de usuario (y con ella el PSReadLine
    // actualizado y sus sugerencias).
    if cfg!(windows) && crate::process::is_windows_powershell(config.exe) {
        command.env(
            "PSModulePath",
            crate::process::current_windows_powershell_module_path(),
        );
    }
    // El paquete OCaml de MSYS2 publica `ocaml.exe` como binario nativo,
    // pero conserva su biblioteca estándar bajo `ucrt64/lib/ocaml`. Cuando
    // se inicia desde una aplicación Win32 no recibe el prefijo POSIX que
    // usa MSYS2 y termina con `Unbound module Stdlib`. Derivar la ruta desde
    // el ejecutable hace que una instalación recién hecha funcione en la
    // pestaña actual, sin exigir reiniciar WTerminal.
    if cfg!(windows) && config.exe.to_ascii_lowercase().ends_with("\\ocaml.exe") {
        if let Some(prefix) = std::path::Path::new(config.exe)
            .parent()
            .and_then(|bin| bin.parent())
        {
            let ocaml_lib = prefix.join("lib").join("ocaml");
            if ocaml_lib.is_dir() {
                command.env("OCAMLLIB", ocaml_lib);
            }
        }
    }
    command.env("TERM", "xterm-256color");
    // Carpeta donde `console_ui` deja la cabecera y el cierre de cada acción
    // de cmd: así la orden que se teclea cabe en una sola línea legible.
    command.env(
        crate::console_ui::CMD_FRAME_DIR_VAR,
        crate::paths::SESSION_DIR.as_os_str(),
    );
    for (key, value) in config.extra_env {
        command.env(key, value);
    }

    let child = pair.slave.spawn_command(command)?;
    // El esclavo tiene que soltarse aquí: mientras siga abierto en el proceso
    // padre, el maestro nunca ve EOF y el hilo lector no terminaría al salir la
    // shell.
    drop(pair.slave);

    let process_id = child.process_id();
    let mut killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = killer.kill();
            return Err(error);
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = killer.kill();
            return Err(error);
        }
    };

    let control = Arc::new(ReadControl::new(config.coalesce));
    let reader_control = Arc::clone(&control);
    if let Err(error) = std::thread::Builder::new()
        .name("pty-reader".into())
        .spawn(move || read_loop(reader, &reader_control, &mut on_event))
    {
        let _ = killer.kill();
        return Err(error.into());
    }

    let activity = Arc::clone(&control.activity);
    if let Err(error) = std::thread::Builder::new()
        .name("pty-waiter".into())
        .spawn(move || {
            let code = wait_for_exit(child);
            activity.wait_drained(EXIT_QUIET, EXIT_DRAIN_MAX);
            on_exit(code);
        })
    {
        let _ = killer.kill();
        return Err(error.into());
    }

    Ok(PtySession {
        backend: PtyBackend::Native {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        },
        process_id,
        operation: Mutex::new(()),
        kill_tree: std::sync::atomic::AtomicBool::new(false),
        control,
    })
}

fn spawn_pipe<E, X>(config: SpawnConfig<'_>, on_event: E, on_exit: X) -> anyhow::Result<PtySession>
where
    E: FnMut(PtyEvent) + Send + 'static,
    X: FnOnce(Option<i32>) + Send + 'static,
{
    let mut command = Command::new(config.exe);
    command.args(config.args);
    command.current_dir(config.cwd);
    for (key, value) in crate::process::child_environment() {
        command.env(key, value);
    }
    for (key, value) in config.extra_env {
        command.env(key, value);
    }
    command
        .env("TERM", "xterm-256color")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // El host es una app GUI y Wine asigna una consola visible a cmd.exe si
    // no se pide explícitamente lo contrario. Las pipes siguen conectadas con
    // el hijo; CREATE_NO_WINDOW solo evita esa ventana secundaria.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn()?;
    let process_id = Some(child.id());
    let writer = match child.stdin.take() {
        Some(writer) => writer,
        None => {
            let _ = child.kill();
            return Err(anyhow::anyhow!("no se pudo abrir stdin de la shell Wine"));
        }
    };
    let stdout = match child.stdout.take() {
        Some(reader) => reader,
        None => {
            let _ = child.kill();
            return Err(anyhow::anyhow!("no se pudo abrir stdout de la shell Wine"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(reader) => reader,
        None => {
            let _ = child.kill();
            return Err(anyhow::anyhow!("no se pudo abrir stderr de la shell Wine"));
        }
    };

    let on_event = Arc::new(Mutex::new(on_event));
    let control = Arc::new(ReadControl::new(config.coalesce));
    let readers: [(&str, Box<dyn Read + Send>); 2] =
        [("stdout", Box::new(stdout)), ("stderr", Box::new(stderr))];
    for (name, reader) in readers {
        let event_callback = Arc::clone(&on_event);
        let reader_control = Arc::clone(&control);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("wine-pipe-{name}"))
            .spawn(move || {
                let mut emit = |event| (event_callback.lock())(event);
                read_loop(reader, &reader_control, &mut emit);
            })
        {
            let _ = child.kill();
            return Err(error.into());
        }
    }

    let child = Arc::new(Mutex::new(child));
    let waiter_child = Arc::clone(&child);
    let activity = Arc::clone(&control.activity);
    if let Err(error) = std::thread::Builder::new()
        .name("pipe-waiter".into())
        .spawn(move || {
            let code = loop {
                // No mantener el mutex durante wait(): kill() necesita
                // adquirirlo para poder cerrar una sesión Wine bloqueada.
                let result = { waiter_child.lock().try_wait() };
                match result {
                    Ok(Some(status)) => break Some(status.code().unwrap_or(-1)),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
                    Err(_) => break None,
                }
            };
            activity.wait_drained(EXIT_QUIET, EXIT_DRAIN_MAX);
            on_exit(code);
        })
    {
        let _ = child.lock().kill();
        return Err(error.into());
    }

    Ok(PtySession {
        backend: PtyBackend::Pipe {
            writer: Mutex::new(writer),
            child,
        },
        process_id,
        operation: Mutex::new(()),
        kill_tree: std::sync::atomic::AtomicBool::new(false),
        control,
    })
}

/// Tras una lectura, cuánto se espera a la siguiente para entregarlas juntas
/// (solo con [`PtySession::set_coalesce`]). Las de pyreadline3 llegan con 0,2 ms
/// de hueco medio y 2,5 ms como mucho; un eco suelto solo se retrasa esto.
const COALESCE_GAP: Duration = Duration::from_millis(3);
/// Lo que más se retiene una entrega aunque sigan llegando trozos (un frame).
const COALESCE_MAX_DELAY: Duration = Duration::from_millis(16);
/// Tope de bytes de una entrega agrupada.
const COALESCE_MAX_BYTES: usize = 256 * 1024;
/// Trozos que el hilo lector puede adelantar: si la pestaña va lenta, la PTY
/// espera en vez de acumular memoria sin límite.
const COALESCE_QUEUE_CHUNKS: usize = 64;
/// Retención del eco de una acción ([`PtySession::hold_echo`]): una vez que la
/// shell empieza a repintar, lo más que se espera al trozo siguiente antes de
/// soltar lo juntado (si deja de repintar, se ve lo que haya)…
const ECHO_HOLD_GAP: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_millis(1500)
};
/// …y lo más que dura en total, aunque siga llegando eco sin su Intro.
const ECHO_HOLD_TOTAL: Duration = if cfg!(test) {
    Duration::from_millis(800)
} else {
    Duration::from_secs(8)
};

/// Lee la salida y la entrega decodificada. Un hilo solo lee (bloqueante) y
/// este entrega: cada lectura por separado, como siempre, o, con `coalesce`
/// encendido, juntando lo que siga llegando con huecos de menos de
/// [`COALESCE_GAP`] hasta [`COALESCE_MAX_DELAY`]. Con una retención de eco
/// pendiente ([`PtySession::hold_echo`]), la lectura que llega la recoge y se
/// junta todo hasta el Intro de la orden. Si el hilo lector no se puede crear,
/// se lee aquí mismo, una entrega por lectura.
fn read_loop<E>(reader: Box<dyn Read + Send>, control: &ReadControl, on_event: &mut E)
where
    E: FnMut(PtyEvent),
{
    let shared = Arc::new(Mutex::new(Some(reader)));
    let for_reader = Arc::clone(&shared);
    let reader_activity = Arc::clone(&control.activity);
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(COALESCE_QUEUE_CHUNKS);
    let spawned = std::thread::Builder::new()
        .name("pty-read-raw".into())
        .spawn(move || {
            let Some(mut reader) = for_reader.lock().take() else {
                return;
            };
            let mut buffer = vec![0u8; READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    // EOF: la shell cerró su extremo. En Windows, cerrar el pty
                    // hace que la lectura falle en vez de dar EOF: significa lo
                    // mismo, no habrá más salida.
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        reader_activity.note_read();
                        if sender.send(buffer[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    if spawned.is_err() {
        if let Some(reader) = shared.lock().take() {
            read_loop_direct(reader, control, on_event);
        }
        return;
    }

    let mut decoder = Utf8Decoder::new();
    let mut splitter = ClearSplitter::new();
    let mut batch = Vec::with_capacity(READ_BUFFER_BYTES);
    while let Ok(first) = receiver.recv() {
        // Cuántas lecturas van en esta entrega, para el aviso de fin.
        let mut chunks = 1u64;
        if let Some((_, newlines)) = control.take_echo_hold() {
            batch.clear();
            batch.extend_from_slice(&first);
            let mut missing = newlines.saturating_sub(count_newlines(&first));
            // El plazo cuenta desde que la shell empieza a repintar y se
            // alarga mientras siga llegando eco: con el equipo cargado, Clink
            // tardaba más de 2 s en repintar la orden y la retención, que
            // contaba desde que se pidió, se soltaba antes (15-11, dirigidas
            // de la 64: el .bat de la Biblioteca llegó en 23 trozos).
            let started = Instant::now();
            while missing > 0 && batch.len() < COALESCE_MAX_BYTES {
                let elapsed = started.elapsed();
                if elapsed >= ECHO_HOLD_TOTAL {
                    break;
                }
                match receiver.recv_timeout(ECHO_HOLD_GAP.min(ECHO_HOLD_TOTAL - elapsed)) {
                    Ok(more) => {
                        chunks += 1;
                        missing = missing.saturating_sub(count_newlines(&more));
                        batch.extend_from_slice(&more);
                    }
                    Err(_) => break,
                }
            }
            deliver(&mut decoder, &mut splitter, &batch, on_event);
            control.activity.note_delivered(chunks);
            continue;
        }
        if !control.coalesce.load(Ordering::Relaxed) {
            deliver(&mut decoder, &mut splitter, &first, on_event);
            control.activity.note_delivered(chunks);
            continue;
        }
        batch.clear();
        batch.extend_from_slice(&first);
        let started = Instant::now();
        while batch.len() < COALESCE_MAX_BYTES {
            let waited = started.elapsed();
            if waited >= COALESCE_MAX_DELAY {
                break;
            }
            match receiver.recv_timeout(COALESCE_GAP.min(COALESCE_MAX_DELAY - waited)) {
                Ok(more) => {
                    chunks += 1;
                    batch.extend_from_slice(&more);
                }
                // Sin más por ahora, o la lectura terminó: se entrega lo que hay.
                Err(_) => break,
            }
        }
        deliver(&mut decoder, &mut splitter, &batch, on_event);
        control.activity.note_delivered(chunks);
    }
}

fn count_newlines(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == b'\n').count()
}

/// La lectura de siempre, una entrega por lectura: solo si no se pudo crear el
/// hilo lector.
fn read_loop_direct<E>(mut reader: Box<dyn Read + Send>, control: &ReadControl, on_event: &mut E)
where
    E: FnMut(PtyEvent),
{
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut decoder = Utf8Decoder::new();
    let mut splitter = ClearSplitter::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                control.activity.note_read();
                deliver(&mut decoder, &mut splitter, &buffer[..read], on_event);
                control.activity.note_delivered(1);
            }
        }
    }
}

fn deliver<E>(
    decoder: &mut Utf8Decoder,
    splitter: &mut ClearSplitter,
    bytes: &[u8],
    on_event: &mut E,
) where
    E: FnMut(PtyEvent),
{
    let text = decoder.push(bytes);
    if text.is_empty() {
        return;
    }
    for event in splitter.push(&text) {
        on_event(event);
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

    /// Un lector que entrega trozos ya preparados, con una pausa antes de cada
    /// uno (cero: todos seguidos, como pyreadline3 en ConPTY).
    struct ChunkedReader {
        chunks: std::collections::VecDeque<Vec<u8>>,
        pause: Duration,
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let Some(chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            if !self.pause.is_zero() {
                std::thread::sleep(self.pause);
            }
            buffer[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    fn delivered(reader: ChunkedReader, coalesce: bool) -> Vec<String> {
        delivered_with(reader, &ReadControl::new(coalesce))
    }

    fn delivered_with(reader: ChunkedReader, control: &ReadControl) -> Vec<String> {
        let mut data = Vec::new();
        read_loop(Box::new(reader), control, &mut |event| {
            if let PtyEvent::Data(text) = event {
                data.push(text);
            }
        });
        data
    }

    /// Lo que repinta Clink al recibir una orden escrita por una acción: la
    /// línea crece tecla a tecla, luego el Intro y la salida de la orden.
    fn typed_echo() -> std::collections::VecDeque<Vec<u8>> {
        [
            "w",
            "wi",
            "win",
            "winget",
            " upgrade",
            "\r\n",
            "Actualizando…\r\n",
        ]
        .iter()
        .map(|chunk| chunk.as_bytes().to_vec())
        .collect()
    }

    #[test]
    fn el_eco_de_una_accion_de_una_vez_sale_entero_hasta_el_intro() {
        let control = ReadControl::new(false);
        *control.echo_hold.lock() = Some((Instant::now() + Duration::from_secs(5), 1));
        let data = delivered_with(
            ChunkedReader {
                chunks: typed_echo(),
                // Más que COALESCE_GAP: agrupar sin más no los juntaría.
                pause: Duration::from_millis(8),
            },
            &control,
        );
        assert_eq!(
            data[0], "wwiwinwinget upgrade\r\n",
            "la orden y su Intro, juntos"
        );
        assert_eq!(
            data[1..].concat(),
            "Actualizando…\r\n",
            "lo de después, como siempre"
        );
        assert!(
            control.echo_hold.lock().is_none(),
            "la retención se consume"
        );
    }

    #[test]
    fn el_eco_retenido_se_suelta_si_la_shell_deja_de_repintar_sin_perder_nada() {
        let control = ReadControl::new(false);
        *control.echo_hold.lock() = Some((Instant::now() + Duration::from_secs(5), 1));
        let chunks: std::collections::VecDeque<Vec<u8>> = ["a", "b", "c", "d"]
            .iter()
            .map(|c| c.as_bytes().to_vec())
            .collect();
        let data = delivered_with(
            ChunkedReader {
                chunks,
                // Más que ECHO_HOLD_GAP (100 ms en las pruebas).
                pause: Duration::from_millis(250),
            },
            &control,
        );
        assert!(
            data.len() > 1,
            "sin Intro y con la shell parada, se suelta la salida: {data:?}"
        );
        assert_eq!(data.concat(), "abcd");
    }

    /// El plazo cuenta desde que la shell empieza a repintar, no desde que se
    /// pidió: con el equipo cargado, Clink tardaba más que el plazo en
    /// empezar y la orden se veía letra a letra (15-11).
    #[test]
    fn el_eco_de_una_shell_lenta_en_empezar_tambien_sale_entero() {
        // Pedida con 500 ms para empezar; la shell tarda ~280 ms en el primer
        // trozo y repinta cada 30 ms (menos que el hueco de 100 ms), así que
        // el Intro llega hacia los 450-550 ms: contando desde que se pidió, se
        // habría soltado a los 500 ms, a veces con la orden a medias.
        //
        // 21-11: con las 1067 pruebas a la vez en la VM lenta, el hilo del
        // lector llegó a dormir más de 100 ms entre dos trozos de 30 ms y el
        // hueco soltó «wwi» (sola pasaba 8 de 8). El hueco medido no es el de
        // la prueba, así que se dan hasta tres intentos: un fallo real de la
        // lógica falla los tres.
        let mut last = Vec::new();
        for _ in 0..3 {
            let control = ReadControl::new(false);
            *control.echo_hold.lock() = Some((Instant::now() + Duration::from_millis(500), 1));
            std::thread::sleep(Duration::from_millis(250));
            let data = delivered_with(
                ChunkedReader {
                    chunks: typed_echo(),
                    pause: Duration::from_millis(30),
                },
                &control,
            );
            if data.first().map(String::as_str) == Some("wwiwinwinget upgrade\r\n") {
                return;
            }
            last = data;
        }
        assert_eq!(
            last.first().map(String::as_str),
            Some("wwiwinwinget upgrade\r\n")
        );
    }

    #[test]
    fn sin_la_opcion_el_eco_de_una_accion_llega_como_siempre() {
        let data = delivered(
            ChunkedReader {
                chunks: typed_echo(),
                pause: Duration::from_millis(8),
            },
            false,
        );
        assert_eq!(
            data.len(),
            typed_echo().len(),
            "cada repintado por separado"
        );
    }

    #[test]
    fn una_retencion_vencida_no_retiene_nada() {
        let control = ReadControl::new(false);
        let past = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .unwrap_or_else(Instant::now);
        *control.echo_hold.lock() = Some((past, 1));
        assert!(control.take_echo_hold().is_none());
        assert!(control.echo_hold.lock().is_none());
    }

    fn redraw_chunks(count: usize) -> std::collections::VecDeque<Vec<u8>> {
        (0..count)
            .map(|row| format!("\x1b7\x1b[{};1H\x1b[0m   \x1b8", row % 30 + 1).into_bytes())
            .collect()
    }

    #[test]
    fn a_pantalla_completa_los_trozos_seguidos_llegan_juntos() {
        let chunks = redraw_chunks(100);
        let expected: String = chunks
            .iter()
            .map(|chunk| String::from_utf8(chunk.clone()).unwrap())
            .collect();
        let events = delivered(
            ChunkedReader {
                chunks,
                pause: Duration::ZERO,
            },
            true,
        );
        assert!(
            events.len() < 10,
            "{} entregas para 100 trozos seguidos",
            events.len()
        );
        assert_eq!(events.concat(), expected, "sin perder ni reordenar nada");
    }

    #[test]
    fn una_shell_recibe_cada_lectura_por_separado_como_siempre() {
        // La reserva horizontal mide la salida trozo a trozo: sin el modo
        // pantalla completa no se agrupa nada (agruparlo rompió `horizontal`).
        let events = delivered(
            ChunkedReader {
                chunks: redraw_chunks(100),
                pause: Duration::ZERO,
            },
            false,
        );
        assert_eq!(events.len(), 100);
    }

    #[test]
    fn a_pantalla_completa_un_eco_suelto_no_espera_al_siguiente() {
        let chunks = ["a", "b", "c"]
            .map(|text| text.as_bytes().to_vec())
            .into_iter()
            .collect();
        let events = delivered(
            ChunkedReader {
                chunks,
                pause: Duration::from_millis(200),
            },
            true,
        );
        assert_eq!(events, ["a", "b", "c"]);
    }

    #[test]
    fn un_caracter_partido_entre_dos_lecturas_se_recompone() {
        let euro = "€".as_bytes();
        for coalesce in [false, true] {
            let chunks = std::collections::VecDeque::from([euro[..1].to_vec(), euro[1..].to_vec()]);
            let events = delivered(
                ChunkedReader {
                    chunks,
                    pause: Duration::from_millis(100),
                },
                coalesce,
            );
            assert_eq!(events.concat(), "€", "coalesce={coalesce}");
        }
    }

    #[test]
    fn el_viewport_por_defecto_es_80x24() {
        let size: PtySize = Viewport::default().into();
        assert_eq!((size.cols, size.rows), (80, 24));
    }

    /// Medición a mano (26-11, salida letra a letra): cuánto tarda la consola
    /// de Windows en sacar 2000 líneas de cmd, sin la ventana de WTerminal.
    /// `cargo test medir_velocidad_de_conpty -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn medir_velocidad_de_conpty() {
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let cwd = std::env::temp_dir();
        let args: Vec<String> = [
            "/d",
            "/c",
            "for /L %i in (1,1,2000) do @echo linea %i de salida para medir la velocidad de WTerminal",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        for cols in [120u16, 1024] {
            let started = Instant::now();
            let tx = data_tx.clone();
            let exit = exit_tx.clone();
            let _session = spawn(
                SpawnConfig {
                    exe: "cmd.exe",
                    args: &args,
                    cwd: &cwd,
                    viewport: Viewport { cols, rows: 30 },
                    coalesce: false,
                    extra_env: &[],
                },
                move |event| {
                    if let PtyEvent::Data(text) = event {
                        let _ = tx.send(text.len());
                    }
                },
                move |code| {
                    let _ = exit.send(code);
                },
            )
            .expect("el pty arranca");
            exit_rx
                .recv_timeout(Duration::from_secs(300))
                .expect("cmd termina");
            let elapsed = started.elapsed();
            let mut chunks = 0usize;
            let mut bytes = 0usize;
            while let Ok(size) = data_rx.recv_timeout(Duration::from_millis(500)) {
                chunks += 1;
                bytes += size;
            }
            eprintln!(
                "conpty {cols} columnas: {} ms, {chunks} trozos, {bytes} bytes, dll propia: {:?}",
                elapsed.as_millis(),
                sideloaded_conpty()
            );
        }
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
                coalesce: false,
                extra_env: &[],
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
    fn el_aviso_de_fin_espera_a_que_se_entregue_lo_leido() {
        let activity = Arc::new(OutputActivity::new());
        activity.note_read();
        activity.note_read();
        let late = Arc::clone(&activity);
        let deliverer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            late.note_delivered(2);
        });
        let started = Instant::now();
        activity.wait_drained(Duration::from_millis(20), Duration::from_secs(5));
        let waited = started.elapsed();
        deliverer.join().unwrap();
        assert!(
            waited >= Duration::from_millis(140),
            "no esperó a la entrega: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(5),
            "esperó hasta el tope: {waited:?}"
        );
    }

    #[test]
    fn el_aviso_de_fin_espera_a_que_la_salida_se_calle_y_tiene_tope() {
        // Todo entregado pero recién leído: espera a que se calle.
        let activity = OutputActivity::new();
        activity.note_read();
        activity.note_delivered(1);
        let started = Instant::now();
        activity.wait_drained(Duration::from_millis(120), Duration::from_secs(5));
        assert!(started.elapsed() >= Duration::from_millis(110));
        // Algo leído que nunca se entrega: no se queda colgado, sale al tope.
        let stuck = OutputActivity::new();
        stuck.note_read();
        let started = Instant::now();
        stuck.wait_drained(Duration::from_millis(10), Duration::from_millis(200));
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(190) && waited < Duration::from_secs(2),
            "{waited:?}"
        );
    }

    /// El fin llega detrás de toda la salida, también agrupada (pestañas de IA):
    /// Grok escribía su error y salía, y el aviso de fin se le adelantaba.
    #[test]
    fn el_fin_llega_despues_de_toda_la_salida() {
        if !conpty_disponible_en_este_runtime() {
            eprintln!("ConPTY se valida en Windows nativo; Wine no implementa esta API.");
            return;
        }
        for round in 0..3 {
            let (exe, args) = shell_echo("ultima-linea-antes-del-fin");
            let seen = Arc::new(Mutex::new(String::new()));
            let at_exit = Arc::new(Mutex::new(None::<String>));
            let (exit_tx, exit_rx) = mpsc::channel();
            let cwd = std::env::temp_dir();
            let for_data = Arc::clone(&seen);
            let for_exit = Arc::clone(&seen);
            let snapshot = Arc::clone(&at_exit);
            let session = spawn(
                SpawnConfig {
                    exe: &exe,
                    args: &args,
                    cwd: &cwd,
                    viewport: Viewport::default(),
                    coalesce: true,
                    extra_env: &[],
                },
                move |event| {
                    if let PtyEvent::Data(text) = event {
                        for_data.lock().push_str(&text);
                    }
                },
                move |code| {
                    *snapshot.lock() = Some(for_exit.lock().clone());
                    let _ = exit_tx.send(code);
                },
            )
            .expect("el pty arranca");
            exit_rx
                .recv_timeout(Duration::from_secs(20))
                .expect("la shell termina");
            let before_exit = at_exit.lock().clone().unwrap_or_default();
            assert!(
                before_exit.contains("ultima-linea-antes-del-fin"),
                "vuelta {round}: el fin llegó antes que la salida: {before_exit:?}"
            );
            session.kill();
        }
    }

    #[cfg(unix)]
    #[test]
    fn la_sesion_pipe_reenvia_entrada_y_stdout_stderr() {
        let args = vec![
            "-c".into(),
            "IFS= read -r line; printf 'salida:%s\\n' \"$line\"; printf 'error:%s\\n' \"$line\" >&2".into(),
        ];
        let cwd = std::env::temp_dir();
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let session = spawn_pipe(
            SpawnConfig {
                exe: "/bin/sh",
                args: &args,
                cwd: &cwd,
                viewport: Viewport::default(),
                coalesce: false,
                extra_env: &[],
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
        .expect("la pipe de prueba arranca");

        session
            .write("entrada-de-prueba\n")
            .expect("stdin de la shell sigue conectado");

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut output = String::new();
        while !(output.contains("salida:entrada-de-prueba")
            && output.contains("error:entrada-de-prueba"))
        {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "salida incompleta: {output:?}");
            output.push_str(
                &data_rx
                    .recv_timeout(remaining)
                    .expect("stdout y stderr llegan a la sesión"),
            );
        }

        assert_eq!(
            exit_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("el proceso termina"),
            Some(0)
        );
        session.kill();
    }

    #[cfg(windows)]
    #[test]
    fn la_sesion_pipe_windows_reenvia_entrada_stdout_y_stderr() {
        let exe = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let args = vec!["/d".into(), "/q".into()];
        let cwd = std::env::temp_dir();
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let session = spawn_pipe(
            SpawnConfig {
                exe: &exe,
                args: &args,
                cwd: &cwd,
                viewport: Viewport::default(),
                coalesce: false,
                extra_env: &[],
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
        .expect("cmd.exe arranca con las tres pipes conectadas");

        session
            .write("echo LTERMINAL_PIPE_STDOUT & echo LTERMINAL_PIPE_STDERR 1>&2\r\nexit\r\n")
            .expect("stdin de cmd.exe sigue conectado");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        while !(output.contains("LTERMINAL_PIPE_STDOUT")
            && output.contains("LTERMINAL_PIPE_STDERR"))
        {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "salida incompleta: {output:?}");
            output.push_str(
                &data_rx
                    .recv_timeout(remaining)
                    .expect("stdout y stderr llegan a la sesión"),
            );
        }

        assert_eq!(
            exit_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("cmd.exe termina"),
            Some(0)
        );
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
                coalesce: false,
                extra_env: &[],
            },
            |_| {},
            |_| {},
        );
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn al_soltar_una_sesion_pipe_el_proceso_termina_sin_bloquear_el_waiter() {
        let args = vec!["-c".into(), "read line".into()];
        let cwd = std::env::temp_dir();
        let (exit_tx, exit_rx) = mpsc::channel();
        let session = spawn_pipe(
            SpawnConfig {
                exe: "/bin/sh",
                args: &args,
                cwd: &cwd,
                viewport: Viewport::default(),
                coalesce: false,
                extra_env: &[],
            },
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("la pipe de prueba arranca");
        let process_id = session.process_id().expect("el proceso tiene PID");
        let (dropped_tx, dropped_rx) = mpsc::channel();
        let dropper = std::thread::spawn(move || {
            drop(session);
            let _ = dropped_tx.send(());
        });

        if dropped_rx.recv_timeout(Duration::from_secs(3)).is_err() {
            // Solo actúa si una regresión vuelve a bloquear Drop bajo el lock
            // que usa el waiter, y permite que el propio test termine limpio.
            let process_id_arg = process_id.to_string();
            let _ = std::process::Command::new("kill")
                .args(["-KILL", process_id_arg.as_str()])
                .status();
            let _ = dropper.join();
            panic!("soltar la sesión pipe se bloqueó esperando al waiter");
        }
        dropper.join().expect("el hilo de cierre termina");
        exit_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("el waiter detecta el cierre del proceso");
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
                coalesce: false,
                extra_env: &[],
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
