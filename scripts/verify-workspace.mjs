import { accessSync, constants, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = ["src-tauri"];
const optional = ["node_modules", "node_modules/.vite-temp", "dist", "src-tauri/target"];

function display(path) {
  return relative(root, path) || ".";
}

function permissionHint(path) {
  if (process.platform === "win32") {
    return `Cierra los procesos que usen ${display(path)} y comprueba que tu cuenta tenga permisos de modificación.`;
  }
  return `Corrige su propietario o permisos, por ejemplo: sudo chown -R $(id -un):$(id -gn) ${display(path)}`;
}

function assertWritable(path) {
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    const probe = mkdtempSync(join(path, ".winslim-write-check-"));
    rmSync(probe, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `No se puede escribir en ${display(path)}: ${error.message}. ${permissionHint(path)}`
    );
  }
}

function assertNoForeignCacheEntries(path) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const pending = [path];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      const stat = lstatSync(child);
      if (stat.uid !== uid) {
        throw new Error(
          `La caché contiene un archivo de otro usuario: ${display(child)}. ${permissionHint(path)}`
        );
      }
      if (entry.isDirectory()) pending.push(child);
    }
  }
}

for (const relativePath of required) {
  assertWritable(resolve(root, relativePath));
}

for (const relativePath of optional) {
  const path = resolve(root, relativePath);
  try {
    accessSync(path, constants.F_OK);
    assertWritable(path);
    if (["node_modules", "src-tauri/target"].includes(relativePath)) {
      assertNoForeignCacheEntries(path);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

if (process.platform !== "win32") {
  const linuxBuild = resolve(root, "linux/build.sh");
  try {
    accessSync(linuxBuild, constants.X_OK);
  } catch {
    throw new Error(
      `linux/build.sh no es ejecutable. Aplica: chmod u+x ${display(linuxBuild)}`
    );
  }
}

// Comprueba que el directorio temporal del sistema también admite escrituras;
// Vite, Cargo y los empaquetadores lo utilizan incluso cuando el proyecto está
// perfectamente configurado.
const tempProbe = mkdtempSync(join(tmpdir(), "winslim-write-check-"));
rmSync(tempProbe, { recursive: true, force: true });

console.log("Espacio de trabajo verificable: permisos de caché, salida y temporales correctos.");
