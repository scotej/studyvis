#!/usr/bin/env bash
# Validate the native runtime surface inside one exact StudyVis AppImage.
# Extraction avoids a FUSE dependency and packaged-only GStreamer paths keep
# host plugins from making an incomplete artifact look healthy.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
# shellcheck source=scripts/linux-webkit-runtime.env
source "$script_dir/linux-webkit-runtime.env"
# shellcheck source=scripts/linuxdeploy-tools.env
source "$script_dir/linuxdeploy-tools.env"
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"
# shellcheck source=scripts/linux-appimage-legal.env
source "$script_dir/linux-appimage-legal.env"
appimage_runtime_dirname=$STUDYVIS_WEBKIT_APPIMAGE_RUNTIME_DIRNAME
[[ $appimage_runtime_dirname == studyvis-webkit-runtime ]] || {
  die "invalid AppImage WebKit runtime directory name: $appimage_runtime_dirname"
}

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <StudyVis.AppImage>" >&2
  exit 2
fi

for command_name in bash cmp env find grep gst-inspect-1.0 head ldd mkdir mktemp node npm readelf realpath sha256sum tr wc; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing AppImage check dependency: $command_name"
done

appimage=$(realpath --canonicalize-existing -- "$1")
[[ -f $appimage && -x $appimage ]] || die "AppImage is missing or not executable: $appimage"

scratch_parent=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
[[ $scratch_parent == /* ]] || die "temporary directory must be absolute: $scratch_parent"
scratch_parent=$(realpath --canonicalize-existing -- "$scratch_parent")
[[ -d $scratch_parent && -w $scratch_parent ]] || die "temporary directory is not writable: $scratch_parent"
extract=$(mktemp -d "$scratch_parent/studyvis-appimage-check.XXXXXX")
cleanup() {
  rm -rf -- "$extract"
}
trap cleanup EXIT

[[ -n ${LDAI_RUNTIME_FILE:-} ]] || die "LDAI_RUNTIME_FILE must identify the verified source-built runtime"
expected_runtime=$(realpath --canonicalize-existing -- "$LDAI_RUNTIME_FILE")
expected_runtime_dir=${expected_runtime%/runtime-x86_64}
[[ $expected_runtime != "$expected_runtime_dir" && \
   ${expected_runtime_dir##*/} == "studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}" ]] || {
  die "LDAI_RUNTIME_FILE is not the revisioned StudyVis runtime output"
}
runtime_offset=$($appimage --appimage-offset 2>/dev/null) || die "could not read AppImage runtime offset"
[[ $runtime_offset =~ ^[0-9]+$ ]] || die "invalid AppImage runtime offset: $runtime_offset"
runtime_prefix="$extract/AppImage-runtime-prefix.bin"
head -c "$runtime_offset" -- "$appimage" >"$runtime_prefix"
[[ $(wc -c <"$runtime_prefix") -eq $runtime_offset ]] || die "short AppImage runtime prefix read"
bash "$script_dir/verify-linux-appimage-runtime.sh" "$expected_runtime_dir" "$runtime_prefix"

(cd "$extract" && "$appimage" --appimage-extract >/dev/null)
root="$extract/squashfs-root"
[[ -d $root && ! -L $root ]] || die "AppImage extraction did not create squashfs-root"

# `ldd` below exercises selected binaries, but on a build runner it can hide a
# missing packaged library by borrowing the host. Audit every ELF first: each
# DT_NEEDED/PT_INTERP name must be packaged or explicitly part of the reviewed
# AppImage host ABI boundary.
bash "$script_dir/audit-linux-appimage-elf-closure.sh" \
  "$root" "$runtime_prefix" "$extract/DYNAMIC-LINK-INVENTORY.tsv"
(cd "$repo_root" && npm run check-notice-bundle -- "$root")

require_file() {
  [[ -f $1 ]] || die "packaged file is missing: ${1#"$root/"}"
}

require_nonempty_file() {
  [[ -s $1 ]] || die "packaged file is missing or empty: ${1#"$root/"}"
}
require_executable() {
  [[ -f $1 && -x $1 ]] || die "packaged executable is missing: ${1#"$root/"}"
}
require_x86_64_elf() {
  local elf_header
  require_file "$1"
  elf_header=$(readelf -h "$1")
  grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64' <<<"$elf_header" || {
    die "packaged ELF has the wrong architecture: ${1#"$root/"}"
  }
}

require_executable "$root/AppRun.wrapped"
apprun_sha=$(sha256sum "$root/AppRun.wrapped")
apprun_sha=${apprun_sha%% *}
[[ $apprun_sha == "$STUDYVIS_APPRUN_SHA256" ]] || {
  die "packaged AppRun does not match the pinned audited binary: $apprun_sha"
}
apprun_build_id=$(
  readelf -n "$root/AppRun.wrapped" 2>/dev/null \
    | sed -n 's/^[[:space:]]*Build ID: \([0-9A-Fa-f][0-9A-Fa-f]*\)$/\1/p' \
    | tr '[:upper:]' '[:lower:]' \
    | head -n 1
)
[[ $apprun_build_id == "$STUDYVIS_APPRUN_BUILD_ID" ]] || {
  die "packaged AppRun has the wrong GNU build-id: $apprun_build_id"
}

