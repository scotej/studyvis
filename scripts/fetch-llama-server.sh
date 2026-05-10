#!/usr/bin/env bash
# fetch-llama-server.sh — download pre-built llama-server binaries from a
# pinned llama.cpp release and lay them out for Tauri's `bundle.externalBin` +
# `bundle.resources` (V2-P1).
#
# Layout produced under src-tauri/binaries/:
#   llama-server-<rust-target-triple>(.exe)        ← the executable (externalBin)
#   llama-runtime-<rust-target-triple>/<libs...>   ← companion .dylib/.so/.dll (resources)
#
# At runtime the Rust sidecar code prepends the per-triple runtime dir to the
# OS-specific shared-library search path (DYLD_FALLBACK_LIBRARY_PATH /
# LD_LIBRARY_PATH / PATH) before spawning, so the binary's @rpath/@loader_path
# resolves the companions wherever Tauri places them.
#
# Default: download for the host platform's target triple. Pass `--all` to
# fetch every supported triple in one go (used by CI / release pipelines).
#
# Pinned to llama.cpp release tag b9095 (commit f3c3e0e9a087835639733485b8900b195ba4ca47).
# Bump LLAMA_RELEASE_TAG below + refresh SHA256s after running this script
# against fresh artifacts.
#
# macOS ships bash 3.2 which has no associative arrays, so this script uses
# case statements for the per-triple metadata.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BINARIES_DIR="${REPO_ROOT}/src-tauri/binaries"

LLAMA_RELEASE_TAG="b9095"
LLAMA_RELEASE_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}"

SUPPORTED_TRIPLES="aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu"

# Per-triple manifest — asset filename + SHA256 verified on 2026-05-10 against
# the official release. Keep these synchronized: when LLAMA_RELEASE_TAG bumps,
# refresh every entry by running `gh api repos/ggml-org/llama.cpp/releases/tags/<tag>`.
asset_name_for() {
  case "$1" in
    aarch64-apple-darwin)     echo "llama-${LLAMA_RELEASE_TAG}-bin-macos-arm64.tar.gz" ;;
    x86_64-apple-darwin)      echo "llama-${LLAMA_RELEASE_TAG}-bin-macos-x64.tar.gz" ;;
    x86_64-pc-windows-msvc)   echo "llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip" ;;
    x86_64-unknown-linux-gnu) echo "llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.tar.gz" ;;
    *) return 1 ;;
  esac
}
asset_sha256_for() {
  case "$1" in
    aarch64-apple-darwin)     echo "90fea82a8e712274adcdc90ceb6c993d959c1c49bbbb77b97584986c9e366bdd" ;;
    x86_64-apple-darwin)      echo "a9e6c3967d2d0d96b5a72a4b5610b14945d8b8448e510a4b3d012a3c7284566f" ;;
    x86_64-pc-windows-msvc)   echo "af06a08fd6d62d7333437d186642ea3c0d7bc41ca168b48d14cc0fcf8f0cf4af" ;;
    x86_64-unknown-linux-gnu) echo "167e12288da2dc4dcece7327010844edcfb18ee3a76eb45b2e232a04723865e6" ;;
    *) return 1 ;;
  esac
}
# Asset internal layout: macOS / Linux tar.gz contents are nested under
# `llama-<tag>/`; the Windows zip dumps every file at the archive root.
archive_prefix_for() {
  case "$1" in
    aarch64-apple-darwin|x86_64-apple-darwin|x86_64-unknown-linux-gnu)
      echo "llama-${LLAMA_RELEASE_TAG}/" ;;
    x86_64-pc-windows-msvc) echo "" ;;
    *) return 1 ;;
  esac
}
exe_suffix_for() {
  case "$1" in
    *windows*) echo ".exe" ;;
    *)        echo "" ;;
  esac
}

usage() {
  cat <<USAGE
Usage: $0 [--all] [--triple <rust-target-triple>] [--force]

  --all                    Fetch all supported triples (CI / release).
  --triple <triple>        Fetch a specific triple. Supported: ${SUPPORTED_TRIPLES}
  --force                  Re-download even if the binary is already present.
  -h, --help               Show this help.

With no arguments, fetches the host triple as reported by 'rustc --print host-tuple'.
USAGE
}

