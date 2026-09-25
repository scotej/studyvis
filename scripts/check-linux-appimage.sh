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

for command_name in bash cat cc cmp dbus-run-session env find grep gst-inspect-1.0 head ldd mkdir mktemp node npm pkg-config python3 readelf realpath sed sha256sum timeout tr wc xvfb-run; do
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
while IFS= read -r -d '' client; do
  die "host EGL would load a bundled Wayland client: ${client#"$root/"}"
done < <(find "$root/usr" -name 'libwayland-client.so*' -print0)
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
  GStreamer-LICENSE-LGPL-2.1
  GStreamer-PTP-LICENSE-MPL-2.0
  Libnice-LICENSING
  Libnice-LICENSE-LGPL-2.1
  Libnice-LICENSE-MPL-1.1
  GSTREAMER-THIRD-PARTY-LICENSES.txt
  GSTREAMER-LICENSE-FILES.sha256
  Meson-LICENSE-APACHE-2.0
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
for notice in GSTREAMER-THIRD-PARTY-LICENSES.txt GSTREAMER-LICENSE-FILES.sha256 GStreamer-PTP-LICENSE-MPL-2.0; do
  case $notice in
    GSTREAMER-THIRD-PARTY-LICENSES.txt) expected_sha=$STUDYVIS_GSTREAMER_NOTICE_SHA256 ;;
    GSTREAMER-LICENSE-FILES.sha256) expected_sha=$STUDYVIS_GSTREAMER_LICENSE_INVENTORY_SHA256 ;;
    GStreamer-PTP-LICENSE-MPL-2.0) expected_sha=$STUDYVIS_GSTREAMER_PTP_LICENSE_SHA256 ;;
  esac
  read -r actual_sha _ < <(sha256sum "$license_dir/$notice")
  [[ $actual_sha == "$expected_sha" ]] || die "GStreamer license evidence has the wrong SHA256: $notice"
done
for license in Libnice-LICENSING Libnice-LICENSE-LGPL-2.1 Libnice-LICENSE-MPL-1.1; do
  case $license in
    Libnice-LICENSING) expected_sha=$STUDYVIS_LIBNICE_LICENSING_SHA256 ;;
    Libnice-LICENSE-LGPL-2.1) expected_sha=$STUDYVIS_LIBNICE_LGPL_SHA256 ;;
    Libnice-LICENSE-MPL-1.1) expected_sha=$STUDYVIS_LIBNICE_MPL_SHA256 ;;
  esac
  read -r actual_sha _ < <(sha256sum "$license_dir/$license")
  [[ $actual_sha == "$expected_sha" ]] || die "libnice license evidence has the wrong SHA256: $license"
done
[[ $(wc -l <"$license_dir/GSTREAMER-LICENSE-FILES.sha256") -eq 15 ]] || {
  die "packaged GStreamer/libnice license hash inventory is incomplete"
}
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

# linuxdeploy resolves support libraries separately from staged plugins. Prove
# they all came from the same source build even when Noble provides the same
# sonames. Its stripping/RPATH edits preserve each original GNU build-id.
gstreamer_runtime_libdir=$(bash "$script_dir/build-linux-webkit-runtime.sh" --print-pkg-config-path)
gstreamer_runtime_libdir=${gstreamer_runtime_libdir%/pkgconfig}
while IFS= read -r -d '' payload; do
  name=${payload##*/}
  case $payload in
    "$plugins/libgstpipewire.so") continue ;;
    "$plugins/"*|"${scanner%/*}/"*) reference="$gstreamer_runtime_libdir/gstreamer-1.0/$name" ;;
    *) reference="$gstreamer_runtime_libdir/$name" ;;
  esac
  require_file "$reference"
  payload_id=$(readelf -n "$payload" | sed -n 's/.*Build ID: //p')
  reference_id=$(readelf -n "$reference" | sed -n 's/.*Build ID: //p')
  [[ -n $payload_id && $payload_id == "$reference_id" ]] || {
    die "packaged GStreamer differs from its pinned source build: $name"
  }
done < <(find "$packaged_libdir" -type f \
  \( -name 'libgst*.so*' -o -name 'libnice.so*' -o -name gst-plugin-scanner -o -name gst-ptp-helper \) -print0)

