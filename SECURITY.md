# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.0   | :white_check_mark: |

## Reporting a Vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Darkeiser003/Terminal/security/advisories/new).
Do not publish exploit details in a public issue. If private reporting is not
available for the repository, contact the repository owner before disclosure.

## Tracked transitive dependency advisory

The Linux Tauri/Wry GTK 3 and WebKitGTK dependency chain currently resolves
`glib 0.18.5`, which is affected by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
RustSec lists `glib >=0.20.0` as patched. The current upstream work to move Wry
to GTK 4 and WebKitGTK 6 is tracked in
[tauri-apps/wry#1474](https://github.com/tauri-apps/wry/issues/1474); as checked
on 2026-09-15, it is still open. This cannot be fixed safely by changing only
the lockfile because the current GTK 3 dependency constraints require the
older GLib line. `cargo audit` should continue reporting this advisory; do not
silence it. Reassess it when Tauri/Wry ships a supported migration, then test
the Linux UI and both platform builds before release.

The same dependency graph currently reports unmaintained `proc-macro-error`
through GTK 3 macros and the `unic-*` crates through Tauri's `urlpattern`
dependency. These are upstream transitives, not direct application dependencies;
keep them visible in audit output and revisit them with the GLib/Tauri migration
rather than suppressing the warnings locally.
