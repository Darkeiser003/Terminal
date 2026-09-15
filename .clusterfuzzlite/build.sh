#!/bin/bash -eu

cd "$SRC/lterminal"
cargo fuzz build --fuzz-dir fuzz -O github_target
cp fuzz/target/x86_64-unknown-linux-gnu/release/github_target "$OUT/github_target"
