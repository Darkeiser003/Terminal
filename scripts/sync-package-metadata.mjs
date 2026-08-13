import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkOnly = process.argv.includes("--check");

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(resolve(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

const metadata = readJson("src-tauri/config/package-metadata.json");
const requiredStrings = [
  "brand",
  "productName",
  "mainBinaryName",
  "identifier",
  "description",
  "author",
  "license",
  "copyright",
  "shortDescription",
  "longDescription",
];
for (const key of requiredStrings) {
  if (typeof metadata[key] !== "string" || !metadata[key].trim()) {
    throw new Error(`package-metadata.json necesita el texto no vacío: ${key}`);
  }
  if (/[\r\n]/.test(metadata[key])) {
    throw new Error(`package-metadata.json no admite saltos de línea en ${key}.`);
  }
}
for (const key of ["repository", "homepage", "supportEmail"]) {
  if (typeof metadata[key] !== "string") {
    throw new Error(`package-metadata.json debe declarar ${key} como texto (puede estar vacío).`);
  }
}
if (!Array.isArray(metadata.credits) || !metadata.credits.every((entry) => typeof entry === "string")) {
  throw new Error("package-metadata.json debe declarar credits como una lista de textos.");
}

const packageJson = readJson("package.json");
const expectedPackage = {
  description: metadata.description,
  author: metadata.author,
  license: metadata.license,
};
const expectedRepository = metadata.repository
  ? { type: "git", url: metadata.repository }
  : undefined;
const expectedBugs = metadata.supportEmail
  ? { email: metadata.supportEmail }
  : undefined;

const tauri = readJson("src-tauri/tauri.conf.json");
const expectedTauri = {
  productName: metadata.productName,
  mainBinaryName: metadata.mainBinaryName,
  identifier: metadata.identifier,
  copyright: metadata.copyright,
  shortDescription: metadata.shortDescription,
  longDescription: metadata.longDescription,
};

const projectCatalog = readJson("src-tauri/config/project-catalog.json");
const expectedCatalog = {
  brand: metadata.brand,
  developers: metadata.credits,
};

const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const tomlString = (value) => JSON.stringify(value);
const expectedCargo = [
  [`description = ${tomlString(metadata.description)}`, /^description\s*=\s*"(?:[^"\\]|\\.)*"/m],
  [`authors = [${tomlString(metadata.author)}]`, /^authors\s*=\s*\[[^\]]*\]/m],
  [`license = ${tomlString(metadata.license)}`, /^license\s*=\s*"(?:[^"\\]|\\.)*"/m],
];

const mismatches = [];
for (const [key, value] of Object.entries(expectedPackage)) {
  if (packageJson[key] !== value) mismatches.push(`package.json:${key}`);
}
if (JSON.stringify(packageJson.repository) !== JSON.stringify(expectedRepository)) {
  mismatches.push("package.json:repository");
}
if (JSON.stringify(packageJson.homepage) !== JSON.stringify(metadata.homepage || undefined)) {
  mismatches.push("package.json:homepage");
}
if (JSON.stringify(packageJson.bugs) !== JSON.stringify(expectedBugs)) {
  mismatches.push("package.json:bugs");
}
for (const [key, value] of Object.entries(expectedTauri)) {
  const actual = ["copyright", "shortDescription", "longDescription"].includes(key)
    ? tauri.bundle?.[key]
    : tauri[key];
  if (actual !== value) mismatches.push(`src-tauri/tauri.conf.json:${key}`);
}
for (const [key, value] of Object.entries(expectedCatalog)) {
  if (JSON.stringify(projectCatalog[key]) !== JSON.stringify(value)) {
    mismatches.push(`src-tauri/config/project-catalog.json:${key}`);
  }
}
for (const [replacement, pattern] of expectedCargo) {
  if (!pattern.test(cargo) || !cargo.match(pattern)?.[0].includes(replacement.split(" = ")[1])) {
    mismatches.push(`src-tauri/Cargo.toml:${replacement.split(" = ")[0]}`);
  }
}

if (checkOnly) {
  if (mismatches.length) {
    throw new Error(`Metadatos desincronizados: ${mismatches.join(", ")}. Ejecuta npm run metadata:sync.`);
  }
  console.log("Metadatos del paquete verificados.");
  process.exit(0);
}

Object.assign(packageJson, expectedPackage);
if (expectedRepository) packageJson.repository = expectedRepository;
else delete packageJson.repository;
if (metadata.homepage) packageJson.homepage = metadata.homepage;
else delete packageJson.homepage;
if (expectedBugs) packageJson.bugs = expectedBugs;
else delete packageJson.bugs;
writeJson("package.json", packageJson);
Object.assign(tauri, {
  productName: expectedTauri.productName,
  mainBinaryName: expectedTauri.mainBinaryName,
  identifier: expectedTauri.identifier,
});
Object.assign(tauri.bundle, {
  copyright: expectedTauri.copyright,
  shortDescription: expectedTauri.shortDescription,
  longDescription: expectedTauri.longDescription,
});
writeJson("src-tauri/tauri.conf.json", tauri);
Object.assign(projectCatalog, expectedCatalog);
writeJson("src-tauri/config/project-catalog.json", projectCatalog);

let updatedCargo = cargo;
for (const [replacement, pattern] of expectedCargo) {
  updatedCargo = updatedCargo.replace(pattern, replacement);
}
writeFileSync(cargoPath, updatedCargo);

console.log("Metadatos del paquete sincronizados desde src-tauri/config/package-metadata.json.");
