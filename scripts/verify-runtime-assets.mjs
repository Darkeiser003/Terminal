import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  "src-tauri/vendor/conpty/conpty.dll",
  "src-tauri/vendor/conpty/OpenConsole.exe",
  "src-tauri/default_settings.toml",
  "src-tauri/config/technology-catalog.json",
  "src-tauri/resources/com.lterminal.terminal.metainfo.xml",
  "scripts/operations/ssh-manager.sh",
  "scripts/operations/ssh-manager.ps1",
  "scripts/operations/service-manager.sh",
  "scripts/operations/service-manager.ps1",
  "scripts/operations/network-manager.sh",
  "scripts/operations/network-manager.ps1",
  "scripts/operations/adb-manager.sh",
  "scripts/operations/adb-manager.ps1",
  "scripts/operations/docker-manager.ps1",
  "scripts/operations/kubernetes-manager.ps1",
];

for (const relativePath of required) {
  const path = resolve(root, relativePath);
  try {
    accessSync(path, constants.R_OK);
    if (statSync(path).size === 0) {
      throw new Error("el archivo está vacío");
    }
  } catch (error) {
    throw new Error(`Recurso de ejecución incompleto: ${relativePath} (${error.message})`);
  }
}

const technologies = JSON.parse(
  readFileSync(resolve(root, "src-tauri/config/technology-catalog.json"), "utf8")
);
if (!Array.isArray(technologies) || technologies.length === 0) {
  throw new Error("El catálogo modular de tecnologías está vacío o no es una lista.");
}
const technologyIds = new Set();
for (const [index, item] of technologies.entries()) {
  for (const field of ["id", "label", "category", "windowsExe", "unixExe"]) {
    if (typeof item?.[field] !== "string" || item[field].trim() === "") {
      throw new Error(`Tecnología ${index}: campo obligatorio inválido (${field}).`);
    }
  }
  if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Tecnología ${item.id}: args debe ser una lista de textos.`);
  }
  if (technologyIds.has(item.id)) throw new Error(`ID de tecnología duplicado: ${item.id}`);
  technologyIds.add(item.id);
}

const windowsConfig = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.windows.conf.json"), "utf8")
);
const resources = windowsConfig.bundle?.resources ?? {};
for (const resource of ["vendor/conpty/conpty.dll", "vendor/conpty/OpenConsole.exe"]) {
  if (!(resource in resources)) {
    throw new Error(
      `El paquete de Windows no declara el recurso obligatorio: ${resource}`
    );
  }
}

const linuxConfig = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.linux.conf.json"), "utf8")
);
if (
  linuxConfig.productName !== "LTerminal" ||
  linuxConfig.mainBinaryName !== "lterminal" ||
  linuxConfig.identifier !== "com.lterminal.terminal"
) {
  throw new Error("La configuración Linux no conserva la identidad de LTerminal.");
}
const linuxMetainfo = readFileSync(
  resolve(root, "src-tauri/resources/com.lterminal.terminal.metainfo.xml"),
  "utf8"
);
for (const marker of [
  "<id>com.lterminal.terminal</id>",
  "<name>LTerminal</name>",
  "<launchable type=\"desktop-id\">LTerminal.desktop</launchable>",
]) {
  if (!linuxMetainfo.includes(marker)) {
    throw new Error(`Metadatos Linux incompletos: falta ${marker}`);
  }
}

console.log(`Recursos verificados: ConPTY, paquete Windows, valores de fábrica y ${technologies.length} tecnologías modulares.`);
