# Qué produce cada build

Una sola cosa por plataforma, a propósito:

| Plataforma | Artefacto | Cómo |
| --- | --- | --- |
| Windows | carpeta desempaquetada (`.exe` + `conpty.dll` + `OpenConsole.exe`) | `npm run dist:win` |
| Linux | `.AppImage` | `npm run dist:linux` |

Lo que **no** se genera, y por qué:

- **Instalador NSIS en Windows.** Instalaba en `Program Files`, pedía permisos
  de administrador y creaba accesos directos en el escritorio y en el menú
  inicio. La app se distribuye como carpeta: se copia donde se quiera y se
  ejecuta. `bundle.active: false` en `tauri.windows.conf.json` lo garantiza —
  no depende de acordarse de pasar `--no-bundle`.
- **MSI**, **portable** de un solo archivo, **.deb** y **.rpm**. Ninguno estaba
  en `bundle.targets` y ninguno debe estar.
- **Accesos directos.** Ni los del instalador ni los que creaban los scripts de
  build al terminar. Quien quiera uno se lo hace.

## conpty.dll sin bundler

`bundle.resources` solo lo aplica el empaquetador, que en Windows ya no corre.
Los dos archivos llegan igualmente junto al `.exe` porque `build.rs` los copia
en cada compilación, también en release. El mapa de `bundle.resources` se
conserva por si algún día se vuelve a empaquetar: sin él, una build con
instalador dejaría la app instalada sin poder abrir ni una pestaña.

Quien monte la carpeta desempaquetada tiene que llevarse los tres archivos de
`src-tauri/target/release/`:

```
winslim-terminal.exe
conpty.dll
OpenConsole.exe
```

El resto de esa carpeta (`deps/`, `build/`, `.pdb`) son artefactos de cargo y
no se distribuyen.