host_triple() {
  if ! command -v rustc >/dev/null 2>&1; then
    echo "fetch-llama-server: rustc not found on PATH; install Rust to autodetect target triple." >&2
    exit 1
  fi
  # Rust 1.84+ exposes --print host-tuple; fall back to parsing rustc -Vv for
  # older toolchains.
  if rustc --print host-tuple >/dev/null 2>&1; then
    rustc --print host-tuple
  else
    rustc -Vv | awk '/^host:/ {print $2}'
  fi
}

verify_sha256() {
  local file="$1" expected="$2" actual
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    echo "fetch-llama-server: neither shasum nor sha256sum available; cannot verify $file" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "fetch-llama-server: SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# Defined with `()` (subshell) instead of `{}` so the EXIT trap below fires
# exactly once per call when this function returns — a `RETURN` trap in the
# parent shell would also fire on every helper call (asset_name_for et al.)
# and wipe `$tmp` mid-extraction.
fetch_one() (
  triple="$1"
  if ! asset="$(asset_name_for "$triple")"; then
    echo "fetch-llama-server: unsupported triple '$triple' (supported: ${SUPPORTED_TRIPLES})" >&2
    exit 1
  fi
  sha="$(asset_sha256_for "$triple")"
  prefix="$(archive_prefix_for "$triple")"
  exe_suffix="$(exe_suffix_for "$triple")"

  target_bin="${BINARIES_DIR}/llama-server-${triple}${exe_suffix}"
  target_runtime="${BINARIES_DIR}/llama-runtime-${triple}"

  if [ -x "$target_bin" ] && [ -d "$target_runtime" ] && [ "$FORCE" != "1" ]; then
    echo "fetch-llama-server: $triple already populated at ${target_bin#${REPO_ROOT}/} (use --force to refetch)"
    exit 0
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  archive="${tmp}/${asset}"
  echo "fetch-llama-server: downloading $asset ..."
  curl -fL --progress-bar -o "$archive" "${LLAMA_RELEASE_BASE}/${asset}"
  verify_sha256 "$archive" "$sha"

  extract_dir="${tmp}/extracted"
  mkdir -p "$extract_dir"
  case "$asset" in
    *.tar.gz) tar -xzf "$archive" -C "$extract_dir" ;;
    *.zip)
      if ! command -v unzip >/dev/null 2>&1; then
        echo "fetch-llama-server: unzip not on PATH; cannot extract $asset" >&2
        exit 1
      fi
      unzip -q "$archive" -d "$extract_dir"
      ;;
    *) echo "fetch-llama-server: unknown archive type for $asset" >&2; exit 1 ;;
  esac

  source_root="${extract_dir}/${prefix}"
  if [ ! -d "$source_root" ]; then
    echo "fetch-llama-server: expected $source_root inside $asset" >&2
    exit 1
  fi

  mkdir -p "$BINARIES_DIR"
  rm -rf "$target_runtime"
  mkdir -p "$target_runtime"

  server_src="${source_root}llama-server${exe_suffix}"
  if [ ! -f "$server_src" ]; then
    echo "fetch-llama-server: expected llama-server${exe_suffix} inside ${source_root}" >&2
    exit 1
  fi
  cp "$server_src" "$target_bin"
  chmod +x "$target_bin"

  # Companion runtime libraries: every .dylib (mac), .so* (linux), or .dll
  # (windows) sitting next to llama-server. We deliberately exclude the other
  # llama-* CLIs (llama-cli, llama-tokenize, etc.) — V2 only spawns the server.
  shopt -s nullglob
  case "$triple" in
    *apple-darwin*)
      for f in "$source_root"*.dylib; do
        cp "$f" "$target_runtime/"
      done
      ;;
    *linux*)
      for f in "$source_root"*.so "$source_root"*.so.*; do
        cp "$f" "$target_runtime/"
      done
      ;;
    *windows*)
      for f in "$source_root"*.dll; do
        cp "$f" "$target_runtime/"
      done
      ;;
  esac
  shopt -u nullglob

  count="$(find "$target_runtime" -type f | wc -l | tr -d ' ')"
  echo "fetch-llama-server: $triple → $(basename "$target_bin") + $count companion libs"
)

FORCE=0
SELECTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) SELECTED="$SUPPORTED_TRIPLES"; shift ;;
    --triple)
      [ $# -ge 2 ] || { usage; exit 1; }
      SELECTED="${SELECTED} $2"
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done
if [ -z "${SELECTED// }" ]; then
  SELECTED="$(host_triple)"
fi

for t in $SELECTED; do
  fetch_one "$t"
done
