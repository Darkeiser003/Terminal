//! Parser pasivo de las zonas semánticas OSC 133.
//!
//! WezTerm usa estas marcas para distinguir prompt, entrada y salida. WTerminal
//! no cambia el texto que recibe xterm ni exige que la shell las emita: este
//! módulo solo conserva los escapes partidos entre lecturas y publica los
//! metadatos que estén completos. Una shell que no usa OSC 133 sigue teniendo
//! exactamente el comportamiento anterior.

const MAX_CARRY_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticZoneKind {
    PromptStart,
    PromptEnd,
    InputStart,
    InputEnd,
}

impl SemanticZoneKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PromptStart => "prompt-start",
            Self::PromptEnd => "prompt-end",
            Self::InputStart => "input-start",
            Self::InputEnd => "input-end",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticZoneEvent {
    pub kind: SemanticZoneKind,
    pub payload: Option<String>,
}

#[derive(Debug, Default)]
pub struct SemanticZoneSplitter {
    carry: String,
}

impl SemanticZoneSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.carry.clear();
    }

    /// Busca `ESC ] 133 ; <A|B|C|D> [;payload] BEL/ST` sin retirar nada de la
    /// salida. El backend puede usar los eventos para seleccionar bloques o
    /// mejorar el scrollback, mientras xterm sigue recibiendo los bytes
    /// originales y decide cómo representar cualquier escape desconocido.
    pub fn push(&mut self, data: &str) -> Vec<SemanticZoneEvent> {
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.push_str(data);
        let prefix = "\x1b]133;";
        let mut events = Vec::new();
        let mut cursor = 0;

        loop {
            let Some(relative_start) = buffer[cursor..].find(prefix) else {
                preserve_partial_prefix(&mut self.carry, &buffer[cursor..], prefix);
                break;
            };
            let start = cursor + relative_start;
            let body_start = start + prefix.len();
            let Some((end, terminator_len)) = find_osc_terminator(&buffer, body_start) else {
                // Solo se conserva una secuencia OSC 133 incompleta. El resto
                // ya se ha visto y no puede afectar a una lectura posterior.
                let tail = &buffer[start..];
                if tail.chars().count() <= MAX_CARRY_CHARS {
                    self.carry = tail.to_string();
                }
                break;
            };
            let body = &buffer[body_start..end];
            if let Some(event) = parse_body(body) {
                events.push(event);
            }
            cursor = end + terminator_len;
        }

        events
    }
}

fn preserve_partial_prefix(carry: &mut String, value: &str, prefix: &str) {
    let max_length = prefix.len().saturating_sub(1).min(value.len());
    for length in (1..=max_length).rev() {
        let start = value.len() - length;
        if value.is_char_boundary(start) && prefix.starts_with(&value[start..]) {
            *carry = value[start..].to_string();
            return;
        }
    }
    carry.clear();
}

fn find_osc_terminator(value: &str, from: usize) -> Option<(usize, usize)> {
    let tail = &value[from..];
    let bel = tail.find('\u{7}');
    let st = tail.find("\x1b\\");
    match (bel, st) {
        (Some(bel), Some(st)) if bel < st => Some((from + bel, 1)),
        (Some(_), Some(st)) => Some((from + st, 2)),
        (Some(bel), None) => Some((from + bel, 1)),
        (None, Some(st)) => Some((from + st, 2)),
        (None, None) => None,
    }
}

fn parse_body(body: &str) -> Option<SemanticZoneEvent> {
    let mut parts = body.splitn(2, ';');
    let kind = match parts.next()? {
        "A" => SemanticZoneKind::PromptStart,
        "B" => SemanticZoneKind::PromptEnd,
        "C" => SemanticZoneKind::InputStart,
        "D" => SemanticZoneKind::InputEnd,
        _ => return None,
    };
    let payload = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(SemanticZoneEvent { kind, payload })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_las_cuatro_transiciones_y_conserva_payload() {
        let mut splitter = SemanticZoneSplitter::new();
        let events = splitter.push("\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C;42\x07\x1b]133;D\x07");
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, SemanticZoneKind::PromptStart);
        assert_eq!(events[2].kind, SemanticZoneKind::InputStart);
        assert_eq!(events[2].payload.as_deref(), Some("42"));
    }

    #[test]
    fn recompone_una_marca_partida_y_acepta_st() {
        let mut splitter = SemanticZoneSplitter::new();
        assert!(splitter.push("texto\x1b]133;C;co").is_empty());
        let events = splitter.push("mando\x1b\\");
        assert_eq!(
            events,
            vec![SemanticZoneEvent {
                kind: SemanticZoneKind::InputStart,
                payload: Some("comando".into()),
            }]
        );
    }

    #[test]
    fn conserva_tambien_el_prefijo_partido_entre_lecturas() {
        let mut splitter = SemanticZoneSplitter::new();
        assert!(splitter.push("texto\x1b]133").is_empty());
        let events = splitter.push(";A\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, SemanticZoneKind::PromptStart);
    }

    #[test]
    fn ignora_codigos_desconocidos_y_se_reinicia() {
        let mut splitter = SemanticZoneSplitter::new();
        assert!(splitter.push("\x1b]133;Z\x07").is_empty());
        splitter.reset();
        assert!(splitter.push("\x1b]133;D\x07").len() == 1);
    }
}
