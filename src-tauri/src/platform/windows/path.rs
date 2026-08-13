use std::path::PathBuf;
use std::time::Duration;

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
use winreg::RegKey;

const REGISTRY_PATH_KEYS: [&str; 2] = [
    r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    r"HKCU\Environment",
];

pub(super) fn find_executable(command: &str) -> Option<PathBuf> {
    let output = crate::process::output_text("where", &[command], Duration::from_millis(1500))?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

pub(super) fn persistent_path_entries() -> Vec<String> {
    REGISTRY_PATH_KEYS
        .iter()
        .filter_map(|key| query_registry_path(key))
        .flat_map(|value| {
            expand_env_vars(&value)
                .split(';')
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn query_registry_path(key: &str) -> Option<String> {
    let (root, relative) = if let Some(relative) = key.strip_prefix("HKLM\\") {
        (RegKey::predef(HKEY_LOCAL_MACHINE), relative)
    } else {
        let relative = key.strip_prefix("HKCU\\")?;
        (RegKey::predef(HKEY_CURRENT_USER), relative)
    };
    let subkey = root
        .open_subkey_with_flags(relative, KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    subkey.get_value::<String, _>("Path").ok()
}

fn expand_env_vars(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup_env_ignore_case(name) {
                    Some(resolved) => output.push_str(&resolved),
                    None => {
                        output.push('%');
                        output.push_str(name);
                        output.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                output.push('%');
                output.push_str(after);
                return output;
            }
        }
    }
    output.push_str(rest);
    output
}

fn lookup_env_ignore_case(name: &str) -> Option<String> {
    std::env::vars()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conserva_variables_desconocidas() {
        std::env::set_var("WINSLIM_TEST_ROOT", r"C:\Test");
        assert_eq!(
            expand_env_vars(r"%WINSLIM_TEST_ROOT%\bin;%NO_EXISTE_SEGURO%\y"),
            r"C:\Test\bin;%NO_EXISTE_SEGURO%\y"
        );
        std::env::remove_var("WINSLIM_TEST_ROOT");
    }

    #[test]
    fn un_porcentaje_suelto_no_rompe_la_expansion() {
        assert_eq!(expand_env_vars(r"C:\100%"), r"C:\100%");
    }
}
