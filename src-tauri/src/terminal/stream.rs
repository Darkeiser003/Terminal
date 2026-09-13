//! De bytes crudos del pty a eventos para el frontend.
//!
//! Dos pasos, los dos con estado entre lecturas:
//!
//! 1. `Utf8Decoder` — el pty entrega bytes y una lectura puede cortar un
//!    carácter multibyte por la mitad. node-pty resolvía esto con el
//!    `StringDecoder` de Node; aquí se retienen los bytes incompletos hasta
//!    que llega el resto. Sin esto, una `ñ` a caballo entre dos lecturas
//!    llegaba al xterm como dos rombos.
//!
//! 2. `ClearSplitter` — port de `splitOnClearMarker` de `main.js`: separa de
//!    la salida el marcador de limpieza que la shell emite como cambio de
//!    título (ver `CLEAR_MARKER` en aliasProfiles.js).

use once_cell::sync::Lazy;
use regex::Regex;

/// El aviso de limpieza viaja como título (OSC 0) porque ConPTY no reenvía la
/// salida tal cual, sino el resultado de repintar su buffer: un `echo` borrado
/// por el `cls` inmediatamente posterior se pierde por el camino. Los cambios
/// de título sí llegan siempre. El sufijo aleatorio garantiza que cada
/// limpieza sea un título distinto (uno repetido no generaría evento).
pub const CLEAR_MARKER: &str = "__TERMINAL_CLEAR__";

/// Cuánto se retiene esperando el cierre de un OSC partido entre dos lecturas
/// del pty. Un título real nunca se acerca a este tamaño; el tope evita
/// acumular salida indefinidamente si un `ESC]` suelto no llega a cerrarse.
const MAX_OSC_CARRY: usize = 512;

static CLEAR_OSC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"\x1b\]0;([^\x07\x1b]*{CLEAR_MARKER}[^\x07\x1b]*)(?:\x07|\x1b\\)"
    ))
    .expect("la expresión del marcador de limpieza es válida")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data(String),
    /// El título completo identifica la limpieza concreta: lleva un sufijo
    /// aleatorio distinto cada vez, así que repetirlo significa que ConPTY ha
    /// reemitido un título antiguo, no que la shell haya limpiado otra vez.
    Clear(String),
}

/// Decodificador UTF-8 incremental sobre un flujo de bytes.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    carry: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> String {
        let buffer: Vec<u8> = if self.carry.is_empty() {
            chunk.to_vec()
        } else {
            let mut joined = std::mem::take(&mut self.carry);
            joined.extend_from_slice(chunk);
            joined
        };

        match std::str::from_utf8(&buffer) {
            Ok(text) => text.to_string(),
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                let text =
                    unsafe { std::str::from_utf8_unchecked(&buffer[..valid_up_to]) }.to_string();
                match error.error_len() {
                    // Secuencia truncada al final: se espera al resto.
                    None => {
                        self.carry = buffer[valid_up_to..].to_vec();
                        text
                    }
                    // Bytes realmente inválidos: se sustituyen y se sigue, como
                    // hace el StringDecoder de Node.
                    Some(invalid_len) => {
                        let rest = self.push(&buffer[valid_up_to + invalid_len..]);
                        format!("{text}\u{fffd}{rest}")
                    }
                }
            }
        }
    }
}

/// Separa los marcadores de limpieza del texto, conservando el orden exacto
/// entre texto -> clear -> texto.
#[derive(Debug, Default)]
pub struct ClearSplitter {
    carry: String,
}

