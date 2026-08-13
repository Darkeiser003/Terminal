# Estructura y limpieza del repositorio

La raíz se reserva para los archivos que las herramientas necesitan descubrir
automáticamente: `README.md`, manifiestos de npm, configuración de Vite/Svelte,
`index.html` y ficheros de control de versiones. No se colocan allí recursos de
la aplicación, documentación adicional, cachés ni resultados de compilación.

```text
docs/        documentación de arquitectura, mantenimiento y distribución
linux/       empaquetado y recursos exclusivos de Linux
scripts/     verificadores y automatización de desarrollo
src/         frontend Svelte
src-tauri/   backend Rust, configuración y recursos empaquetados
windows/     empaquetado y recursos exclusivos de Windows
```

Se ignoran explícitamente `node_modules/`, `dist/`, `release/`,
`src-tauri/target/`, salidas de Vite, cobertura, logs y el estado local de
Codex/editores. No deben versionarse ni requerir `sudo` para borrarse. Antes de
una build, `npm run check:workspace` comprueba que el usuario actual pueda
escribir sus salidas y cachés. Si no puede, muestra una solución concreta en
lugar de modificar propietarios o permisos de forma automática.

Los iconos y recursos de Tauri viven únicamente bajo `src-tauri/icons/` y
`src-tauri/vendor/`; así no existen copias en la raíz que puedan divergir del
paquete final.
