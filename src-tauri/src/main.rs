// Sin consola en Windows en las builds de release: la app es una ventana, no
// una herramienta de línea de comandos.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    winslim_terminal_lib::run()
}
