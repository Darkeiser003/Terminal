//! Si esta máquina puede virtualizar, y qué se lo impide si no.
//!
//! Módulo nuevo. Hace falta porque WSL2 y Docker Desktop no arrancan sin
//! virtualización, y hasta ahora la app los ofrecía igual: el usuario instalaba
//! Docker Desktop entero para descubrir después que su Windows no podía
//! ejecutarlo. Saberlo antes convierte un fallo desconcertante en un aviso.
//!
//! Son dos cosas distintas y se distinguen a propósito:
//!
//! - **El firmware.** VT-x / AMD-V activado en la BIOS. Sin esto no hay nada
//!   que hacer desde el sistema operativo: hay que entrar en la BIOS.
//! - **La plataforma del sistema.** Hyper-V y sus componentes. Esto sí se
//!   activa y se desactiva desde Windows, y es lo que una build recortada trae
//!   quitado.
//!
//! La diferencia importa: proponer un script que activa Hyper-V a alguien que
//! tiene la virtualización apagada en la BIOS es mandarle a dar una vuelta para
//! nada.

use std::time::Duration;

use serde::Serialize;

/// PowerShell tarda en arrancar y CIM en responder. Cinco segundos es de sobra
/// para dos consultas locales, y si no llega se informa de que no se sabe en vez
/// de bloquear la detección de entornos.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Qué se sabe de la virtualización de esta máquina. `None` en cada campo
/// significa "no se ha podido averiguar", que no es lo mismo que "no".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Virtualization {
    /// VT-x / AMD-V habilitado en la BIOS.
    pub firmware_enabled: Option<bool>,
    /// Hay un hipervisor corriendo (Hyper-V, WSL2, otro).
    pub hypervisor_present: Option<bool>,
}

impl Virtualization {
    /// La máquina no puede virtualizar y el motivo es el sistema, no la BIOS:
    /// es el único caso en el que tiene sentido ofrecer activarlo desde aquí.
    pub fn needs_platform_enabled(&self) -> bool {
        self.firmware_enabled == Some(true) && self.hypervisor_present == Some(false)
    }

    /// El firmware lo tiene desactivado. No se arregla desde Windows.
    ///
    /// Con Hyper-V en marcha, Windows corre YA ENCIMA del hipervisor y
    /// `VirtualizationFirmwareEnabled` pasa a informar `False` aunque la BIOS lo
    /// tenga activado: el sistema ha dejado de ver el ajuste real. Comprobado en
    /// esta máquina, que da `False` + hipervisor presente y virtualiza sin
    /// problemas. Si hay hipervisor, la lectura del firmware no significa nada.
    pub fn needs_firmware_enabled(&self) -> bool {
        self.firmware_enabled == Some(false) && self.hypervisor_present != Some(true)
    }

    /// Se puede virtualizar ahora mismo.
    pub fn is_ready(&self) -> bool {
        self.hypervisor_present == Some(true)
    }
}

/// Lee un booleano de la salida de PowerShell. `True`/`False` es lo que imprime
/// un `[bool]`; cualquier otra cosa es "no se sabe".
fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Interpreta la salida de la sonda: dos líneas, firmware e hipervisor.
pub fn parse_probe(output: &str) -> Virtualization {
    let mut lineas = output.lines().filter(|linea| !linea.trim().is_empty());
    Virtualization {
        firmware_enabled: lineas.next().and_then(parse_bool),
        hypervisor_present: lineas.next().and_then(parse_bool),
    }
}

/// Pregunta al sistema UNA vez por arranque.
///
/// La consulta cuesta ~2,3 s (arrancar PowerShell y dos consultas a CIM) y el
/// panel de dependencias la pedía en cada apertura. Cachearla es correcto
/// además de barato: activar o desactivar Hyper-V exige reiniciar Windows, así
/// que la respuesta no puede cambiar mientras el proceso siga vivo.
pub fn detect() -> Virtualization {
    static CACHE: once_cell::sync::Lazy<Virtualization> = once_cell::sync::Lazy::new(probe);
    *CACHE
}

