#!/usr/bin/env bash
# Build an unsigned local AppImage on Arch/CachyOS. linuxdeploy's embedded
# binutils predates rolling-distro DT_RELR sections, so local packaging must
# skip its redundant strip pass; Cargo has already produced the optimized
# release binary. Official release artifacts are still built on Ubuntu 24.04.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
runtime_dir="$repo_root/src-tauri/binaries/llama-runtime-x86_64-unknown-linux-gnu"
sidecar="$repo_root/src-tauri/binaries/llama-server-x86_64-unknown-linux-gnu"
webkit_builder="$script_dir/build-linux-webkit-runtime.sh"
stage_root="$repo_root/src-tauri/target/appimage-webkit"

command -v pkg-config >/dev/null 2>&1 || {
  echo "error: pkg-config is required for the pinned WebKitGTK runtime" >&2
  exit 1
}

if [[ ! -x "$sidecar" || ! -d "$runtime_dir" ]]; then
  echo "error: the real Linux llama-server runtime is required for a release-profile bundle" >&2
  echo "  run: bash scripts/fetch-llama-server.sh --triple x86_64-unknown-linux-gnu" >&2
  exit 1
fi

# Build or reuse the pinned WebRTC-enabled WebKitGTK first, then make its
# rebased pkg-config metadata visible to the Rust/Tauri link. A sysroot is
# intentionally forbidden here: it would also rewrite host GTK and Wayland
# package paths into the runtime prefix.
bash "$webkit_builder"
webkit_prefix=$(bash "$webkit_builder" --print-prefix)
webkit_pkgconfig=$(bash "$webkit_builder" --print-pkg-config-path)
webkit_libdir="$webkit_prefix/usr/lib/x86_64-linux-gnu"
unset PKG_CONFIG_SYSROOT_DIR
export PKG_CONFIG_PATH="$webkit_pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
resolved_webkit_libdir=$(pkg-config --variable=libdir webkit2gtk-4.1)
if [[ $resolved_webkit_libdir != "$webkit_libdir" ]]; then
  echo "error: pkg-config did not resolve the pinned WebKitGTK runtime" >&2
  echo "  expected: $webkit_libdir" >&2
  echo "  actual:   $resolved_webkit_libdir" >&2
  exit 1
fi

export LD_LIBRARY_PATH="$webkit_libdir:$runtime_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export NO_STRIP=1
export GSTREAMER_PLUGINS_DIR="$stage_root/gstreamer-plugins"
export GSTREAMER_HELPERS_DIR="$stage_root/gstreamer"
export XDG_CACHE_HOME="${STUDYVIS_TAURI_CACHE_HOME:-$repo_root/src-tauri/target/studyvis-tauri-cache}"
bash "$script_dir/prepare-linuxdeploy-tools.sh" "$XDG_CACHE_HOME"
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"
export LDAI_RUNTIME_FILE="$XDG_CACHE_HOME/studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}/runtime-x86_64"

cd "$repo_root"
exec "$repo_root/node_modules/.bin/tauri" build \
  --bundles appimage \
  --config '{"bundle":{"createUpdaterArtifacts":false}}' \
  "$@"
