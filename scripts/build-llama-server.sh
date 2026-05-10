#!/usr/bin/env bash
# build-llama-server.sh — canonical reproducible build of llama-server from
# source for the host platform (V2-P1).
#
# This is the alternate path to `fetch-llama-server.sh`; both target the same
# pinned llama.cpp commit so artifacts are equivalent. Use fetch by default
# (faster, identical bytes on supported platforms); use build when:
#   - cross-compiling for a triple llama.cpp doesn't publish a CPU prebuild for
#   - you want a statically linked single-binary output (no companion dylibs)
#   - you need to verify the prebuilt binary's provenance independently
#
# Pinned commit: f3c3e0e9a087835639733485b8900b195ba4ca47 (release tag b9095).
# Output: src-tauri/binaries/llama-server-<rust-target-triple>(.exe)
# Static-build mode also wipes the matching src-tauri/binaries/llama-runtime-<triple>/
# directory because no companions are needed when BUILD_SHARED_LIBS=OFF.
#
# Required toolchain:
#   - cmake >= 3.18, ninja, git, a working C/C++ compiler matching the host triple
#   - For macOS: Apple-Silicon Macs build aarch64 natively; pass --x86 to
#     cross-build for x86_64-apple-darwin (universal SDK required).
#   - For Linux: gcc/clang with libstdc++ static archives (`libstdc++-*-pic-dev`
#     on Debian/Ubuntu).
#   - For Windows: build from a Windows host with MSVC; this script's --windows
#     flag exists for documentation only and is not exercised here.
#
# What we do NOT support: cross-compiling Linux/Windows from macOS in a single
# session. The release CI workflow runs this script on the matching matrix host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BINARIES_DIR="${REPO_ROOT}/src-tauri/binaries"

LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"
LLAMA_PINNED_COMMIT="f3c3e0e9a087835639733485b8900b195ba4ca47"
LLAMA_PINNED_TAG="b9095"

usage() {
  cat <<USAGE
Usage: $0 [--triple <rust-target-triple>] [--shared] [--clean]

  --triple <triple>  Build for a specific Rust target triple. Default: host.
  --shared           Build with BUILD_SHARED_LIBS=ON (matches the prebuilt
                     release layout — produces companion .dylib/.so/.dll).
                     Default: OFF (single static binary).
  --clean            Remove the working directory before building.
  -h, --help         Show this help.
USAGE
}

host_triple() {
  if ! command -v rustc >/dev/null 2>&1; then
    echo "build-llama-server: rustc not found on PATH; install Rust to autodetect target triple." >&2
    exit 1
  fi
  if rustc --print host-tuple >/dev/null 2>&1; then
    rustc --print host-tuple
  else
    rustc -Vv | awk '/^host:/ {print $2}'
  fi
}

TRIPLE=""
SHARED=0
CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --triple)
      [ $# -ge 2 ] || { usage; exit 1; }
      TRIPLE="$2"
      shift 2
      ;;
    --shared) SHARED=1; shift ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done
if [ -z "$TRIPLE" ]; then
  TRIPLE="$(host_triple)"
fi

case "$TRIPLE" in
  *apple-darwin*) PLATFORM="macos" ;;
  *linux*) PLATFORM="linux" ;;
  *windows*) PLATFORM="windows" ;;
  *) echo "build-llama-server: unsupported triple '$TRIPLE'" >&2; exit 1 ;;
esac

EXE_SUFFIX=""
[ "$PLATFORM" = "windows" ] && EXE_SUFFIX=".exe"

WORK_DIR="${REPO_ROOT}/.cache/llama.cpp-build/${TRIPLE}"
SRC_DIR="${WORK_DIR}/src"
BUILD_DIR="${WORK_DIR}/build"

if [ "$CLEAN" = "1" ]; then
  rm -rf "$WORK_DIR"
fi

mkdir -p "$WORK_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "build-llama-server: cloning llama.cpp into ${SRC_DIR} (this is large)"
  git clone --filter=blob:none "$LLAMA_REPO" "$SRC_DIR"
fi

git -C "$SRC_DIR" fetch --tags --quiet origin "$LLAMA_PINNED_COMMIT"
git -C "$SRC_DIR" checkout --quiet "$LLAMA_PINNED_COMMIT"
git -C "$SRC_DIR" submodule update --init --recursive --quiet

