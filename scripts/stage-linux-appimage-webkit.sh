#!/usr/bin/env bash
# Stage StudyVis's pinned WebRTC-enabled WebKitGTK runtime plus native helper
# executables behind stable, repo-relative paths for Tauri's AppImage bundler.
# Patched production WebKit resolves its subprocesses and injected bundle from
# studyvis-webkit-runtime beside the StudyVis executable inside the AppImage.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
target_root="$repo_root/src-tauri/target"

# shellcheck source=scripts/linux-webkit-runtime.env
source "$script_dir/linux-webkit-runtime.env"
# shellcheck source=scripts/linux-appimage-legal.env
source "$script_dir/linux-appimage-legal.env"
runtime_id="studyvis-webkitgtk-${STUDYVIS_WEBKIT_VERSION}-librice-${STUDYVIS_LIBRICE_VERSION}-r${STUDYVIS_WEBKIT_RUNTIME_REVISION}"
appimage_runtime_dirname=$STUDYVIS_WEBKIT_APPIMAGE_RUNTIME_DIRNAME
[[ $appimage_runtime_dirname == studyvis-webkit-runtime ]] || {
  die "invalid AppImage WebKit runtime directory name: $appimage_runtime_dirname"
}

for command_name in bash cmp find install node pkg-config realpath rm sha256sum wc; do
  command -v "$command_name" >/dev/null 2>&1 || {
    die "missing AppImage staging dependency: $command_name"
  }
done