# A fresh registry plus packaged-only paths proves every element resolves from
# the artifact. This covers capture, ICE, RTP, baseline A/V codecs, DTLS-SRTP
# encryption, and the SCTP data channel used by Trystero.
registry="$extract/gstreamer-registry.bin"
grep -aFq "StudyVis GStreamer $STUDYVIS_GSTREAMER_VERSION (runtime r$STUDYVIS_WEBKIT_RUNTIME_REVISION)" "$plugins/libgstwebrtc.so" || {
  die "packaged WebRTC plugin is missing its pinned runtime build marker"
}
test_home="$extract/home"
mkdir -p "$test_home/.config"
for element in \
  videotestsrc audiotestsrc \
  glupload glcolorconvert gldownload \
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

# #312: factories alone missed media failures. Exercise real codecs, SRTP,
# GPU-memory conversion and transceiver reuse without a camera or display.
for nss_file in libsoftokn3.so libsoftokn3.chk libfreeblpriv3.so libfreeblpriv3.chk; do
  require_nonempty_file "$packaged_libdir/$nss_file"
done
env -u DISPLAY -u WAYLAND_DISPLAY \
  HOME="$test_home" \
  LD_LIBRARY_PATH="$packaged_library_path" \
  GST_PLUGIN_SCANNER_1_0="$scanner" \
  GST_REGISTRY="$registry" \
  GST_PLUGIN_SYSTEM_PATH_1_0="$plugins" \
  GST_PLUGIN_PATH_1_0="$plugins" \
  GST_GL_WINDOW=surfaceless GST_GL_PLATFORM=egl GST_GL_API=gles2 EGL_PLATFORM=surfaceless \
  timeout 45s python3 "$script_dir/check-linux-gstreamer.py" "$packaged_libdir" "$STUDYVIS_GSTREAMER_VERSION" || {
    die "packaged GStreamer cannot encode and decode WebRTC media"
  }

# Resolving `pipewiresrc` above proves only that the plugin loads: its
# plugin_init calls pw_init(), which never touches the SPA plugin directory.
# The directory is first read by pw_loop_new(), and PipeWire's failure mode
# there is a NULL that neither GStreamer nor pw_context_connect() checks, so a
# bundle missing its payload passes every element check and then segfaults the
# web process on the first capture probe (ISSUES.md I89). Exercise the packaged
# library against the packaged payload directly: pointing the overrides at the
# bundle is what makes this fail on a Debian-derived builder, whose host
# happens to provide the compiled-in /usr/lib/x86_64-linux-gnu paths.
spa_plugins="$root/usr/lib/spa-0.2"
# The modules are packaged beside libpipewire because client-node declares
# protocol-native in DT_NEEDED and the loader never searches a consumer's own
# directory; audit-linux-appimage-elf-closure.sh enforces that placement.
pipewire_modules="$root/usr/lib"
pipewire_config="$root/usr/share/pipewire"
require_file "$spa_plugins/support/libspa-support.so"
require_file "$spa_plugins/audioconvert/libspa-audioconvert.so"
require_file "$pipewire_config/client.conf"
for module in protocol-native client-node client-device adapter metadata session-manager; do
  require_file "$pipewire_modules/libpipewire-module-$module.so"
done
pipewire_probe="$extract/pipewire-probe.py"
cat >"$pipewire_probe" <<'PROBE'
import ctypes
import faulthandler
import sys

faulthandler.enable()
print("Packaged PipeWire: loading library", flush=True)
library = ctypes.CDLL(sys.argv[1])
library.pw_init.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
library.pw_init.restype = None
library.pw_init(None, None)
print("Packaged PipeWire: initialized", flush=True)
library.pw_loop_new.argtypes = [ctypes.c_void_p]
library.pw_loop_new.restype = ctypes.c_void_p
library.pw_context_new.restype = ctypes.c_void_p
library.pw_context_new.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
library.pw_context_destroy.argtypes = [ctypes.c_void_p]
library.pw_context_destroy.restype = None
library.pw_loop_destroy.argtypes = [ctypes.c_void_p]
library.pw_loop_destroy.restype = None
library.pw_deinit.argtypes = []
library.pw_deinit.restype = None

try:
    loop = library.pw_loop_new(None)
    if not loop:
        sys.exit("pw_loop_new() returned NULL: the packaged SPA plugins are missing")
    print("Packaged PipeWire: loop created", flush=True)
    try:
        # Every context.modules entry in client.conf is mandatory; a NULL here
        # means one of the packaged modules did not load.
        context = library.pw_context_new(loop, None, 0)
        if not context:
            sys.exit("pw_context_new() returned NULL: the packaged PipeWire modules are incomplete")
        print("Packaged PipeWire context created", flush=True)
        # Unload its modules before Python tears down the ctypes library.
        library.pw_context_destroy(context)
    finally:
        library.pw_loop_destroy(loop)
