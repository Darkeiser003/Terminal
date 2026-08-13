import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(root, "src-tauri/src");
const expectedRootFiles = new Set(["lib.rs", "main.rs"]);
const requiredDomains = [
  "app",
  "config",
  "environments",
  "explorer",
  "infrastructure",
  "packages",
  "platform",
  "projects",
  "scripts",
  "system",
  "terminal",
  "updater"
];

const rootRustFiles = readdirSync(sourceRoot)
  .filter((entry) => entry.endsWith(".rs"))
  .sort();
const unexpectedRootFiles = rootRustFiles.filter((entry) => !expectedRootFiles.has(entry));

if (unexpectedRootFiles.length > 0) {
  throw new Error(
    `Módulos Rust fuera de su dominio: ${unexpectedRootFiles.join(", ")}. ` +
      "Colócalos bajo el dominio correspondiente y expónlos desde su mod.rs."
  );
}

const missingDomains = requiredDomains.filter(
  (domain) => !existsSync(resolve(sourceRoot, domain, "mod.rs"))
);
if (missingDomains.length > 0) {
  throw new Error(`Dominios sin índice mod.rs: ${missingDomains.join(", ")}`);
}

for (const platform of ["linux", "windows"]) {
  if (!existsSync(resolve(sourceRoot, "platform", platform, "mod.rs"))) {
    throw new Error(`Falta el adaptador de plataforma: src/platform/${platform}/mod.rs`);
  }
}

const forbiddenRootDirectories = ["icons"];
const rootEntries = new Set(readdirSync(root));
const duplicatedResourceFolders = forbiddenRootDirectories.filter((entry) => rootEntries.has(entry));
if (duplicatedResourceFolders.length > 0) {
  throw new Error(
    `Recursos de aplicación fuera de su dominio: ${duplicatedResourceFolders.join(", ")}. ` +
      "Guárdalos bajo src-tauri/ o src/ y elimina la copia de la raíz."
  );
}

const rootArtifacts = [...rootEntries].filter((entry) =>
  /\.(?:rs|png|jpe?g|gif|ico|icns|dll|exe)$/i.test(entry)
);
if (rootArtifacts.length > 0) {
  throw new Error(
    `Archivos de aplicación fuera de su dominio: ${rootArtifacts.join(", ")}. ` +
      "La raíz solo admite los manifiestos y configuraciones necesarios."
  );
}

console.log("Arquitectura verificada: dominios segmentados, recursos ordenados y adaptadores presentes.");
