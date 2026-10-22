//! Entornos de INTELIGENCIA ARTIFICIAL: las CLIs de asistentes (Claude Code,
//! Gemini CLI, Codex, Copilot, Qwen Code, opencode, aider) y un chat por cada
//! modelo local de Ollama ya descargado. Elegir uno abre la herramienta real
//! dentro de la pestaña, con su propio pty y la sesión o los tokens de quien la
//! use: la app no guarda claves ni habla con ninguna API por su cuenta.
//!
//! Igual que los REPL de `languages`, se marcan con `repl: true`: son
//! interfaces interactivas, no shells, y no reciben alias. Se instalan desde
//! «Entorno y dependencias» (apartado Inteligencia artificial).
//!
//! La detección no arranca nada: mira el PATH y, para Ollama, los manifiestos
//! que deja en disco cada modelo descargado (`ollama list` necesita el
//! servidor en marcha y tardaría o fallaría durante el arranque).

use std::path::{Path, PathBuf};

use crate::environments::{Environment, ShellKind, Transport};

pub const AI_GROUP: &str = "Inteligencia artificial";

/// Cuántos modelos locales se ofrecen como máximo en el selector.
const MAX_LOCAL_MODELS: usize = 64;

struct AiCliDef {
    id: &'static str,
    label: &'static str,
    windows_exe: &'static str,
    unix_exe: &'static str,
}

#[rustfmt::skip]
const AI_CLIS: &[AiCliDef] = &[
    AiCliDef { id: "claude", label: "Claude Code", windows_exe: "claude", unix_exe: "claude" },
    AiCliDef { id: "gemini", label: "Gemini CLI", windows_exe: "gemini", unix_exe: "gemini" },
    AiCliDef { id: "codex", label: "Codex CLI", windows_exe: "codex", unix_exe: "codex" },
    AiCliDef { id: "copilot", label: "GitHub Copilot CLI", windows_exe: "copilot", unix_exe: "copilot" },
    AiCliDef { id: "qwen", label: "Qwen Code", windows_exe: "qwen", unix_exe: "qwen" },
    AiCliDef { id: "opencode", label: "opencode", windows_exe: "opencode", unix_exe: "opencode" },
    AiCliDef { id: "aider", label: "aider", windows_exe: "aider", unix_exe: "aider" },
    AiCliDef { id: "amp", label: "Amp", windows_exe: "amp", unix_exe: "amp" },
    AiCliDef { id: "crush", label: "Crush", windows_exe: "crush", unix_exe: "crush" },
    AiCliDef { id: "continue", label: "Continue CLI", windows_exe: "cn", unix_exe: "cn" },
    AiCliDef { id: "grok", label: "Grok CLI", windows_exe: "grok", unix_exe: "grok" },
    AiCliDef { id: "aichat", label: "AIChat", windows_exe: "aichat", unix_exe: "aichat" },
    AiCliDef { id: "mods", label: "mods", windows_exe: "mods", unix_exe: "mods" },
    AiCliDef { id: "llm", label: "llm · chat", windows_exe: "llm", unix_exe: "llm" },
    AiCliDef { id: "sgpt", label: "ShellGPT", windows_exe: "sgpt", unix_exe: "sgpt" },
];

/// Argumentos con los que se abre cada CLI como pestaña: las que sin ellos
/// solo imprimen la ayuda o responden una vez se abren en modo chat.
fn cli_args(id: &str) -> Vec<String> {
    match id {
        "llm" => vec!["chat".to_string()],
        "sgpt" => vec!["--repl".to_string(), "temp".to_string()],
        _ => Vec::new(),
    }
}

