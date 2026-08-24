# Qué produce cada build

Una sola cosa por plataforma, a propósito:

| Plataforma | Artefacto | Cómo |
| --- | --- | --- |
| Windows portable | carpeta desempaquetada (`.exe` + DLL/host nativos + `scripts/`) | `npm run dist:win` |
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

## Recursos nativos y bundler

La build portable de Windows usa `tauri build --no-bundle`: los dos archivos de
ConPTY llegan junto al `.exe` porque `build.rs` los copia en cada compilación,
también en release. La build NSIS sí ejecuta el empaquetador y conserva además
el mapa `bundle.resources`, de modo que los recursos comunes y ConPTY entran
en el instalador. El script prepara `WebView2Loader.dll` antes de esa segunda
pasada porque MSVC lo deja inicialmente dentro de la salida de Cargo.

La build reúne estos binarios y recursos en la carpeta desempaquetada:

```
winslim-terminal.exe
conpty.dll
OpenConsole.exe
WebView2Loader.dll
scripts/
```

Dentro de `scripts/` se conservan los gestores integrados de Docker,
Kubernetes, SSH, servicios, red y ADB. Son parte de la aplicación: no deben
eliminarse aunque la carpeta portable siga siendo válida como ejecutable.

La carpeta portable no instala el runtime de WebView2: depende de que ese
runtime ya esté instalado en el sistema, como una aplicación Windows normal.
El instalador NSIS es la distribución adecuada
para equipos Windows recortados o sin conexión, porque instala WebView2 antes
de dejar lista la aplicación.

Los otros artefactos de `target/release` (`deps/`, `build/`, `.pdb`) son
artefactos de Cargo y no se distribuyen.
