# Security Policy

## Supported versions

Security fixes are prepared for the latest stable release.

| Version | Supported |
|---------|-----------|
| 1.0.0   | Yes       |

Older versions may not receive security updates. Update to the latest release
and verify its published hashes and signature.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Report privately through
[GitHub Security Advisories](https://github.com/Darkeiser003/Terminal/security/advisories/new)
or email `tebarcascallarromen@gmail.com` with the subject “LTerminal security
vulnerability”. Include the affected version, operating system, reproduction
steps, and observed impact; do not attach personal data or secrets.

LTerminal is maintained by one person. There is no response-time or support
guarantee; reports will be acknowledged and coordinated when possible. Do not
publicly disclose exploit details until a publication date has been agreed with
the maintainer.

## Tracked transitive dependency advisories

The Linux Tauri/Wry GTK 3 and WebKitGTK dependency chain resolves `glib 0.18.5`,
which is affected by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429). The
advisory reports unsound `Iterator` and `DoubleEndedIterator` implementations
for `glib::VariantStrIter`; RustSec lists `glib >=0.20.0` as patched. The
current GTK 3 bindings require the `glib 0.18` line, so changing only the
lockfile to 0.20 would create an incompatible dependency graph. LTerminal does
not call this iterator directly, but the advisory remains open and must not be
silenced or described as fixed. Reassess it when Tauri/Wry supports a compatible
patched GTK/WebKit stack, then test the Linux UI and both platform builds before
release. The upstream migration is tracked in
[tauri-apps/wry#1474](https://github.com/tauri-apps/wry/issues/1474); it is still
open as of 2026-09-15. `cargo audit` reports the advisory in CI.

The dependency graph also reports unmaintained `proc-macro-error` through GTK 3
macros and `unic-*` crates through Tauri's `urlpattern` dependency. These are
transitive upstream dependencies rather than direct application dependencies;
they remain visible in audit output and should be revisited with the Tauri/Wry
migration.

## Política en español

No publiques detalles explotables en un issue público. Usa el reporte privado
de vulnerabilidades de GitHub o escribe a `tebarcascallarromen@gmail.com` con
el asunto «Vulnerabilidad de LTerminal». Incluye la versión afectada, el
sistema operativo, pasos de reproducción y el impacto observado; no adjuntes
datos personales ni secretos. LTerminal lo mantiene una sola persona, sin plazo
de respuesta ni garantía de soporte. No divulgues detalles explotables hasta
acordar una fecha de publicación.