/// Detecta las CLIs instaladas y los modelos locales de Ollama.
pub fn detect_ai_environments(
    platform: &str,
    probe: &crate::language_env::Probe<'_>,
    ollama_models: &[String],
) -> Vec<Environment> {
    let is_windows = platform == "windows" || platform == "win32";
    let mut detected: Vec<Environment> = AI_CLIS
        .iter()
        .filter_map(|definition| {
            let exe = if is_windows {
                definition.windows_exe
            } else {
                definition.unix_exe
            };
            (probe.is_installed)(exe).then(|| Environment {
                id: format!("ai:{}", definition.id),
                label: definition.label.to_string(),
                group: AI_GROUP.to_string(),
                kind: ShellKind::Repl,
                transport: Transport::Native,
                exe: (probe.resolve_path)(exe).unwrap_or_else(|| exe.to_string()),
                args: cli_args(definition.id),
                repl: true,
                no_auto_select: true,
                language: Some(format!("ai:{}", definition.id)),
                ..Default::default()
            })
        })
        .collect();
    if (probe.is_installed)("ollama") {
        let ollama = (probe.resolve_path)("ollama").unwrap_or_else(|| "ollama".to_string());
        for model in ollama_models.iter().take(MAX_LOCAL_MODELS) {
            detected.push(Environment {
                id: format!("ai:ollama:{model}"),
                label: format!("Ollama · {model}"),
                group: AI_GROUP.to_string(),
                kind: ShellKind::Repl,
                transport: Transport::Native,
                exe: ollama.clone(),
                args: vec!["run".to_string(), model.clone()],
                note: Some(
                    "Modelo local: la primera respuesta tarda mientras se carga en memoria."
                        .to_string(),
                ),
                repl: true,
                no_auto_select: true,
                language: Some("ai:ollama".to_string()),
                ..Default::default()
            });
        }
    }
    detected
}

/// Un modelo del catálogo curado de «Entorno y dependencias». El tamaño es el
/// de la etiqueta por defecto de Ollama (rango cuando la página da varios).
pub struct OllamaModel {
    pub tag: &'static str,
    pub label: &'static str,
    pub vendor: &'static str,
    pub download_gb: (f32, f32),
    pub note: &'static str,
}

