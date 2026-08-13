//! Traducción de rutas del host a lo que ve cada shell.
//!
//! Port de los ayudantes `toMsysPath` / `toWslPath` / `unixPathFor` de
//! `electron/main/scriptLauncher.js`. Viven aparte porque los usan tanto la
//! inicialización de las shells como el lanzador de scripts.

use crate::environments::Transport;
use crate::platform::traits::HostPlatform;

fn split_drive(win_path: &str) -> Option<(char, &str)> {
    let mut chars = win_path.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') || chars.next() != Some('\\') {
        return None;
    }
    Some((letter.to_ascii_lowercase(), &win_path[3..]))
}

/// `C:\proyectos\app` -> `/c/proyectos/app` (Git Bash y MSYS).
pub fn to_msys_path(win_path: &str) -> String {
    match split_drive(win_path) {
        Some((letter, rest)) => format!("/{letter}/{}", rest.replace('\\', "/")),
        None => win_path.to_string(),
    }
}

/// `C:\proyectos\app` -> `/mnt/c/proyectos/app`, y `\\wsl$\Ubuntu\home\ana` ->
/// `/home/ana` (dentro de la distro esa ruta ya es local).
pub fn to_wsl_path(win_path: &str) -> String {
    if let Some((letter, rest)) = split_drive(win_path) {
        return format!("/mnt/{letter}/{}", rest.replace('\\', "/"));
    }
    if let Some(inside) = strip_wsl_unc(win_path) {
        return format!("/{}", inside.replace('\\', "/"));
    }
    win_path.to_string()
}

/// Quita el prefijo `\\wsl$\<distro>\` o `\\wsl.localhost\<distro>\` y devuelve
/// lo que queda, que ya es una ruta interna de la distro.
fn strip_wsl_unc(win_path: &str) -> Option<&str> {
    let rest = win_path.strip_prefix("\\\\")?;
    let (host, rest) = rest.split_once('\\')?;
    let host = host.trim_end_matches('$');
    if !host.eq_ignore_ascii_case("wsl") && !host.eq_ignore_ascii_case("wsl.localhost") {
        return None;
    }
    // Se salta el nombre de la distro.
    match rest.split_once('\\') {
        Some((_distro, inside)) => Some(inside),
        // `\\wsl$\Ubuntu` a secas es la raíz de la distro.
        None => Some(""),
    }
}

/// La ruta tal y como hay que escribirla dentro de esta shell.
///
/// En un contenedor la ruta del host no significa nada, así que se deja como
/// está (quien la use ya sabe que solo vale para lo montado). Dentro de WSL se
/// traduce a `/mnt/...`, y en Windows todo lo demás va al estilo MSYS, que es
/// lo que entienden Git Bash y compañía.
pub fn unix_path_for(raw_path: &str, transport: Transport) -> String {
    match transport {
        Transport::Docker => raw_path.to_string(),
        Transport::Wsl => to_wsl_path(raw_path),
        Transport::Msys => to_msys_path(raw_path),
        _ if crate::platform::host().is_windows() => to_msys_path(raw_path),
        _ => raw_path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_unidad_de_windows_se_traduce_al_estilo_msys() {
        assert_eq!(to_msys_path("C:\\proyectos\\app"), "/c/proyectos/app");
        assert_eq!(to_msys_path("D:\\"), "/d/");
    }

    #[test]
    fn una_unidad_de_windows_se_traduce_al_estilo_wsl() {
        assert_eq!(to_wsl_path("C:\\proyectos\\app"), "/mnt/c/proyectos/app");
    }

    #[test]
    fn una_ruta_que_no_es_de_windows_se_deja_igual() {
        assert_eq!(to_msys_path("/home/ana"), "/home/ana");
        assert_eq!(to_wsl_path("/home/ana"), "/home/ana");
    }

    #[test]
    fn el_recurso_de_red_de_wsl_vuelve_a_ser_una_ruta_interna() {
        assert_eq!(to_wsl_path("\\\\wsl$\\Ubuntu\\home\\ana"), "/home/ana");
        assert_eq!(
            to_wsl_path("\\\\wsl.localhost\\Debian\\etc\\hosts"),
            "/etc/hosts"
        );
        assert_eq!(to_wsl_path("\\\\wsl$\\Ubuntu"), "/");
    }

    #[test]
    fn otro_recurso_de_red_no_se_confunde_con_wsl() {
        let unc = "\\\\servidor\\compartido\\archivo";
        assert_eq!(to_wsl_path(unc), unc);
    }

    #[test]
    fn en_un_contenedor_la_ruta_del_host_se_deja_intacta() {
        assert_eq!(
            unix_path_for("C:\\Users\\Ana\\x.sh", Transport::Docker),
            "C:\\Users\\Ana\\x.sh"
        );
    }

    #[test]
    fn cada_transporte_elige_su_traduccion() {
        assert_eq!(unix_path_for("C:\\x", Transport::Wsl), "/mnt/c/x");
        assert_eq!(unix_path_for("C:\\x", Transport::Msys), "/c/x");
    }
}
