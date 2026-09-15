import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const workflow = read('.github/workflows/fuzz.yml');
const project = read('.clusterfuzzlite/project.yaml');
const docker = read('.clusterfuzzlite/Dockerfile');
const build = read('.clusterfuzzlite/build.sh');
const fuzzManifest = read('fuzz/Cargo.toml');
const fuzzTarget = read('fuzz/fuzz_targets/github_target.rs');
const fuzzLock = read('fuzz/Cargo.lock');
const parserCrate = read('src-tauri/crates/github-target/src/lib.rs');
const applicationParser = read('src-tauri/src/projects/github.rs');
const packageManifest = JSON.parse(read('package.json'));
const ciWorkflow = read('.github/workflows/ci.yml');
const denyConfig = read('deny.toml');

assert.match(project, /^language:\s*rust\s*$/m);
assert.match(
  docker,
  /^FROM gcr\.io\/oss-fuzz-base\/base-builder-rust:latest@sha256:[a-f0-9]{64}\s*$/m,
  'La imagen oficial de ClusterFuzzLite debe fijarse al digest x86_64 verificado.',
);
assert.match(build, /cargo fuzz build --fuzz-dir fuzz -O github_target/);
assert.match(build, /\$OUT\/github_target/);
assert.match(fuzzManifest, /cargo-fuzz\s*=\s*true/);
assert.match(fuzzManifest, /name\s*=\s*"github_target"/);
assert.match(fuzzManifest, /github-target\s*=\s*\{\s*path\s*=\s*"\.\.\/src-tauri\/crates\/github-target"/);
assert.match(fuzzLock, /^version = 4\s*$/m);
assert.match(fuzzLock, /^name = "libfuzzer-sys"\s*$/m);
assert.match(ciWorkflow, /cargo audit --file fuzz\/Cargo\.lock/);
assert.match(ciWorkflow, /cargo deny --manifest-path fuzz\/Cargo\.toml check/);
assert.match(denyConfig, /name = "libfuzzer-sys"\s*\nallow = \["NCSA"\]/);
assert.match(fuzzTarget, /fuzz_target!/);
assert.match(fuzzTarget, /parse_github_target/);
assert.match(applicationParser, /pub use github_target::/);
assert.match(parserCrate, /pub fn parse_full_name\(/);
assert.match(parserCrate, /https:\/\//);
assert.match(parserCrate, /host\.eq_ignore_ascii_case\("github\.com"\)/);
assert.match(parserCrate, /segments\.iter\(\)\.any\(\|segment\| segment\.is_empty\(\)\)/);

const actionRefs = [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
assert(actionRefs.length >= 3, 'El flujo debe preparar fuentes y compilar/ejecutar ClusterFuzzLite.');
for (const ref of actionRefs) {
  assert.match(ref, /@[0-9a-f]{40}$/i, `Acción no fijada a SHA completo: ${ref}`);
}
assert.match(workflow, /actions\/build_fuzzers@884713a6c30a92e5e8544c39945cd7cb630abcd1/);
assert.match(workflow, /actions\/run_fuzzers@884713a6c30a92e5e8544c39945cd7cb630abcd1/);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /schedule:/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /fuzz-seconds:/);
assert.equal(packageManifest.scripts['fuzz:github-target']?.includes('cargo +nightly fuzz run --fuzz-dir fuzz github_target'), true);
assert.equal(packageManifest.scripts['test:github-target']?.includes('github-target/Cargo.toml'), true);
assert(statSync(resolve(root, '.clusterfuzzlite/build.sh')).isFile());

console.log('Fuzzing verificado: parser aislado, cargo-fuzz y ClusterFuzzLite en PR y ejecución periódica.');