impl ClearSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.carry.clear();
    }

    pub fn push(&mut self, data: &str) -> Vec<PtyEvent> {
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.push_str(data);

        // ¿La cola es un OSC a medias? Se guarda antes de buscar marcadores
        // para no partir un título entre dos entregas.
        if let Some(start) = buffer.rfind("\u{1b}]") {
            if buffer.len() - start < MAX_OSC_CARRY {
                let tail = &buffer[start..];
                if !tail.contains('\u{7}') && !tail.contains("\u{1b}\\") {
                    self.carry = tail.to_string();
                    buffer.truncate(start);
                }
            }
        }

        let mut events = Vec::new();
        let mut cursor = 0;
        for captures in CLEAR_OSC.captures_iter(&buffer) {
            let whole = captures.get(0).expect("el grupo 0 siempre existe");
            if whole.start() > cursor {
                events.push(PtyEvent::Data(buffer[cursor..whole.start()].to_string()));
            }
            events.push(PtyEvent::Clear(
                captures
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
            ));
            cursor = whole.end();
        }
        if cursor < buffer.len() {
            events.push(PtyEvent::Data(buffer[cursor..].to_string()));
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(text: &str) -> PtyEvent {
        PtyEvent::Data(text.to_string())
    }

    fn marker(suffix: &str) -> String {
        format!("\u{1b}]0;WinSlim {CLEAR_MARKER}{suffix}\u{7}")
    }

    // ---- Utf8Decoder ----

    #[test]
    fn un_caracter_partido_entre_dos_lecturas_se_recompone() {
        let mut decoder = Utf8Decoder::new();
        let bytes = "ñ".as_bytes();
        assert_eq!(decoder.push(&bytes[..1]), "");
        assert_eq!(decoder.push(&bytes[1..]), "ñ");
    }

    #[test]
    fn el_texto_ascii_pasa_intacto() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(b"C:\\Users> "), "C:\\Users> ");
    }

    #[test]
    fn los_bytes_invalidos_no_bloquean_el_flujo() {
        let mut decoder = Utf8Decoder::new();
        let out = decoder.push(&[0x61, 0xff, 0x62]);
        assert_eq!(out, "a\u{fffd}b");
    }

    #[test]
    fn un_emoji_partido_en_tres_trozos_se_recompone() {
        let mut decoder = Utf8Decoder::new();
        let bytes = "✅".as_bytes();
        assert_eq!(decoder.push(&bytes[..1]), "");
        assert_eq!(decoder.push(&bytes[1..2]), "");
        assert_eq!(decoder.push(&bytes[2..]), "✅");
    }

    // ---- ClearSplitter ----

    #[test]
    fn sin_marcador_todo_es_texto() {
        let mut splitter = ClearSplitter::new();
        assert_eq!(splitter.push("hola\r\n"), vec![data("hola\r\n")]);
    }

    #[test]
    fn el_marcador_se_saca_de_la_salida() {
        let mut splitter = ClearSplitter::new();
        let events = splitter.push(&format!("antes{}después", marker("123")));
        assert_eq!(
            events,
            vec![
                data("antes"),
                PtyEvent::Clear(format!("WinSlim {CLEAR_MARKER}123")),
                data("después"),
            ]
        );
    }

    #[test]
    fn un_titulo_normal_no_se_confunde_con_una_limpieza() {
        let mut splitter = ClearSplitter::new();
        let events = splitter.push("\u{1b}]0;C:\\Users\u{7}listo");
        assert_eq!(events, vec![data("\u{1b}]0;C:\\Users\u{7}listo")]);
    }

    #[test]
    fn un_osc_partido_entre_dos_lecturas_se_retiene_hasta_cerrarse() {
        let mut splitter = ClearSplitter::new();
        let full = marker("77");
        let (head, tail) = full.split_at(full.len() / 2);

        assert_eq!(splitter.push(&format!("antes{head}")), vec![data("antes")]);
        assert_eq!(
            splitter.push(tail),
            vec![PtyEvent::Clear(format!("WinSlim {CLEAR_MARKER}77"))]
        );
    }

    #[test]
    fn el_terminador_st_tambien_cierra_el_marcador() {
        let mut splitter = ClearSplitter::new();
        let events = splitter.push(&format!("\u{1b}]0;x {CLEAR_MARKER}9\u{1b}\\fin"));
        assert_eq!(
            events,
            vec![PtyEvent::Clear(format!("x {CLEAR_MARKER}9")), data("fin")]
        );
    }

    #[test]
    fn un_escape_suelto_no_retiene_la_salida_indefinidamente() {
        let mut splitter = ClearSplitter::new();
        let largo = "x".repeat(MAX_OSC_CARRY + 10);
        let events = splitter.push(&format!("\u{1b}]{largo}"));
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], PtyEvent::Data(text) if text.len() > MAX_OSC_CARRY));
    }

    #[test]
    fn dos_limpiezas_seguidas_dan_dos_eventos() {
        let mut splitter = ClearSplitter::new();
        let events = splitter.push(&format!("{}{}", marker("1"), marker("2")));
        assert_eq!(
            events,
            vec![
                PtyEvent::Clear(format!("WinSlim {CLEAR_MARKER}1")),
                PtyEvent::Clear(format!("WinSlim {CLEAR_MARKER}2")),
            ]
        );
    }

    #[test]
    fn reset_olvida_lo_retenido_al_reemplazar_el_pty() {
        let mut splitter = ClearSplitter::new();
        splitter.push("\u{1b}]0;a medias");
        splitter.reset();
        assert_eq!(splitter.push("nuevo"), vec![data("nuevo")]);
    }
}