fn probe() -> Virtualization {
    if !cfg!(windows) {
        return Virtualization::default();
    }
    // Dos propiedades de CIM, una por línea. `Win32_Processor` puede devolver
    // varias entradas en máquinas con más de un socket: basta con la primera,
    // porque el firmware se activa para toda la placa.
    let script = "$p = @(Get-CimInstance Win32_Processor)[0]; \
                  $c = Get-CimInstance Win32_ComputerSystem; \
                  Write-Output $p.VirtualizationFirmwareEnabled; \
                  Write-Output $c.HypervisorPresent";
    let salida = crate::process::output_text(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
        PROBE_TIMEOUT,
    );
    if salida.is_none() {
        // No es un error que merezca molestar: el resumen simplemente no dirá
        // nada de virtualización. Queda en el log por si alguien investiga.
        log_debug!("La sonda de virtualización no respondió");
    }
    salida.as_deref().map(parse_probe).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_sonda_se_lee_como_dos_booleanos_en_orden() {
        let v = parse_probe("True\nFalse\n");
        assert_eq!(v.firmware_enabled, Some(true));
        assert_eq!(v.hypervisor_present, Some(false));
    }

    #[test]
    fn una_propiedad_vacia_se_queda_en_no_se_sabe_y_no_en_no() {
        // Win32_Processor.VirtualizationFirmwareEnabled viene vacio en algunas
        // maquinas virtuales y en Windows antiguos. Tratarlo como "false" haria
        // que la app dijera que no se puede virtualizar cuando no lo sabe.
        let v = parse_probe("\nTrue\n");
        assert_eq!(v.firmware_enabled, Some(true));
        assert_eq!(v.hypervisor_present, None);
        let vacia = parse_probe("");
        assert_eq!(vacia.firmware_enabled, None);
        assert_eq!(vacia.hypervisor_present, None);
        assert!(!vacia.needs_platform_enabled());
        assert!(!vacia.needs_firmware_enabled());
    }

    #[test]
    fn solo_se_ofrece_activar_la_plataforma_cuando_el_firmware_ya_esta() {
        // Proponer activar Hyper-V a quien tiene VT-x apagado en la BIOS es
        // mandarle a dar una vuelta para nada: Windows no puede arreglarlo.
        let sin_bios = parse_probe("False\nFalse");
        assert!(!sin_bios.needs_platform_enabled());
        assert!(sin_bios.needs_firmware_enabled());

        let con_bios = parse_probe("True\nFalse");
        assert!(con_bios.needs_platform_enabled());
        assert!(!con_bios.needs_firmware_enabled());
    }

    #[test]
    fn con_hipervisor_en_marcha_no_se_manda_a_nadie_a_la_bios() {
        // Windows sobre Hyper-V informa firmware=False aunque la BIOS lo tenga
        // activado: ha dejado de ver el ajuste real. Es lo que da esta misma
        // maquina, que virtualiza perfectamente.
        let sobre_hipervisor = parse_probe("False\nTrue");
        assert!(sobre_hipervisor.is_ready());
        assert!(!sobre_hipervisor.needs_firmware_enabled());
        assert!(!sobre_hipervisor.needs_platform_enabled());
    }

    #[test]
    fn con_el_hipervisor_en_marcha_no_hay_nada_que_ofrecer() {
        let lista = parse_probe("True\nTrue");
        assert!(lista.is_ready());
        assert!(!lista.needs_platform_enabled());
        assert!(!lista.needs_firmware_enabled());
    }

    #[test]
    fn no_se_sabe_si_hay_hipervisor_no_significa_que_este_listo() {
        let dudosa = parse_probe("True");
        assert!(!dudosa.is_ready());
        assert!(!dudosa.needs_platform_enabled());
    }
}
