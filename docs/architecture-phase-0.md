# Fase 0 — segmentación Linux, Windows y dominios compartidos

## Estado: completada

La Fase 0 define una frontera de plataforma compilada y una estructura física
por dominio. La migración conserva los nombres de módulo de la API interna con
reexportaciones temporales; no cambia comandos Tauri, formatos JSON ni el
frontend.

```text
src-tauri/src/
├── app/              comandos generales y estado Tauri
├── config/           identidad, rutas, preferencias, migración e i18n
├── environments/     shells, Docker, Android, lenguajes y modelos WSL
├── explorer/         árbol de archivos y catálogo de visores
├── infrastructure/   logging, proceso compartido y caché de PATH
├── packages/         catálogo, alias y acciones de instalación
├── platform/         adaptadores compilados por host
│   ├── linux/        PATH ejecutable y adaptadores del host
│   ├── windows/      Registro/PATH, ConPTY, WSL, PowerShell y NSudo
│   ├── recycle.rs    papelera por sistema
│   ├── system_info.rs
│   └── traits.rs     capacidades pequeñas de proceso y PATH
├── projects/         GitHub, descargas y comandos de proyectos
├── scripts/          análisis, favoritos y lanzamiento de scripts
├── system/           modelos y políticas de virtualización
├── terminal/         PTY, pestañas, sesión, flujo y rutas de shell
└── updater/          consulta y aplicación de actualizaciones
```

## Reglas de frontera

- `platform/mod.rs` elige una sola implementación al compilar. El binario
  Linux no incluye Registro, ConPTY, WSL, PowerShell ni NSudo; el de Windows no
  incluye comprobaciones de permisos ejecutables Unix.
- `ProcessPlatform` encapsula procesos sin consola, procesos desacoplados y
  ConPTY. `PathPlatform` encapsula separador, normalización, búsqueda y PATH
  persistente.
- Los dominios mantienen modelos, parseadores, cachés y catálogos. Las acciones
  de paquetes que construyen comandos para una plataforma objetivo permanecen
  en `packages`: son reglas puras y se prueban sin tocar el host.
- Las reexportaciones de `lib.rs` son una capa de compatibilidad interna. El
  código nuevo debe importar su dominio real; se eliminarán las reexportaciones
  cuando los consumidores internos hayan migrado sin cambiar contratos.

## Rendimiento y estabilidad garantizados

- El arranque rápido crea solo shells nativas.
- El inventario completo ejecuta WSL, Docker, Android, lenguajes y gestor de
  paquetes en paralelo, con sus propios plazos y cachés.
- En Linux, `run_wsl`, virtualización Windows, Registro, ConPTY y NSudo son
  adaptadores nulos compilados sin procesos externos.
- En Windows no se exploran gestores de paquetes Linux.
- La caché de ejecutables y la deduplicación del PATH son comunes y no se
  duplican entre sistemas.
- Las operaciones de abrir archivos/carpetas y papelera pasan por `platform`.

## Comprobaciones obligatorias

```text
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cargo check --target x86_64-pc-windows-gnu
```

La siguiente fase puede empezar sobre esta estructura. Cambios futuros de
dominio deben preservar la frontera: código que ejecute procesos del sistema,
lea el Registro, consulte WSL, gestione ConPTY o dependa de permisos Unix va a
`platform`, no a un módulo de negocio.