packaged_libdir="$root/usr/lib"
packaged_library_path="$packaged_libdir:$root/usr/lib/x86_64-linux-gnu"
for library in \
  libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 \
  librice-proto.so.0 librice-io.so.0; do
  require_x86_64_elf "$packaged_libdir/$library"
done

for helper in bwrap xdg-dbus-proxy; do
  require_executable "$root/usr/bin/$helper"
  require_x86_64_elf "$root/usr/bin/$helper"
  env LD_LIBRARY_PATH="$packaged_library_path" \
    "$root/usr/bin/$helper" --version >/dev/null
done

license_dir="$root/usr/share/licenses/studyvis-webkit-runtime"
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
  require_nonempty_file "$license_dir/$license"
done
if ! cmp -s "$license_dir/BUILD-MANIFEST.txt" \
  <(bash "$script_dir/build-linux-webkit-runtime.sh" --print-manifest); then
  die "packaged runtime manifest does not match the repository tuple and flags"
fi
read -r packaged_patch_sha256 _ < <(sha256sum "$license_dir/webkitgtk-appimage-sandbox.patch")
[[ $packaged_patch_sha256 == "$STUDYVIS_WEBKIT_PATCH_SHA256" ]] || {
  die "packaged WebKitGTK patch has the wrong SHA256: $packaged_patch_sha256"
}
[[ $(wc -l <"$license_dir/WEBKIT-LICENSE-FILES.sha256") -eq 59 ]] || {
  die "packaged WebKit license hash inventory is incomplete"
}
node "$script_dir/generate-librice-third-party-notices.mjs" --check \
  "$license_dir" --expected-lock-sha "$STUDYVIS_LIBRICE_CARGO_LOCK_SHA256"
read -r librice_notice_sha256 _ < <(sha256sum "$license_dir/LIBRICE-THIRD-PARTY-NOTICES.txt")
[[ $librice_notice_sha256 == "$STUDYVIS_LIBRICE_NOTICE_SHA256" ]] || {
  die "packaged librice notice has the wrong SHA256: $librice_notice_sha256"
}
read -r librice_notice_manifest_sha256 _ < <(
  sha256sum "$license_dir/LIBRICE-THIRD-PARTY-NOTICES.json"
)
[[ $librice_notice_manifest_sha256 == "$STUDYVIS_LIBRICE_NOTICE_MANIFEST_SHA256" ]] || {
  die "packaged librice notice manifest has the wrong SHA256: $librice_notice_manifest_sha256"
}

notice_dir="$root/usr/share/licenses/studyvis-runtime"
declare -A required_notices=(
  [APPIMAGEKIT-MIT.txt]="$STUDYVIS_APPIMAGEKIT_LICENSE_SHA256"
  [LLAMA.CPP-MIT.txt]="$STUDYVIS_LLAMA_LICENSE_SHA256"
  [TAURI-BINARY-RELEASES-MIT.txt]="$STUDYVIS_TAURI_BINARY_RELEASES_LICENSE_SHA256"
  [WRY-MIT.txt]="$STUDYVIS_WRY_MIT_SHA256"
  [WRY-APACHE-2.0.txt]="$STUDYVIS_WRY_APACHE_SHA256"
)
for notice in "${!required_notices[@]}"; do
  require_nonempty_file "$notice_dir/$notice"
  notice_sha=$(sha256sum "$notice_dir/$notice")
  notice_sha=${notice_sha%% *}
  [[ $notice_sha == "${required_notices[$notice]}" ]] || {
    die "packaged runtime notice has the wrong SHA256: $notice"
  }
done

# Production WebRTC keeps ICE/networking in WebKit's sandboxed NetworkProcess.
# If configuration falls back to legacy libnice, these dependencies disappear.
webkit_needed=$(readelf -d "$packaged_libdir/libwebkit2gtk-4.1.so.0")
grep -aFq "$appimage_runtime_dirname" "$packaged_libdir/libwebkit2gtk-4.1.so.0" || {
  die "packaged WebKitGTK is missing the production AppImage runtime locator"
}
grep -Fq 'Shared library: [librice-proto.so.0]' <<<"$webkit_needed" || {
  die "packaged WebKitGTK does not depend on librice-proto.so.0"
}
grep -Fq 'Shared library: [librice-io.so.0]' <<<"$webkit_needed" || {
  die "packaged WebKitGTK does not depend on librice-io.so.0"
}

webkit_process_dir="$root/usr/bin/$appimage_runtime_dirname"
webkit_executables=("$root/usr/bin/studyvis")
for helper in WebKitNetworkProcess WebKitWebProcess WebKitGPUProcess; do
  require_executable "$webkit_process_dir/$helper"
  require_x86_64_elf "$webkit_process_dir/$helper"
  webkit_executables+=("$webkit_process_dir/$helper")
