#!/usr/bin/env bash
# Refreshes upstream/ — the GPLv2 source golaberto-odds.wasm is built from —
# from galo2099/golaberto at UPSTREAM_REV with odds-wasm.patch applied. Only the
# two crates the module links (odds-rust, stats/core) and the licence are kept.
set -euo pipefail

UPSTREAM=https://github.com/galo2099/golaberto
UPSTREAM_REV=397c3aba6a115d88c02817808d409edc1f47625e

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$UPSTREAM" "$UPSTREAM_REV"
git -C "$work/src" -c advice.detachedHead=false checkout -q FETCH_HEAD
git -C "$work/src" apply "$here/odds-wasm.patch"

out="$work/upstream"
mkdir -p "$out/odds-rust" "$out/stats/core"
cp "$work/src/COPYING" "$out/"
cp -R "$work/src/odds-rust/"{Cargo.toml,Cargo.lock,README.md,src,tests,examples,third_party} "$out/odds-rust/"
cp -R "$work/src/stats/core/"{Cargo.toml,Cargo.lock,src,tests} "$out/stats/core/"

rm -rf "$here/upstream"
mv "$out" "$here/upstream"
