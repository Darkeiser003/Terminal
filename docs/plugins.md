# Plugins declarativos

LTerminal y WinSlim Terminal cargan plugins desde la carpeta `plugins` de los
datos de usuario. Cada plugin ocupa una carpeta y contiene un único
`plugin.json`. Se puede instalar, activar, desactivar y retirar desde Ajustes.
Al retirarlo se mueve a `plugin-backups`; no se borra de forma irreversible.

Los plugins no cargan DLL, JavaScript nativo ni código Rust. Aportan definiciones
de REPL que pasan por los mismos límites, validaciones y detección de PATH que el
catálogo integrado. El formato inicial es:

```json
{
  "schemaVersion": 1,
  "id": "mi-repl",
  "name": "Mi REPL",
  "version": "1.0.0",
  "description": "Añade un intérprete local",
  "technologies": [{
    "id": "mi-lenguaje", "label": "Mi lenguaje", "category": "plugin",
    "windowsExe": "mi-repl.exe", "unixExe": "mi-repl", "args": []
  }]
}
```

Los identificadores usan minúsculas, números y guiones. Se admiten como máximo
100 tecnologías por plugin, 32 argumentos por tecnología y 64 plugins. Un
manifest no puede superar 256 KiB.

## Crear un plugin local

La plantilla mínima está en
`examples/plugins/custom-repl/plugin.json`. Para crear otro plugin:

1. Copia esa carpeta y cambia `id`, `name`, `version` y la lista
   `technologies`.
2. Declara únicamente ejecutables que el usuario pueda instalar por su cuenta:
   `windowsExe` para Windows y `unixExe` para Linux/macOS.
3. Prueba el manifest con un ejecutable real en el `PATH` y después instálalo
   desde Ajustes → Plugins → Instalar plugin.json.
4. Actívalo, pulsa la actualización de entornos y comprueba que aparece en el
   selector de REPLs.

El plugin no se copia al repositorio de la aplicación ni ejecuta código dentro
de ella. Al retirarlo se conserva una copia en `plugin-backups`, y un manifest
inválido se muestra desactivado para poder corregirlo sin perderlo.

Los manifests válidos se incluyen al exportar un perfil portable desde Ajustes.
Al importarlo se vuelven a validar, se restauran en la carpeta de plugins y se
conserva su estado activado/desactivado; los ejecutables declarados no se
copian ni se ejecutan automáticamente.

## Alcance y evolución

La versión actual es deliberadamente declarativa: añade REPLs y sus argumentos,
pero no puede crear paneles, registrar comandos, modificar archivos ni ejecutar
JavaScript, DLL o Rust. Esta frontera permite desarrollar plugins sin convertir
cada manifest en código con permisos completos.

La base queda preparada para una segunda versión compatible con capacidades
explícitas, por ejemplo `repl`, `quick-action` o `dependency`, siempre con
validación por capacidad, permisos visibles y ejecución a través de los mismos
catálogos y listas blancas que usa la aplicación. No se debe añadir carga de
código nativo o scripts arbitrarios al sistema de plugins.
