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
