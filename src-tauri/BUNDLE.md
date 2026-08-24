# Qué produce cada build

Una sola cosa por plataforma, a propósito:

| Plataforma | Artefacto | Cómo |
| --- | --- | --- |
| Windows portable | carpeta desempaquetada (`.exe` + `conpty.dll` + `OpenConsole.exe` + `WebView2Loader.dll`) | `npm run dist:win` |
| Windows instalable | instalador NSIS con WebView2 offline | `npm run dist:win:installer` |
| Linux | `.AppImage` | `npm run dist:linux` |

Lo que **no** se genera, y por qué:

- **Instalador NSIS en la build portable.** La build normal sigue sin instalar
  nada ni tocar el registro. Cuando se necesite máxima compatibilidad en
  equipos sin WebView2, `dist:win:installer` activa una configuración separada
  que incluye el instalador offline de WebView2 y genera un NSIS.
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

Quien monte la carpeta desempaquetada tiene que llevarse los cuatro archivos de
`src-tauri/target/release/`:

```
winslim-terminal.exe
conpty.dll
OpenConsole.exe
WebView2Loader.dll
```

La carpeta portable no instala el runtime de WebView2: depende de que ese
runtime ya esté instalado en el sistema, como una aplicación Windows normal.
El instalador NSIS es la distribución adecuada
para equipos Windows recortados o sin conexión, porque instala WebView2 antes
de dejar lista la aplicación.

El resto de esa carpeta (`deps/`, `build/`, `.pdb`) son artefactos de cargo y
no se distribuyen.
