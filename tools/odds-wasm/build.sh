#!/usr/bin/env bash
# Rebuilds ../../computations/golaberto-odds.wasm from upstream/ (vendor.sh
# writes it). Needs Rust 1.94.1 with the wasm32-wasip1 target (rustup reads
# rust-toolchain.toml); the output is byte-identical across runs and checkouts.
set -euo pipefail

TOOLCHAIN=1.94.1

here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../computations/golaberto-odds.wasm"
cd "$here"

version=$(rustc --version)
[[ $version == "rustc $TOOLCHAIN "* ]] || { echo "need rustc $TOOLCHAIN, found: $version" >&2; exit 1; }

cargo_home=${CARGO_HOME:-$HOME/.cargo}
# Path prefixes leak into panic messages; map them to fixed names.
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/odds-wasm"
cargo build --locked --release --target wasm32-wasip1

install -m 0644 target/wasm32-wasip1/release/golaberto-odds.wasm "$out"
shasum -a 256 "$out"
