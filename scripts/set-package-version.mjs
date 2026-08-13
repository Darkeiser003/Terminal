import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = process.argv[2]?.trim();
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!version || !semver.test(version)) {
  throw new Error(
    "Indica una versión SemVer válida, por ejemplo 1.4.4 o 1.5.0-beta.1."
  );
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const packagePath = resolve(root, "package.json");
const lockPath = resolve(root, "package-lock.json");
const cargoTomlPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");

const packageJson = json(packagePath);
const packageLock = json(lockPath);
const cargoToml = readFileSync(cargoTomlPath, "utf8");
const cargoTomlVersion = /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m;
if (!cargoTomlVersion.test(cargoToml)) {
  throw new Error("No se pudo localizar la versión de src-tauri/Cargo.toml.");
}
const updatedToml = cargoToml.replace(cargoTomlVersion, `$1"${version}"`);

const cargoLock = readFileSync(cargoLockPath, "utf8");
const cargoLockVersion = /^(\[\[package\]\]\nname\s*=\s*"winslim-terminal"\nversion\s*=\s*)"[^"]+"/m;
if (!cargoLockVersion.test(cargoLock)) {
  throw new Error("No se pudo localizar la versión de src-tauri/Cargo.lock.");
}
const updatedLock = cargoLock.replace(cargoLockVersion, `$1"${version}"`);

// Todas las lecturas y validaciones se completan antes de escribir nada. Si un
// manifiesto estuviera corrupto, la versión anterior queda intacta en todos.
packageJson.version = version;
packageLock.version = version;
if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
writeJson(packagePath, packageJson);
writeJson(lockPath, packageLock);
writeFileSync(cargoTomlPath, updatedToml);
writeFileSync(cargoLockPath, updatedLock);

console.log(`Versión de paquete actualizada a ${version}.`);
