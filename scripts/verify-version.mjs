import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function readCargoVersion(relativePath) {
  const text = readFileSync(resolve(root, relativePath), "utf8");
  const pattern = relativePath.endsWith("Cargo.lock")
    ? /^name\s*=\s*"winslim-terminal"\s*\nversion\s*=\s*"([^"]+)"/m
    : /^version\s*=\s*"([^"]+)"/m;
  const match = text.match(pattern);
  if (!match) throw new Error(`No se encontró version en ${relativePath}`);
  return match[1];
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json (raíz)", packageLock.packages?.[""].version],
  ["src-tauri/Cargo.toml", readCargoVersion("src-tauri/Cargo.toml")],
  ["src-tauri/Cargo.lock", readCargoVersion("src-tauri/Cargo.lock")],
]);

const unique = new Set(versions.values());
if (unique.size !== 1 || [...unique][0] == null) {
  console.error("Las versiones del proyecto no están unificadas:");
  for (const [file, version] of versions) console.error(`  ${file}: ${version ?? "<ausente>"}`);
  process.exit(1);
}

console.log(`Versión unificada: ${[...unique][0]}`);
