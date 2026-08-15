#!/usr/bin/env bash
# Fill an isolated Tauri cache with the exact audited linuxdeploy toolset.
# A mutable upstream URL is acceptable only because its downloaded bytes are
# checked before they can be executed.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <absolute-XDG_CACHE_HOME>" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linuxdeploy-tools.env
source "$script_dir/linuxdeploy-tools.env"
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"

for command_name in bash curl install mktemp realpath sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing tool-cache dependency: $command_name"
done

cache_home=$1
[[ $cache_home == /* && $cache_home != *$'\n'* && $cache_home != *$'\r'* && $cache_home != *$'\t'* ]] || {
  die "XDG cache path must be absolute and contain no control whitespace"
}
cache_home=$(realpath --canonicalize-missing -- "$cache_home")
[[ ${cache_home##*/} == studyvis-tauri-cache* && ${cache_home%/*} != / ]] || {
  die "refusing non-dedicated Tauri cache path: $cache_home"
}
cache_dir="$cache_home/tauri"
runtime_build_dir="$cache_home/studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}"
[[ ! -L $cache_home && ! -L $cache_dir ]] || die "refusing symlinked Tauri cache"
[[ ! -L $runtime_build_dir ]] || die "refusing symlinked AppImage runtime build directory"
install -d -m 0755 -- "$cache_home" "$cache_dir"

install_verified() {
  local name=$1
  local url=$2
  local expected_sha=$3
  local mode=$4
  [[ $expected_sha =~ ^[0-9a-f]{64}$ ]] || die "invalid pinned SHA256 for $name"
  [[ $url == https://* ]] || die "tool URL is not HTTPS: $url"
  local destination="$cache_dir/$name"
  local actual_sha
  if [[ -f $destination && ! -L $destination ]]; then
    actual_sha=$(sha256sum -- "$destination")
    actual_sha=${actual_sha%% *}
    if [[ $actual_sha == "$expected_sha" ]]; then
      chmod "$mode" "$destination"
      echo "Verified cached $name ($actual_sha)"
      return
    fi
  fi

  local temporary
  temporary=$(mktemp "$cache_dir/.${name}.XXXXXX")
  trap 'rm -f -- "$temporary"' RETURN
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    --output "$temporary" -- "$url"
  actual_sha=$(sha256sum -- "$temporary")
  actual_sha=${actual_sha%% *}
  [[ $actual_sha == "$expected_sha" ]] || {
    die "$name SHA256 mismatch: expected $expected_sha, got $actual_sha"
  }
  install -m "$mode" -- "$temporary" "$destination"
  rm -f -- "$temporary"
  trap - RETURN
  echo "Installed verified $name ($actual_sha)"
}

install_verified AppRun-x86_64 \
  "$STUDYVIS_APPRUN_URL" "$STUDYVIS_APPRUN_SHA256" 0755
install_verified linuxdeploy-x86_64.AppImage \
  "$STUDYVIS_LINUXDEPLOY_URL" "$STUDYVIS_LINUXDEPLOY_SHA256" 0755
install_verified linuxdeploy-plugin-appimage.AppImage \
  "$STUDYVIS_APPIMAGE_PLUGIN_URL" "$STUDYVIS_APPIMAGE_PLUGIN_SHA256" 0755
install_verified linuxdeploy-plugin-gstreamer.sh \
  "$STUDYVIS_GSTREAMER_PLUGIN_URL" "$STUDYVIS_GSTREAMER_PLUGIN_SHA256" 0755
install_verified linuxdeploy-plugin-gtk.sh \
  "$STUDYVIS_GTK_PLUGIN_URL" "$STUDYVIS_GTK_PLUGIN_SHA256" 0755

if [[ ! -e $runtime_build_dir && ! -L $runtime_build_dir ]]; then
  runtime_args=(--output "$runtime_build_dir")
  if [[ -n ${STUDYVIS_APPIMAGE_RUNTIME_SOURCE_CACHE:-} ]]; then
    runtime_args+=(--source-cache "$STUDYVIS_APPIMAGE_RUNTIME_SOURCE_CACHE")
  fi
  bash "$script_dir/build-linux-appimage-runtime.sh" "${runtime_args[@]}"
fi
bash "$script_dir/verify-linux-appimage-runtime.sh" "$runtime_build_dir"

printf 'studyvis-linuxdeploy-toolset-r%s\n' "$STUDYVIS_LINUXDEPLOY_TOOLSET_REVISION" \
  >"$cache_dir/.studyvis-linuxdeploy-toolset"