CMAKE_FLAGS=(
  "-S" "$SRC_DIR"
  "-B" "$BUILD_DIR"
  "-DCMAKE_BUILD_TYPE=Release"
  "-DLLAMA_BUILD_SERVER=ON"
  "-DLLAMA_BUILD_TESTS=OFF"
  "-DLLAMA_BUILD_EXAMPLES=OFF"
)
if [ "$SHARED" = "1" ]; then
  CMAKE_FLAGS+=("-DBUILD_SHARED_LIBS=ON")
else
  CMAKE_FLAGS+=("-DBUILD_SHARED_LIBS=OFF")
fi
case "$PLATFORM" in
  macos)
    CMAKE_FLAGS+=("-DGGML_METAL=ON")
    case "$TRIPLE" in
      aarch64-apple-darwin) CMAKE_FLAGS+=("-DCMAKE_OSX_ARCHITECTURES=arm64") ;;
      x86_64-apple-darwin)  CMAKE_FLAGS+=("-DCMAKE_OSX_ARCHITECTURES=x86_64") ;;
    esac
    ;;
  linux) CMAKE_FLAGS+=("-DGGML_BLAS=OFF") ;;
  windows) ;;
esac

if command -v ninja >/dev/null 2>&1; then
  CMAKE_FLAGS+=("-G" "Ninja")
fi

echo "build-llama-server: configuring (${TRIPLE}, shared=${SHARED}, commit=${LLAMA_PINNED_COMMIT:0:12})"
cmake "${CMAKE_FLAGS[@]}"
echo "build-llama-server: building llama-server"
cmake --build "$BUILD_DIR" --target llama-server --config Release --parallel

# llama.cpp's build emits llama-server under build/bin/ on macOS+Linux. On
# Windows it lands at build/bin/Release/llama-server.exe with MSVC.
SERVER_BIN=""
for candidate in \
  "${BUILD_DIR}/bin/llama-server${EXE_SUFFIX}" \
  "${BUILD_DIR}/bin/Release/llama-server${EXE_SUFFIX}"; do
  if [ -f "$candidate" ]; then
    SERVER_BIN="$candidate"
    break
  fi
done
if [ -z "$SERVER_BIN" ]; then
  echo "build-llama-server: cannot locate built llama-server${EXE_SUFFIX} under ${BUILD_DIR}/bin" >&2
  exit 1
fi

mkdir -p "$BINARIES_DIR"
TARGET_BIN="${BINARIES_DIR}/llama-server-${TRIPLE}${EXE_SUFFIX}"
TARGET_RUNTIME="${BINARIES_DIR}/llama-runtime-${TRIPLE}"
cp "$SERVER_BIN" "$TARGET_BIN"
chmod +x "$TARGET_BIN"

if [ "$SHARED" = "1" ]; then
  rm -rf "$TARGET_RUNTIME"
  mkdir -p "$TARGET_RUNTIME"
  case "$PLATFORM" in
    macos)
      shopt -s nullglob
      for f in "${BUILD_DIR}/bin/"*.dylib; do cp "$f" "$TARGET_RUNTIME/"; done
      shopt -u nullglob
      ;;
    linux)
      shopt -s nullglob
      for f in "${BUILD_DIR}/bin/"*.so "${BUILD_DIR}/bin/"*.so.*; do cp "$f" "$TARGET_RUNTIME/"; done
      shopt -u nullglob
      ;;
    windows)
      shopt -s nullglob
      for f in "${BUILD_DIR}/bin/"*.dll "${BUILD_DIR}/bin/Release/"*.dll; do cp "$f" "$TARGET_RUNTIME/"; done
      shopt -u nullglob
      ;;
  esac
  count="$(find "$TARGET_RUNTIME" -type f | wc -l | tr -d ' ')"
  echo "build-llama-server: $TRIPLE → $(basename "$TARGET_BIN") + $count companion libs"
else
  rm -rf "$TARGET_RUNTIME"
  echo "build-llama-server: $TRIPLE → $(basename "$TARGET_BIN") (statically linked, no companions)"
fi