normalize_path() {
  local name=$1
  local value=$2
  local mode=${3:-missing}
  [[ $value == /* ]] || die "$name must be an absolute path: $value"
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || die "$name contains a newline"
  if [[ $mode == existing ]]; then
    realpath --canonicalize-existing -- "$value"
  else
    realpath --canonicalize-missing -- "$value"
  fi
}

default_runtime_dir=$(bash "$script_dir/build-linux-webkit-runtime.sh" --print-prefix)
runtime_dir=$(normalize_path STUDYVIS_WEBKIT_RUNTIME_DIR \
  "${STUDYVIS_WEBKIT_RUNTIME_DIR:-$default_runtime_dir}" existing)
stage_root_input=${STUDYVIS_APPIMAGE_WEBKIT_STAGE_DIR:-$target_root/appimage-webkit}
[[ ! -L $stage_root_input ]] || die "refusing symlinked stage directory: $stage_root_input"
stage_root=$(normalize_path STUDYVIS_APPIMAGE_WEBKIT_STAGE_DIR \
  "$stage_root_input")

for protected_path in / "$repo_root" "$repo_root/src-tauri" "$target_root"; do
  [[ $stage_root != "$protected_path" ]] || die "refusing unsafe stage directory: $stage_root"
done
[[ ${stage_root##*/} == appimage-webkit* && ${stage_root%/*} != / ]] || {
  die "stage directory must be a dedicated appimage-webkit* directory below a parent: $stage_root"
}
[[ $(uname -m) == x86_64 ]] || die "the AppImage staging layout is pinned to x86_64"

runtime_marker="$runtime_dir/.studyvis-webkit-runtime"
runtime_libdir="$runtime_dir/usr/lib/x86_64-linux-gnu"
license_source="$runtime_dir/usr/share/licenses/studyvis-webkit-runtime"
runtime_manifest="$license_source/BUILD-MANIFEST.txt"

if [[ ! -f $runtime_marker || $(<"$runtime_marker") != "$runtime_id" ]]; then
  die "the pinned WebRTC-enabled WebKitGTK runtime is missing or stale: $runtime_dir (run scripts/build-linux-webkit-runtime.sh)"
fi
[[ -f $runtime_manifest && ! -L $runtime_manifest ]] || {
  die "pinned runtime build manifest is missing: $runtime_manifest"
}
if ! cmp -s "$runtime_manifest" <(bash "$script_dir/build-linux-webkit-runtime.sh" --print-manifest); then
  die "pinned runtime manifest does not match the repository source tuple and flags"
fi

required_helpers=(
  WebKitNetworkProcess
  WebKitWebProcess
  WebKitGPUProcess
)
source_dir=$(normalize_path WebKit-runtime-subprocess-directory \
  "$runtime_libdir/webkit2gtk-4.1" existing)
for helper in "${required_helpers[@]}"; do
  [[ -f $source_dir/$helper && -x $source_dir/$helper ]] || {
    die "pinned WebKitGTK subprocess is missing or not executable: $source_dir/$helper"
  }
done
injected_bundle="$source_dir/injected-bundle/libwebkit2gtkinjectedbundle.so"
[[ -f $injected_bundle ]] || die "pinned WebKitGTK injected bundle is missing: $injected_bundle"

required_libraries=(
  libwebkit2gtk-4.1.so.0
  libjavascriptcoregtk-4.1.so.0
  librice-proto.so.0
  librice-io.so.0
)
for library in "${required_libraries[@]}"; do
  [[ -e $runtime_libdir/$library ]] || {
    die "pinned WebKitGTK runtime library is missing: $runtime_libdir/$library"
  }
done

# linuxdeploy-plugin-gstreamer's AppRun hook expects these helpers below
# usr/lib/gstreamer1.0/gstreamer-1.0, even though the plugin stages its shared
# objects below usr/lib/gstreamer-1.0. Tauri maps this stable pair there.
gstreamer_helper_dir=${STUDYVIS_GSTREAMER_HELPERS_DIR:-}
if [[ -z $gstreamer_helper_dir ]] && command -v pkg-config >/dev/null 2>&1; then
  gstreamer_helper_dir=$(pkg-config --variable=pluginscannerdir gstreamer-1.0 2>/dev/null || true)
fi
[[ -n $gstreamer_helper_dir ]] || {
  die "could not locate GStreamer helpers; set STUDYVIS_GSTREAMER_HELPERS_DIR"
}
gstreamer_helper_dir=$(normalize_path STUDYVIS_GSTREAMER_HELPERS_DIR "$gstreamer_helper_dir" existing)
scanner="$gstreamer_helper_dir/gst-plugin-scanner"
ptp_helper="$gstreamer_helper_dir/gst-ptp-helper"
[[ -f $scanner && -x $scanner ]] || die "GStreamer plugin scanner is not executable: $scanner"
[[ -f $ptp_helper && -x $ptp_helper ]] || die "GStreamer PTP helper is not executable: $ptp_helper"

# The upstream linuxdeploy plugin copies every file in GSTREAMER_PLUGINS_DIR.
# Never point it at the system directory: the distro's broad packages also contain
# libav/x264/x265 and scores of codecs StudyVis neither needs nor has audited.
system_gstreamer_plugins=${STUDYVIS_SYSTEM_GSTREAMER_PLUGINS_DIR:-}
if [[ -z $system_gstreamer_plugins ]]; then
  system_gstreamer_plugins=$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)
fi
[[ -n $system_gstreamer_plugins ]] || {
  die "could not locate system GStreamer plugins; set STUDYVIS_SYSTEM_GSTREAMER_PLUGINS_DIR"
}
system_gstreamer_plugins=$(normalize_path STUDYVIS_SYSTEM_GSTREAMER_PLUGINS_DIR \
  "$system_gstreamer_plugins" existing)
plugin_manifest="$script_dir/linux-gstreamer-plugins.txt"
[[ -s $plugin_manifest && ! -L $plugin_manifest ]] || {
  die "curated GStreamer plugin manifest is missing: $plugin_manifest"
}

# libgstpipewire.so only reaches the AppImage because linuxdeploy follows its
# DT_NEEDED to libpipewire. PipeWire then opens its SPA plugins, context
# modules, and client configuration by name at runtime, which no dependency
# walk can discover, so they are staged from an explicit manifest instead
# (ISSUES.md I89).
pipewire_manifest="$script_dir/linux-pipewire-payload.txt"
[[ -s $pipewire_manifest && ! -L $pipewire_manifest ]] || {
  die "curated PipeWire payload manifest is missing: $pipewire_manifest"
}
pipewire_libdir=${STUDYVIS_PIPEWIRE_LIBDIR:-}
if [[ -z $pipewire_libdir ]]; then
  pipewire_libdir=$(pkg-config --variable=libdir libpipewire-0.3 2>/dev/null || true)
fi
[[ -n $pipewire_libdir ]] || die "could not locate the PipeWire libdir; set STUDYVIS_PIPEWIRE_LIBDIR"
pipewire_libdir=$(normalize_path STUDYVIS_PIPEWIRE_LIBDIR "$pipewire_libdir" existing)
pipewire_module_dir=${STUDYVIS_PIPEWIRE_MODULES_DIR:-}
if [[ -z $pipewire_module_dir ]]; then
  pipewire_module_dir=$(pkg-config --variable=moduledir libpipewire-0.3 2>/dev/null || true)
fi
[[ -n $pipewire_module_dir ]] || {
  die "could not locate PipeWire modules; set STUDYVIS_PIPEWIRE_MODULES_DIR"
}
pipewire_module_dir=$(normalize_path STUDYVIS_PIPEWIRE_MODULES_DIR "$pipewire_module_dir" existing)
# Debian and Ubuntu ship no libspa-0.2.pc, so the SPA plugin directory is
# derived from the library directory PipeWire itself reports rather than from
# a pkg-config module that only some distributions provide.
pipewire_spa_dir=$(normalize_path STUDYVIS_SPA_PLUGINS_DIR \
  "${STUDYVIS_SPA_PLUGINS_DIR:-$pipewire_libdir/spa-0.2}" existing)
pipewire_config_dir=$(normalize_path STUDYVIS_PIPEWIRE_CONFIG_DIR \
  "${STUDYVIS_PIPEWIRE_CONFIG_DIR:-/usr/share/pipewire}" existing)

# Compile-time WebKit fallbacks are deliberately /usr/bin. The AppImage patch
# first resolves the copies beside StudyVis's executable, so stage the exact
# FHS paths by default instead of trusting PATH lookup.
bwrap=$(normalize_path STUDYVIS_BWRAP_EXECUTABLE \
  "${STUDYVIS_BWRAP_EXECUTABLE:-/usr/bin/bwrap}" existing)
dbus_proxy=$(normalize_path STUDYVIS_DBUS_PROXY_EXECUTABLE \
  "${STUDYVIS_DBUS_PROXY_EXECUTABLE:-/usr/bin/xdg-dbus-proxy}" existing)
[[ -f $bwrap && -x $bwrap ]] || die "bubblewrap helper is not executable: $bwrap"
[[ -f $dbus_proxy && -x $dbus_proxy ]] || die "xdg-dbus-proxy helper is not executable: $dbus_proxy"
"$bwrap" --version >/dev/null
"$dbus_proxy" --version >/dev/null

license_files=(
  BUILD-MANIFEST.txt
  COPYING.LIB
  LICENSE-APPLE
  LICENSE-LGPL-2
  LICENSE-LGPL-2.1
  LIBRICE-THIRD-PARTY-NOTICES.json
  LIBRICE-THIRD-PARTY-NOTICES.txt
  librice-LICENSE-APACHE
  librice-LICENSE-MIT
  webkitgtk-appimage-sandbox.patch
  WEBKIT-LICENSE-FILES.sha256
  WEBKIT-THIRD-PARTY-LICENSES.txt
)
for license in "${license_files[@]}"; do
  [[ -f $license_source/$license && -s $license_source/$license ]] || {
    die "pinned runtime license/provenance material is missing: $license_source/$license"
  }
done
read -r staged_patch_sha256 _ < <(sha256sum "$license_source/webkitgtk-appimage-sandbox.patch")
[[ $staged_patch_sha256 == "$STUDYVIS_WEBKIT_PATCH_SHA256" ]] || {
  die "runtime patch evidence has the wrong SHA256: $staged_patch_sha256"
}
[[ $(wc -l <"$license_source/WEBKIT-LICENSE-FILES.sha256") -eq 59 ]] || {
  die "runtime WebKit license hash inventory is incomplete"
}
node "$script_dir/generate-librice-third-party-notices.mjs" --check \
  "$license_source" --expected-lock-sha "$STUDYVIS_LIBRICE_CARGO_LOCK_SHA256"
read -r librice_notice_sha256 _ < <(sha256sum "$license_source/LIBRICE-THIRD-PARTY-NOTICES.txt")
[[ $librice_notice_sha256 == "$STUDYVIS_LIBRICE_NOTICE_SHA256" ]] || {
  die "runtime librice notice has the wrong SHA256: $librice_notice_sha256"
}
read -r librice_notice_manifest_sha256 _ < <(
  sha256sum "$license_source/LIBRICE-THIRD-PARTY-NOTICES.json"
)
[[ $librice_notice_manifest_sha256 == "$STUDYVIS_LIBRICE_NOTICE_MANIFEST_SHA256" ]] || {
  die "runtime librice notice manifest has the wrong SHA256: $librice_notice_manifest_sha256"
}

# Refuse generated-directory symlinks: install(1) would otherwise follow them
# and write staged binaries outside the declared target tree.
stage_directories=(
  "$stage_root"
  "$stage_root/libraries"
  "$stage_root/processes"
  "$stage_root/processes/injected-bundle"
  "$stage_root/gstreamer"
  "$stage_root/gstreamer-plugins"
  "$stage_root/pipewire"
  "$stage_root/pipewire/spa"
  "$stage_root/pipewire/modules"
  "$stage_root/pipewire/config"
  "$stage_root/pipewire/libraries"
  "$stage_root/sandbox"
  "$stage_root/licenses"
  "$stage_root/notices"
)
for destination in "${stage_directories[@]}"; do
  [[ ! -L $destination ]] || die "refusing symlinked stage directory: $destination"
  install -d -- "$destination"
done

# The two linuxdeploy GStreamer inputs are whole-directory copies. Remove old
# regular files from both guarded generated directories before staging; an
# unexpected symlink/directory fails rather than being followed or packaged.
for generated_dir in "$stage_root/gstreamer-plugins" "$stage_root/gstreamer"; do
  while IFS= read -r -d '' stale; do
    [[ -f $stale && ! -L $stale ]] || die "unexpected staged GStreamer entry: $stale"
    rm -f -- "$stale"
  done < <(find "$generated_dir" -mindepth 1 -maxdepth 1 -print0)
done

declare -A staged_plugins=()
while IFS= read -r plugin_group || [[ -n $plugin_group ]]; do
  plugin_group=${plugin_group%%#*}
  plugin_group=${plugin_group//[[:space:]]/}
  [[ -n $plugin_group ]] || continue
  IFS='|' read -r -a candidates <<<"$plugin_group"
  selected=
  for candidate in "${candidates[@]}"; do
    [[ $candidate =~ ^libgst[A-Za-z0-9_.+-]+\.so$ ]] || {
      die "invalid curated GStreamer plugin name: $candidate"
    }
    if [[ -f $system_gstreamer_plugins/$candidate && ! -L $system_gstreamer_plugins/$candidate ]]; then
      selected=$candidate
      break
    fi
  done
  [[ -n $selected ]] || {
    die "none of the required GStreamer plugin alternatives exist: $plugin_group"
  }
  if [[ ! -v staged_plugins[$selected] ]]; then
    install -m 0755 -- "$system_gstreamer_plugins/$selected" \
      "$stage_root/gstreamer-plugins/$selected"
    staged_plugins[$selected]=1
  fi
done <"$plugin_manifest"
[[ ${#staged_plugins[@]} -ge 20 ]] || die "curated GStreamer plugin set is unexpectedly small"
for forbidden in libgstlibav.so libgstx264.so libgstx265.so; do
  [[ ! -e $stage_root/gstreamer-plugins/$forbidden ]] || {
    die "forbidden GStreamer codec entered the curated stage: $forbidden"
  }
done

# Drop a previous run's payload so a shortened manifest cannot leave an
# unlisted plugin or module behind in the bundle.
while IFS= read -r -d '' stale; do
  [[ -f $stale && ! -L $stale ]] || die "unexpected staged PipeWire entry: $stale"
  rm -f -- "$stale"
done < <(find "$stage_root/pipewire" -mindepth 1 -type f -print0)

declare -A staged_pipewire=()
while IFS= read -r payload_line || [[ -n $payload_line ]]; do
  payload_line=${payload_line%%#*}
  read -r payload_kind payload_path <<<"$payload_line"
  [[ -n ${payload_kind:-} ]] || continue
  [[ -n ${payload_path:-} ]] || die "PipeWire payload entry has no path: $payload_kind"
  [[ $payload_path =~ ^[A-Za-z0-9_][A-Za-z0-9_.+-]*(/[A-Za-z0-9_][A-Za-z0-9_.+-]*)?$ ]] || {
    die "invalid PipeWire payload path: $payload_path"
  }
  case $payload_kind in
    spa) payload_source="$pipewire_spa_dir/$payload_path" payload_stage=spa ;;
    module) payload_source="$pipewire_module_dir/$payload_path" payload_stage=modules ;;
    config) payload_source="$pipewire_config_dir/$payload_path" payload_stage=config ;;
    library) payload_source="$pipewire_libdir/$payload_path" payload_stage=libraries ;;
    *) die "unknown PipeWire payload kind: $payload_kind" ;;
  esac
  [[ -f $payload_source ]] || die "PipeWire payload entry is missing: $payload_source"
  payload_destination="$stage_root/pipewire/$payload_stage/$payload_path"
  [[ ! -v staged_pipewire[$payload_kind/$payload_path] ]] || {
    die "duplicate PipeWire payload entry: $payload_kind $payload_path"
  }
  install -D -m 0644 -- "$payload_source" "$payload_destination"
  staged_pipewire[$payload_kind/$payload_path]=1
done <"$pipewire_manifest"
# pw_context_new() treats every context.modules entry as mandatory, so a short
# payload fails closed at runtime rather than degrading.
[[ ${#staged_pipewire[@]} -ge 12 ]] || die "curated PipeWire payload is unexpectedly small"

library_destination="$stage_root/libraries"
for library in "${required_libraries[@]}"; do
  install -m 0755 "$runtime_libdir/$library" "$library_destination/$library"
done

process_destination="$stage_root/processes"
for helper in "${required_helpers[@]}"; do
  install -m 0755 "$source_dir/$helper" "$process_destination/$helper"
done
install -m 0644 "$injected_bundle" \
  "$process_destination/injected-bundle/libwebkit2gtkinjectedbundle.so"

install -m 0755 "$scanner" "$stage_root/gstreamer/gst-plugin-scanner"
install -m 0755 "$ptp_helper" "$stage_root/gstreamer/gst-ptp-helper"
install -m 0755 "$bwrap" "$stage_root/sandbox/bwrap"
install -m 0755 "$dbus_proxy" "$stage_root/sandbox/xdg-dbus-proxy"
for license in "${license_files[@]}"; do
  install -m 0644 "$license_source/$license" "$stage_root/licenses/$license"
done

declare -A notice_sources=(
  [APPIMAGEKIT-MIT.txt]="$script_dir/licenses/APPIMAGEKIT-MIT.txt"
  [LLAMA.CPP-MIT.txt]="$script_dir/licenses/LLAMA.CPP-MIT.txt"
  [TAURI-BINARY-RELEASES-MIT.txt]="$script_dir/licenses/TAURI-BINARY-RELEASES-MIT.txt"
  [WRY-MIT.txt]="$repo_root/src-tauri/vendor/wry/LICENSE-MIT"
  [WRY-APACHE-2.0.txt]="$repo_root/src-tauri/vendor/wry/LICENSE-APACHE"
)
declare -A notice_hashes=(
  [APPIMAGEKIT-MIT.txt]="$STUDYVIS_APPIMAGEKIT_LICENSE_SHA256"
  [LLAMA.CPP-MIT.txt]="$STUDYVIS_LLAMA_LICENSE_SHA256"
  [TAURI-BINARY-RELEASES-MIT.txt]="$STUDYVIS_TAURI_BINARY_RELEASES_LICENSE_SHA256"
  [WRY-MIT.txt]="$STUDYVIS_WRY_MIT_SHA256"
  [WRY-APACHE-2.0.txt]="$STUDYVIS_WRY_APACHE_SHA256"
)
for notice in "${!notice_sources[@]}"; do
  source_notice=${notice_sources[$notice]}
  [[ -s $source_notice && ! -L $source_notice ]] || die "runtime notice is missing: $source_notice"
  notice_sha=$(sha256sum "$source_notice")
  notice_sha=${notice_sha%% *}
  [[ $notice_sha == "${notice_hashes[$notice]}" ]] || {
    die "runtime notice has the wrong SHA256: $source_notice ($notice_sha)"
  }
  install -m 0644 "$source_notice" "$stage_root/notices/$notice"
done

echo "Staged $runtime_id from $runtime_dir"
echo "Staged production WebKit helpers for /usr/bin/$appimage_runtime_dirname"
echo "Staged GStreamer helpers from $gstreamer_helper_dir"
echo "Staged ${#staged_plugins[@]} curated GStreamer plugins from $system_gstreamer_plugins"
echo "Staged ${#staged_pipewire[@]} curated PipeWire payload entries from $pipewire_spa_dir," \
  "$pipewire_module_dir, $pipewire_config_dir, and $pipewire_libdir"
echo "Staged AppImage sandbox helpers from $bwrap and $dbus_proxy"
