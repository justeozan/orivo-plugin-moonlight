#!/bin/sh
# Rebuild the committed GameStream runner component and print the two values
# `package/manifest.json` has to agree with.
#
# Three things make that digest reproducible rather than a local accident, and
# all three are checked or applied below instead of being described in a comment:
#
#   * the compiler is pinned by `rust-toolchain.toml`, and this script refuses to
#     run under any other one — a floating `stable` would change the artefact six
#     weeks later with no source change to explain it;
#   * `wasm-tools` is pinned to the release whose component encoding matches the
#     wasmtime the host depends on (see `orivo/src-tauri/fixtures/README.md`),
#     and the version is *verified*, not just the binary's presence;
#   * every absolute path the compiler would otherwise bake in — the toolchain's
#     own sources, the cargo registry, this directory — is remapped, so the bytes
#     do not depend on whose machine or whose home directory built them.
#
# Requires:
#   cargo install wasm-tools --locked --version 1.246.2
# and the pinned toolchain with its sources, which rustup installs on demand:
#   rustup toolchain install 1.98.1 --component rust-src --target wasm32-unknown-unknown
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/package/component.wasm"
MODULE="$HERE/target/wasm32-unknown-unknown/release/orivo_gamestream_runner.wasm"
WASM_TOOLS_VERSION=1.246.2

command -v wasm-tools >/dev/null 2>&1 || {
  echo "build.sh: wasm-tools is not on PATH (cargo install wasm-tools --locked --version $WASM_TOOLS_VERSION)" >&2
  exit 2
}
have_wasm_tools=$(wasm-tools --version | awk '{print $2}')
[ "$have_wasm_tools" = "$WASM_TOOLS_VERSION" ] || {
  echo "build.sh: wasm-tools $have_wasm_tools is not the pinned $WASM_TOOLS_VERSION; the component" >&2
  echo "          encoding has to match the host's wasmtime, and the digest would differ." >&2
  echo "          cargo install wasm-tools --locked --version $WASM_TOOLS_VERSION" >&2
  exit 2
}

cd "$HERE"
# One source of truth for the pin: the file rustup itself reads.
PINNED_RUSTC=$(awk -F'"' '/^channel/ {print $2}' rust-toolchain.toml)
have_rustc=$(rustc --version | awk '{print $2}')
[ "$have_rustc" = "$PINNED_RUSTC" ] || {
  echo "build.sh: rustc $have_rustc is not the pinned $PINNED_RUSTC, so the digest this prints" >&2
  echo "          would not be the one package/manifest.json declares." >&2
  echo "          rustup toolchain install $PINNED_RUSTC --target wasm32-unknown-unknown" >&2
  exit 2
}
rustup target list --installed | grep -qx wasm32-unknown-unknown || {
  echo "build.sh: rustup target add wasm32-unknown-unknown" >&2
  exit 2
}
# `rust-src` decides bytes of the artefact (see `orivo/plugins/ryujinx/build.sh`
# for the full account of why), which is why it is a requirement and not a
# convenience.
[ -f "$(rustc --print sysroot)/lib/rustlib/src/rust/library/alloc/src/str.rs" ] || {
  echo "build.sh: the rust-src component is missing, and the digest depends on it" >&2
  echo "          (rustup component add rust-src)." >&2
  exit 2
}

# Paths the compiler embeds in panic locations and debug info. Without these the
# artefact carries the absolute path of whoever built it — a home directory in a
# file whose whole job is to be byte-identical everywhere.
SYSROOT=$(rustc --print sysroot)
CARGO_REGISTRY=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="--remap-path-prefix=$SYSROOT/lib/rustlib/src/rust=/rust\
 --remap-path-prefix=$CARGO_REGISTRY/registry=/cargo/registry\
 --remap-path-prefix=$HERE=/orivo-plugin-moonlight"
export RUSTFLAGS

cargo build --release --target wasm32-unknown-unknown --locked
wasm-tools component new "$MODULE" -o "$OUT"
# Producers and component-type sections are build provenance, not contract.
# Dropping them keeps the committed artefact small and byte-stable across
# toolchain patch releases, which is what makes a committed digest reproducible.
wasm-tools strip -d 'producers' -d 'component-type.*' "$OUT" -o "$OUT.stripped"
mv "$OUT.stripped" "$OUT"
wasm-tools validate --features component-model "$OUT"

# A remap that silently stopped working would be invisible in the digest, so the
# script looks for what it is supposed to have removed.
if LC_ALL=C grep -q "$HOME" "$OUT"; then
  echo "build.sh: the component still embeds an absolute path from this machine." >&2
  exit 1
fi

printf '%s  %s  %s bytes\n' \
  "$(shasum -a 256 "$OUT" | cut -d' ' -f1)" \
  "component.wasm" \
  "$(wc -c <"$OUT" | tr -d ' ')"
echo
echo 'Paste both into package/manifest.json (artifacts[0].sha256 / byteSize) and'
echo 'nothing else: orivo-plugin-sdk validate checks them against the file, so a'
echo 'stale digest fails before anything else does.'