/// Selección de modelos locales por fabricante, de pequeño a grande. Tamaños
/// tomados de ollama.com/library (octubre de 2026). Cualquier otro modelo,
/// incluidas las variantes de la comunidad, se descarga por nombre con
/// `ollama pull` y aparece igualmente en el selector.
#[rustfmt::skip]
pub const OLLAMA_MODELS: &[OllamaModel] = &[
    OllamaModel { tag: "qwen3.8:27b", label: "Qwen 3.8 · 27B", vendor: "Qwen (Alibaba)", download_gb: (18.0, 18.0), note: "Programación, investigación y agentes; entiende imágenes, herramientas y razonamiento." },
    OllamaModel { tag: "qwen3.6:27b", label: "Qwen 3.6 · 27B", vendor: "Qwen (Alibaba)", download_gb: (18.0, 19.0), note: "Agentes de código y razonamiento en varias vueltas." },
    OllamaModel { tag: "qwen3.6:35b", label: "Qwen 3.6 · 35B", vendor: "Qwen (Alibaba)", download_gb: (23.0, 24.0), note: "Agentes de código y razonamiento en varias vueltas." },
    OllamaModel { tag: "qwen3.5:0.8b", label: "Qwen 3.5 · 0.8B", vendor: "Qwen (Alibaba)", download_gb: (1.2, 1.3), note: "Diminuto: funciona en casi cualquier equipo." },
    OllamaModel { tag: "qwen3.5:2b", label: "Qwen 3.5 · 2B", vendor: "Qwen (Alibaba)", download_gb: (2.7, 3.1), note: "Ligero, con visión y herramientas." },
    OllamaModel { tag: "qwen3.5:4b", label: "Qwen 3.5 · 4B", vendor: "Qwen (Alibaba)", download_gb: (3.3, 4.0), note: "Ligero, con visión y herramientas." },
    OllamaModel { tag: "qwen3.5:9b", label: "Qwen 3.5 · 9B", vendor: "Qwen (Alibaba)", download_gb: (6.6, 7.6), note: "Buen equilibrio para equipos con 16 GB." },
    OllamaModel { tag: "qwen3.5:27b", label: "Qwen 3.5 · 27B", vendor: "Qwen (Alibaba)", download_gb: (17.0, 20.0), note: "Calidad alta; pide una GPU con mucha VRAM o 32 GB de RAM." },
    OllamaModel { tag: "gemma4:e2b", label: "Gemma 4 · E2B", vendor: "Gemma (Google)", download_gb: (4.6, 7.5), note: "Pequeño y multimodal (texto, imagen y audio)." },
    OllamaModel { tag: "gemma4:e4b", label: "Gemma 4 · E4B", vendor: "Gemma (Google)", download_gb: (6.6, 9.5), note: "Pequeño y multimodal (texto, imagen y audio)." },
    OllamaModel { tag: "gemma4:12b", label: "Gemma 4 · 12B", vendor: "Gemma (Google)", download_gb: (7.7, 8.0), note: "Texto e imagen." },
    OllamaModel { tag: "gemma4:31b", label: "Gemma 4 · 31B", vendor: "Gemma (Google)", download_gb: (19.0, 20.0), note: "Texto e imagen; el mayor de la familia." },
    OllamaModel { tag: "gpt-oss:20b", label: "gpt-oss · 20B", vendor: "OpenAI", download_gb: (14.0, 14.0), note: "Modelo abierto de OpenAI para razonamiento y agentes." },
    OllamaModel { tag: "gpt-oss:120b", label: "gpt-oss · 120B", vendor: "OpenAI", download_gb: (65.0, 65.0), note: "Solo para estaciones con GPU de gama alta o mucha memoria." },
    OllamaModel { tag: "deepseek-r1:1.5b", label: "DeepSeek-R1 · 1.5B", vendor: "DeepSeek", download_gb: (1.1, 1.1), note: "Razonamiento paso a paso, muy ligero." },
    OllamaModel { tag: "deepseek-r1:8b", label: "DeepSeek-R1 · 8B", vendor: "DeepSeek", download_gb: (5.2, 5.2), note: "Razonamiento paso a paso." },
    OllamaModel { tag: "deepseek-r1:14b", label: "DeepSeek-R1 · 14B", vendor: "DeepSeek", download_gb: (9.0, 9.0), note: "Razonamiento paso a paso." },
    OllamaModel { tag: "deepseek-r1:32b", label: "DeepSeek-R1 · 32B", vendor: "DeepSeek", download_gb: (20.0, 20.0), note: "Razonamiento paso a paso; pide mucha memoria." },
    OllamaModel { tag: "llama3.2:3b", label: "Llama 3.2 · 3B", vendor: "Llama (Meta)", download_gb: (2.0, 2.0), note: "Ligero y rápido." },
    OllamaModel { tag: "llama3.1:8b", label: "Llama 3.1 · 8B", vendor: "Llama (Meta)", download_gb: (4.9, 4.9), note: "Uso general." },
    OllamaModel { tag: "phi4:14b", label: "Phi-4 · 14B", vendor: "Phi (Microsoft)", download_gb: (9.1, 9.1), note: "Razonamiento y matemáticas." },
    OllamaModel { tag: "mistral-small3.2:24b", label: "Mistral Small 3.2 · 24B", vendor: "Mistral AI", download_gb: (15.0, 15.0), note: "Uso general, con visión y herramientas." },
    OllamaModel { tag: "qwen3-coder:30b", label: "Qwen3 Coder · 30B", vendor: "Qwen (Alibaba)", download_gb: (19.0, 19.0), note: "Agente de programación; mezcla de expertos con solo 3B activos, rápido para su tamaño." },
    OllamaModel { tag: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder · 7B", vendor: "Qwen (Alibaba)", download_gb: (4.7, 4.7), note: "Programación y autocompletado de código en equipos modestos." },
    OllamaModel { tag: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder · 14B", vendor: "Qwen (Alibaba)", download_gb: (9.0, 9.0), note: "Programación." },
    OllamaModel { tag: "qwen2.5-coder:32b", label: "Qwen 2.5 Coder · 32B", vendor: "Qwen (Alibaba)", download_gb: (20.0, 20.0), note: "Programación; el mayor de la familia." },
    OllamaModel { tag: "qwen3:4b", label: "Qwen 3 · 4B", vendor: "Qwen (Alibaba)", download_gb: (2.5, 2.5), note: "Ligero, con razonamiento opcional." },
    OllamaModel { tag: "qwen3:8b", label: "Qwen 3 · 8B", vendor: "Qwen (Alibaba)", download_gb: (5.2, 5.2), note: "Uso general con razonamiento opcional." },
    OllamaModel { tag: "qwen3:14b", label: "Qwen 3 · 14B", vendor: "Qwen (Alibaba)", download_gb: (9.3, 9.3), note: "Uso general con razonamiento opcional." },
    OllamaModel { tag: "qwen3:30b", label: "Qwen 3 · 30B", vendor: "Qwen (Alibaba)", download_gb: (19.0, 19.0), note: "Mezcla de expertos: calidad alta respondiendo rápido." },
    OllamaModel { tag: "qwen3-vl:8b", label: "Qwen3 VL · 8B", vendor: "Qwen (Alibaba)", download_gb: (6.1, 6.1), note: "Visión: describe imágenes y capturas de pantalla." },
    OllamaModel { tag: "huihui_ai/qwen3-abliterated:8b", label: "Qwen 3 abliterated · 8B", vendor: "Comunidad (huihui_ai)", download_gb: (5.0, 5.0), note: "Qwen 3 sin las negativas del original («abliterated»). Para experimentar: responde lo que el original rechaza." },
    OllamaModel { tag: "huihui_ai/qwen3-abliterated:14b", label: "Qwen 3 abliterated · 14B", vendor: "Comunidad (huihui_ai)", download_gb: (9.0, 9.0), note: "Qwen 3 sin las negativas del original («abliterated»). Para experimentar: responde lo que el original rechaza." },
    OllamaModel { tag: "gemma3:4b", label: "Gemma 3 · 4B", vendor: "Gemma (Google)", download_gb: (3.4, 3.4), note: "Pequeño, con visión." },
    OllamaModel { tag: "gemma3:12b", label: "Gemma 3 · 12B", vendor: "Gemma (Google)", download_gb: (8.2, 8.2), note: "Texto e imagen." },
    OllamaModel { tag: "gemma3:27b", label: "Gemma 3 · 27B", vendor: "Gemma (Google)", download_gb: (17.0, 17.0), note: "Texto e imagen; el mayor de la familia." },
    OllamaModel { tag: "mistral:7b", label: "Mistral · 7B", vendor: "Mistral AI", download_gb: (4.4, 4.4), note: "Uso general, rápido." },
    OllamaModel { tag: "phi4-mini:3.8b", label: "Phi-4 mini · 3.8B", vendor: "Phi (Microsoft)", download_gb: (2.5, 2.5), note: "Ligero, con buen razonamiento y matemáticas." },
    OllamaModel { tag: "llama3.3:70b", label: "Llama 3.3 · 70B", vendor: "Llama (Meta)", download_gb: (43.0, 43.0), note: "Calidad alta; solo para equipos con mucha memoria o GPU de gama alta." },
    OllamaModel { tag: "granite4:micro", label: "Granite 4 · micro", vendor: "Granite (IBM)", download_gb: (2.1, 2.1), note: "Pequeño, pensado para herramientas y agentes." },
];

/// Memoria aproximada para cargar un modelo con un contexto normal: el peso
/// descargado más unos 2 GB de contexto y runtime, redondeado hacia arriba.
pub fn required_memory_gb(model: &OllamaModel) -> u32 {
    (model.download_gb.1 + 2.0).ceil() as u32
}

/// RAM total del equipo en GB, si el sistema la expone.
pub fn total_memory_gb() -> Option<f32> {
    static TOTAL: std::sync::OnceLock<Option<f32>> = std::sync::OnceLock::new();
    *TOTAL.get_or_init(|| {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        let bytes = system.total_memory();
        (bytes > 0).then(|| bytes as f32 / (1024.0 * 1024.0 * 1024.0))
    })
}

/// Texto de requisitos que acompaña a cada modelo en el panel, comparado con
/// la memoria de este equipo cuando se conoce.
pub fn requirements_hint(model: &OllamaModel, total_gb: Option<f32>) -> String {
    let (low, high) = model.download_gb;
    let download = if (high - low).abs() < f32::EPSILON {
        format!("{high:.1} GB")
    } else {
        format!("{low:.1}–{high:.1} GB")
    }
    .replace(".0 GB", " GB")
    .replace(".0–", "–");
    let needed = required_memory_gb(model);
    let verdict = match total_gb {
        Some(total) if total + 0.5 < needed as f32 => format!(
            " Este equipo tiene {total:.0} GB de RAM: no cabe entero en memoria y, sin una GPU con suficiente VRAM, irá muy lento o no arrancará."
        ),
        Some(total) if total < needed as f32 + 4.0 => format!(
            " Este equipo tiene {total:.0} GB de RAM: cabe justo; cierra otras aplicaciones mientras lo usas."
        ),
        Some(total) => format!(" Este equipo tiene {total:.0} GB de RAM: cabe con margen."),
        None => String::new(),
    };
    format!(
        "Descarga ≈ {download}. Necesita ≈ {needed} GB de memoria libre (RAM, o VRAM de la GPU para que responda rápido).{verdict}"
    )
}

/// Para qué sirve el modelo (la «descripción» del panel; los requisitos van
/// en la pista).
pub fn model_description(model: &OllamaModel) -> String {
    format!(
        "Modelo de {} para usar en local. {}",
        model.vendor, model.note
    )
}

/// `true` si el modelo ya está descargado (existe su manifiesto).
pub fn ollama_model_installed(models_dir: &Path, model: &str) -> bool {
    let Some((name, tag)) = model.rsplit_once(':') else {
        return false;
    };
    let mut path = models_dir.join("manifests");
    let parts: Vec<&str> = name.split('/').collect();
    match parts.as_slice() {
        [name] => path.extend(["registry.ollama.ai", "library", name]),
        [namespace, name] => path.extend(["registry.ollama.ai", namespace, name]),
        [host, rest @ ..] => {
            path.push(host);
            path.extend(rest);
        }
        [] => return false,
    }
    let unsafe_part = |part: &str| part.is_empty() || part == ".." || part.contains(['\\', '/']);
    if parts.iter().any(|part| unsafe_part(part)) || unsafe_part(tag) {
        return false;
    }
    path.join(tag).is_file()
}

/// Carpeta de modelos de Ollama: `OLLAMA_MODELS` si está definida (Ollama la
/// respeta igual) o `~/.ollama/models`.
pub fn ollama_models_dir() -> PathBuf {
    // La carpeta propia de WTerminal (`entornos/ia/ollama`) solo se usa si
    // aún no había modelos; entonces es la que verá `ollama serve` lanzado
    // desde una pestaña.
    let centralized = crate::process::extra_environment()
        .into_iter()
        .find(|(key, _)| key == "OLLAMA_MODELS")
        .map(|(_, value)| value.into());
    std::env::var_os("OLLAMA_MODELS")
        .or(centralized)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| crate::paths::home_dir().join(".ollama").join("models"))
}

/// Modelos descargados, con el nombre que acepta `ollama run`:
/// `qwen3.8:27b` para la biblioteca oficial, `usuario/modelo:etiqueta` para
/// los de la comunidad y `host/usuario/modelo:etiqueta` para otros registros
/// (por ejemplo `hf.co/...`). Ordenados y sin duplicados.
pub fn installed_ollama_models(models_dir: &Path) -> Vec<String> {
    let manifests = models_dir.join("manifests");
    let mut found = Vec::new();
    collect_manifests(&manifests, &manifests, 0, &mut found);
    found.sort();
    found.dedup();
    found
}

fn collect_manifests(root: &Path, dir: &Path, depth: usize, found: &mut Vec<String>) {
    // host/espacio/modelo/etiqueta: cuatro niveles bastan; no se recorre más
    // para no seguir árboles ajenos ni enlaces fuera de la carpeta.
    if depth > 5 || found.len() >= MAX_LOCAL_MODELS * 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_manifests(root, &path, depth + 1, found);
        } else if kind.is_file() {
            if let Some(name) = model_name_from_manifest(root, &path) {
                found.push(name);
            }
        }
    }
}