finally:
    library.pw_deinit()
print("Packaged PipeWire context and loop destroyed", flush=True)
PROBE
pipewire_library="$root/usr/lib/libpipewire-0.3.so.0"
pipewire_env=(
  "LD_LIBRARY_PATH=$packaged_library_path"
  "HOME=$test_home"
  "XDG_CONFIG_HOME=$test_home/.config"
  "SPA_PLUGIN_DIR=$spa_plugins"
  "PIPEWIRE_MODULE_DIR=$pipewire_modules"
  "PIPEWIRE_CONFIG_DIR=$pipewire_config"
)
if ! env "${pipewire_env[@]}" python3 "$pipewire_probe" "$pipewire_library"; then
  # Keep the original failure fatal, but compare with a process that does not
  # load Python's ctypes/libffi before opening the same packaged PipeWire ELF.
  native_probe="$extract/pipewire-native-probe"
  if cc -std=c11 -Wall -Wextra -Werror \
    "$script_dir/check-linux-pipewire.c" -o "$native_probe" -ldl; then
    echo "Packaged PipeWire Python probe failed; comparing a native probe" >&2
    if env "${pipewire_env[@]}" timeout 30s "$native_probe" "$pipewire_library"; then
      echo "Native packaged PipeWire probe passed after Python probe failed" >&2
    else
      echo "Native packaged PipeWire probe also failed" >&2
    fi
  fi
  if command -v gdb >/dev/null 2>&1; then
    echo "Packaged PipeWire probe failed; rerunning under gdb for a native backtrace" >&2
    env -u LD_LIBRARY_PATH gdb -q -batch -nx \
      -ex 'set disable-randomization off' \
      -ex "set environment LD_LIBRARY_PATH $packaged_library_path" \
      -ex "set environment HOME $test_home" \
      -ex "set environment XDG_CONFIG_HOME $test_home/.config" \
      -ex "set environment SPA_PLUGIN_DIR $spa_plugins" \
      -ex "set environment PIPEWIRE_MODULE_DIR $pipewire_modules" \
      -ex "set environment PIPEWIRE_CONFIG_DIR $pipewire_config" \
      -ex 'set environment PIPEWIRE_DEBUG 5' \
      -ex 'set environment LD_DEBUG libs,files' \
      -ex run \
      -ex 'frame 0' \
      -ex 'p map->l_name' \
      -ex 'p map->l_info[6]' \
      -ex 'p $_siginfo._sifields._sigfault.si_addr' \
      -ex 'x/8i $pc-16' \
      -ex 'info registers' \
      -ex 'thread apply all bt' \
      --args python3 "$pipewire_probe" "$pipewire_library" || true
  fi
  die "packaged PipeWire client cannot start from the packaged payload"
fi

# A data-channel offer does not exercise receiver creation or renegotiation.
# Compile against the pinned SDK, then run beside the extracted application so
# WebKit resolves its real packaged subprocesses and media libraries (#312).
media_probe="$root/usr/bin/studyvis-webkit-media-check"
# shellcheck disable=SC2046
cc -Wall -Wextra -Werror "$script_dir/check-linux-webkit-media.c" \
  -o "$media_probe" $(pkg-config --cflags --libs webkit2gtk-4.1)
env \
  HOME="$test_home" \
  LD_LIBRARY_PATH="$packaged_library_path" \
  GST_PLUGIN_SCANNER_1_0="$scanner" \
  GST_REGISTRY="$registry" \
  GST_PLUGIN_SYSTEM_PATH_1_0="$plugins" \
  GST_PLUGIN_PATH_1_0="$plugins" \
  SPA_PLUGIN_DIR="$root/usr/lib/spa-0.2" \
  PIPEWIRE_MODULE_DIR="$packaged_libdir" \
  PIPEWIRE_CONFIG_DIR="$root/usr/share/pipewire" \
  GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  timeout 75s xvfb-run -a dbus-run-session -- \
    "$media_probe" "$script_dir/check-linux-webkit-media.html" || {
      die "packaged WebKit cannot render and renegotiate peer media"
    }

llama_runtime="$root/usr/lib/StudyVis/binaries/llama-runtime-x86_64-unknown-linux-gnu"
llama_server="$root/usr/bin/llama-server"
require_executable "$llama_server"
env LD_LIBRARY_PATH="$packaged_library_path:$llama_runtime" \
  "$llama_server" --version >/dev/null

echo "Validated packaged WebKit, sandbox, WebRTC, PipeWire, licenses, and llama runtimes: $appimage"