done
injected_bundle="$webkit_process_dir/injected-bundle/libwebkit2gtkinjectedbundle.so"
require_x86_64_elf "$injected_bundle"

executables=(
  "${webkit_executables[@]}"
  "$root/usr/bin/bwrap"
  "$root/usr/bin/xdg-dbus-proxy"
)
for executable in "${executables[@]}"; do
  require_executable "$executable"
  ldd_output=$(env LD_LIBRARY_PATH="$packaged_library_path" ldd "$executable") || {
    die "ldd failed for packaged executable: ${executable#"$root/"}"
  }
  if grep -Fq 'not found' <<<"$ldd_output"; then
    echo "$ldd_output" >&2
    die "unresolved packaged dependency in ${executable#"$root/"}"
  fi
  if [[ $executable == "$root/usr/bin/studyvis" || $executable == "$webkit_process_dir"/* ]]; then
    for runtime_library in \
      libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 \
      librice-proto.so.0 librice-io.so.0; do
      grep -Fq "$runtime_library => $packaged_libdir/$runtime_library " <<<"$ldd_output" || {
        die "${executable#"$root/"} did not resolve packaged $runtime_library"
      }
    done
  fi
done

scanner="$root/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
ptp_helper="$root/usr/lib/gstreamer1.0/gstreamer-1.0/gst-ptp-helper"
plugins="$root/usr/lib/gstreamer-1.0"
require_executable "$scanner"
require_executable "$ptp_helper"
require_x86_64_elf "$scanner"
require_x86_64_elf "$ptp_helper"
require_file "$plugins/libgstpipewire.so"

# The linuxdeploy GStreamer plugin copies an entire directory. Prove it was
# pointed at StudyVis's curated stage and that no runner-installed codec leaked
# into the artifact.
plugin_manifest="$script_dir/linux-gstreamer-plugins.txt"
declare -A allowed_plugins=()
while IFS= read -r plugin_group || [[ -n $plugin_group ]]; do
  plugin_group=${plugin_group%%#*}
  plugin_group=${plugin_group//[[:space:]]/}
  [[ -n $plugin_group ]] || continue
  IFS='|' read -r -a candidates <<<"$plugin_group"
  selected=
  for candidate in "${candidates[@]}"; do
    if [[ -f $plugins/$candidate && ! -L $plugins/$candidate ]]; then
      [[ -z $selected ]] || die "multiple distro alternatives were packaged for $plugin_group"
      selected=$candidate
    fi
  done
  [[ -n $selected ]] || die "required curated GStreamer plugin is missing: $plugin_group"
  allowed_plugins[$selected]=1
done <"$plugin_manifest"
while IFS= read -r -d '' plugin; do
  plugin_name=${plugin##*/}
  [[ -v allowed_plugins[$plugin_name] ]] || {
    die "uncurated GStreamer plugin was packaged: $plugin_name"
  }
done < <(find "$plugins" -mindepth 1 -maxdepth 1 -type f -print0)
for forbidden in libgstlibav.so libgstx264.so libgstx265.so; do
  [[ ! -e $plugins/$forbidden ]] || die "forbidden GStreamer codec was packaged: $forbidden"
done

# A fresh registry plus packaged-only paths proves every element resolves from
# the artifact. This covers capture, ICE, RTP, baseline A/V codecs, DTLS-SRTP
# encryption, and the SCTP data channel used by Trystero.
registry="$extract/gstreamer-registry.bin"
test_home="$extract/home"
mkdir -p "$test_home"
for element in \
  pipewiresrc webrtcbin nicesrc nicesink rtpbin \
  vp8enc vp8dec rtpvp8pay rtpvp8depay \
  opusenc opusdec rtpopuspay rtpopusdepay \
  dtlssrtpenc dtlssrtpdec srtpenc srtpdec sctpenc sctpdec; do
  env \
    HOME="$test_home" \
    LD_LIBRARY_PATH="$packaged_library_path" \
    GST_PLUGIN_SCANNER_1_0="$scanner" \
    GST_REGISTRY="$registry" \
    GST_PLUGIN_SYSTEM_PATH_1_0="$plugins" \
    GST_PLUGIN_PATH_1_0="$plugins" \
    gst-inspect-1.0 "$element" >/dev/null || {
      die "packaged GStreamer element is unavailable: $element"
    }
done

llama_runtime="$root/usr/lib/StudyVis/binaries/llama-runtime-x86_64-unknown-linux-gnu"
llama_server="$root/usr/bin/llama-server"
require_executable "$llama_server"
env LD_LIBRARY_PATH="$packaged_library_path:$llama_runtime" \
  "$llama_server" --version >/dev/null

echo "Validated packaged WebKit, sandbox, WebRTC, PipeWire, licenses, and llama runtimes: $appimage"