fn model_name_from_manifest(root: &Path, manifest: &Path) -> Option<String> {
    let parts: Vec<String> = manifest
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();
    let valid = |part: &String| {
        !part.is_empty()
            && !part.starts_with('.')
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    };
    if parts.len() < 4 || !parts.iter().all(valid) {
        return None;
    }
    let tag = &parts[parts.len() - 1];
    let name = &parts[parts.len() - 2];
    let host = &parts[0];
    let namespace = parts[1..parts.len() - 2].join("/");
    Some(if host == "registry.ollama.ai" && namespace == "library" {
        format!("{name}:{tag}")
    } else if host == "registry.ollama.ai" {
        format!("{namespace}/{name}:{tag}")
    } else {
        format!("{host}/{namespace}/{name}:{tag}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_with(
        installed: &'static [&'static str],
    ) -> (impl Fn(&str) -> bool, impl Fn(&str) -> Option<String>) {
        (
            move |exe: &str| installed.contains(&exe),
            move |exe: &str| Some(format!("C:/bin/{exe}.cmd")),
        )
    }

    #[test]
    fn solo_aparecen_las_clis_instaladas_y_como_interfaces_sin_alias() {
        let (is_installed, resolve_path) = probe_with(&["claude", "gemini"]);
        let envs = detect_ai_environments(
            "windows",
            &crate::language_env::Probe {
                is_installed: &is_installed,
                resolve_path: &resolve_path,
            },
            &[],
        );
        let ids: Vec<&str> = envs.iter().map(|env| env.id.as_str()).collect();
        assert_eq!(ids, vec!["ai:claude", "ai:gemini"]);
        for env in &envs {
            assert!(env.repl && env.no_auto_select && env.kind == ShellKind::Repl);
            assert_eq!(env.group, AI_GROUP);
        }
        assert_eq!(envs[0].exe, "C:/bin/claude.cmd");
    }

    #[test]
    fn cada_modelo_de_ollama_es_un_chat_que_lanza_ollama_run() {
        let (is_installed, resolve_path) = probe_with(&["ollama"]);
        let probe = crate::language_env::Probe {
            is_installed: &is_installed,
            resolve_path: &resolve_path,
        };
        let models = vec![
            "qwen3.8:27b".to_string(),
            "huihui_ai/qwen3-abliterated:8b".to_string(),
        ];
        let envs = detect_ai_environments("windows", &probe, &models);
        assert_eq!(envs.len(), 2);
        assert_eq!(envs[0].id, "ai:ollama:qwen3.8:27b");
        assert_eq!(envs[0].args, vec!["run", "qwen3.8:27b"]);
        assert_eq!(envs[1].label, "Ollama · huihui_ai/qwen3-abliterated:8b");
        // Sin Ollama instalado no se ofrecen sus modelos aunque queden en disco.
        let (none, resolve) = probe_with(&[]);
        let sin_ollama = detect_ai_environments(
            "windows",
            &crate::language_env::Probe {
                is_installed: &none,
                resolve_path: &resolve,
            },
            &models,
        );
        assert!(sin_ollama.is_empty());
    }

    #[test]
    fn el_catalogo_de_modelos_es_coherente_y_explica_los_requisitos() {
        let mut tags = std::collections::HashSet::new();
        for model in OLLAMA_MODELS {
            assert!(tags.insert(model.tag), "etiqueta repetida: {}", model.tag);
            assert!(model.tag.contains(':') && !model.tag.contains(' '));
            assert!(model.download_gb.0 > 0.0 && model.download_gb.0 <= model.download_gb.1);
            assert!(required_memory_gb(model) as f32 > model.download_gb.1);
        }
        assert!(
            tags.contains("qwen3.8:27b"),
            "el modelo pedido expresamente debe estar"
        );
        let qwen = OLLAMA_MODELS
            .iter()
            .find(|model| model.tag == "qwen3.8:27b")
            .unwrap();
        assert_eq!(required_memory_gb(qwen), 20);
        let poca = requirements_hint(qwen, Some(16.0));
        assert!(
            poca.contains("Descarga ≈ 18 GB")
                && poca.contains("≈ 20 GB")
                && poca.contains("no cabe"),
            "{poca}"
        );
        assert!(requirements_hint(qwen, Some(22.0)).contains("cabe justo"));
        assert!(requirements_hint(qwen, Some(64.0)).contains("cabe con margen"));
        let rango = OLLAMA_MODELS
            .iter()
            .find(|model| model.tag == "qwen3.5:9b")
            .unwrap();
        assert!(requirements_hint(rango, None).contains("Descarga ≈ 6.6–7.6 GB"));
    }

    #[test]
    fn un_modelo_descargado_se_reconoce_por_su_manifiesto() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir
            .path()
            .join("manifests/registry.ollama.ai/library/qwen3.8/27b");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(&manifest, "{}").unwrap();
        let community = dir
            .path()
            .join("manifests/registry.ollama.ai/huihui_ai/qwen3-abliterated/8b");
        std::fs::create_dir_all(community.parent().unwrap()).unwrap();
        std::fs::write(&community, "{}").unwrap();
        assert!(ollama_model_installed(dir.path(), "qwen3.8:27b"));
        assert!(ollama_model_installed(
            dir.path(),
            "huihui_ai/qwen3-abliterated:8b"
        ));
        assert!(!ollama_model_installed(dir.path(), "qwen3.8:35b"));
        assert!(!ollama_model_installed(dir.path(), "qwen3.8"));
        assert!(!ollama_model_installed(
            dir.path(),
            "../library/qwen3.8:27b"
        ));
    }

    #[test]
    fn los_manifiestos_dan_el_nombre_que_acepta_ollama_run() {
        let dir = tempfile::tempdir().unwrap();
        let manifests = dir.path().join("manifests");
        for relative in [
            "registry.ollama.ai/library/qwen3.8/27b",
            "registry.ollama.ai/library/gpt-oss/20b",
            "registry.ollama.ai/huihui_ai/qwen3-abliterated/8b",
            "hf.co/bartowski/Qwen3-8B-GGUF/Q4_K_M",
        ] {
            let path = manifests.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
        }
        // Basura que no es un manifiesto válido.
        std::fs::create_dir_all(manifests.join("registry.ollama.ai/library/.tmp")).unwrap();
        std::fs::write(manifests.join("suelto.json"), "{}").unwrap();
        assert_eq!(
            installed_ollama_models(dir.path()),
            vec![
                "gpt-oss:20b",
                "hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M",
                "huihui_ai/qwen3-abliterated:8b",
                "qwen3.8:27b",
            ]
        );
        assert!(installed_ollama_models(&dir.path().join("no-existe")).is_empty());
    }
}
