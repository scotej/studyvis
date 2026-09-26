#!/usr/bin/env bash
# Build the exact WebKitGTK runtime StudyVis ships in its Linux AppImage.
#
# Distribution WebKitGTK builds compile the GTK port's experimental WebRTC
# interface out. StudyVis enables that one feature and builds librice so ICE
# and network access remain in WebKit's sandboxed NetworkProcess. The pinned
# source tuple, patch, cargo-c version, effective CMake options, and complete
# upstream license inventory are recorded in the runtime itself.

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

webkit_version=$STUDYVIS_WEBKIT_VERSION
webkit_url=$STUDYVIS_WEBKIT_SOURCE_URL
webkit_sha256=$STUDYVIS_WEBKIT_SHA256
webkit_patch_sha256=$STUDYVIS_WEBKIT_PATCH_SHA256
rice_version=$STUDYVIS_LIBRICE_VERSION
rice_url=$STUDYVIS_LIBRICE_SOURCE_URL
rice_sha256=$STUDYVIS_LIBRICE_SHA256
rice_lock_sha256=$STUDYVIS_LIBRICE_CARGO_LOCK_SHA256
rice_notice_sha256=$STUDYVIS_LIBRICE_NOTICE_SHA256
rice_notice_manifest_sha256=$STUDYVIS_LIBRICE_NOTICE_MANIFEST_SHA256
gstreamer_version=$STUDYVIS_GSTREAMER_VERSION
gstreamer_components=(gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad)
gstreamer_urls=(
  "$STUDYVIS_GSTREAMER_CORE_SOURCE_URL" "$STUDYVIS_GSTREAMER_BASE_SOURCE_URL"
  "$STUDYVIS_GSTREAMER_GOOD_SOURCE_URL" "$STUDYVIS_GSTREAMER_BAD_SOURCE_URL"
)
gstreamer_hashes=(
  "$STUDYVIS_GSTREAMER_CORE_SHA256" "$STUDYVIS_GSTREAMER_BASE_SHA256"
  "$STUDYVIS_GSTREAMER_GOOD_SHA256" "$STUDYVIS_GSTREAMER_BAD_SHA256"
)
libnice_version=$STUDYVIS_LIBNICE_VERSION
libnice_url=$STUDYVIS_LIBNICE_SOURCE_URL
libnice_sha256=$STUDYVIS_LIBNICE_SHA256
libnice_licensing_sha256=$STUDYVIS_LIBNICE_LICENSING_SHA256
libnice_lgpl_sha256=$STUDYVIS_LIBNICE_LGPL_SHA256
libnice_mpl_sha256=$STUDYVIS_LIBNICE_MPL_SHA256
meson_version=$STUDYVIS_GSTREAMER_MESON_VERSION
meson_url=$STUDYVIS_GSTREAMER_MESON_SOURCE_URL
meson_sha256=$STUDYVIS_GSTREAMER_MESON_SHA256
gstreamer_ptp_license_url=$STUDYVIS_GSTREAMER_PTP_LICENSE_URL
gstreamer_ptp_license_sha256=$STUDYVIS_GSTREAMER_PTP_LICENSE_SHA256
gstreamer_notice_sha256=$STUDYVIS_GSTREAMER_NOTICE_SHA256
gstreamer_license_inventory_sha256=$STUDYVIS_GSTREAMER_LICENSE_INVENTORY_SHA256
cargo_c_version=$STUDYVIS_CARGO_C_VERSION
runtime_revision=$STUDYVIS_WEBKIT_RUNTIME_REVISION
appimage_runtime_dirname=$STUDYVIS_WEBKIT_APPIMAGE_RUNTIME_DIRNAME
runtime_id="studyvis-webkitgtk-${webkit_version}-librice-${rice_version}-r${runtime_revision}"

require_match() {
  local name=$1
  local value=$2
  local pattern=$3
  [[ $value =~ $pattern ]] || die "invalid $name in linux-webkit-runtime.env: $value"
}

require_match STUDYVIS_WEBKIT_VERSION "$webkit_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_LIBRICE_VERSION "$rice_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_GSTREAMER_VERSION "$gstreamer_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_LIBNICE_VERSION "$libnice_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_GSTREAMER_MESON_VERSION "$meson_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_CARGO_C_VERSION "$cargo_c_version" '^[0-9]+\.[0-9]+\.[0-9]+$'
require_match STUDYVIS_WEBKIT_RUNTIME_REVISION "$runtime_revision" '^[1-9][0-9]*$'
require_match STUDYVIS_WEBKIT_APPIMAGE_RUNTIME_DIRNAME "$appimage_runtime_dirname" \
  '^studyvis-webkit-runtime$'
require_match STUDYVIS_WEBKIT_SHA256 "$webkit_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_WEBKIT_PATCH_SHA256 "$webkit_patch_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBRICE_SHA256 "$rice_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBRICE_CARGO_LOCK_SHA256 "$rice_lock_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBRICE_NOTICE_SHA256 "$rice_notice_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBRICE_NOTICE_MANIFEST_SHA256 "$rice_notice_manifest_sha256" '^[0-9a-f]{64}$'
for component_index in "${!gstreamer_components[@]}"; do
  require_match "${gstreamer_components[$component_index]} SHA256" \
    "${gstreamer_hashes[$component_index]}" '^[0-9a-f]{64}$'
  require_match "${gstreamer_components[$component_index]} source URL" \
    "${gstreamer_urls[$component_index]}" '^https://[^[:space:]]+$'
done
require_match STUDYVIS_LIBNICE_SOURCE_URL "$libnice_url" '^https://[^[:space:]]+$'
require_match STUDYVIS_LIBNICE_SHA256 "$libnice_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBNICE_LICENSING_SHA256 "$libnice_licensing_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBNICE_LGPL_SHA256 "$libnice_lgpl_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_LIBNICE_MPL_SHA256 "$libnice_mpl_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_GSTREAMER_MESON_SHA256 "$meson_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_GSTREAMER_MESON_SOURCE_URL "$meson_url" '^https://[^[:space:]]+$'
require_match STUDYVIS_GSTREAMER_PTP_LICENSE_URL "$gstreamer_ptp_license_url" '^https://[^[:space:]]+$'
require_match STUDYVIS_GSTREAMER_PTP_LICENSE_SHA256 "$gstreamer_ptp_license_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_GSTREAMER_NOTICE_SHA256 "$gstreamer_notice_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_GSTREAMER_LICENSE_INVENTORY_SHA256 "$gstreamer_license_inventory_sha256" '^[0-9a-f]{64}$'
require_match STUDYVIS_WEBKIT_SOURCE_URL "$webkit_url" '^https://[^[:space:]]+$'
require_match STUDYVIS_LIBRICE_SOURCE_URL "$rice_url" '^https://[^[:space:]]+$'

normalize_output_path() {
  local name=$1
  local value=$2
  [[ $value == /* ]] || die "$name must be an absolute path: $value"
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || die "$name contains a newline"
  realpath --canonicalize-missing -- "$value"
}

runtime_dir_input=${STUDYVIS_WEBKIT_RUNTIME_DIR:-$target_root/$runtime_id}
work_root_input=${STUDYVIS_WEBKIT_BUILD_DIR:-$target_root/${runtime_id}-build}
[[ ! -L $runtime_dir_input ]] || die "refusing symlinked runtime directory: $runtime_dir_input"
[[ ! -L $work_root_input ]] || die "refusing symlinked build directory: $work_root_input"
runtime_dir=$(normalize_output_path STUDYVIS_WEBKIT_RUNTIME_DIR "$runtime_dir_input")
work_root=$(normalize_output_path STUDYVIS_WEBKIT_BUILD_DIR "$work_root_input")

for protected_path in / "$repo_root" "$repo_root/src-tauri" "$target_root"; do
  [[ $runtime_dir != "$protected_path" ]] || die "refusing unsafe runtime directory: $runtime_dir"
  [[ $work_root != "$protected_path" ]] || die "refusing unsafe build directory: $work_root"
done
[[ $runtime_dir != "$work_root" ]] || die "runtime and build directories must differ"
[[ $runtime_dir != "$work_root"/* && $work_root != "$runtime_dir"/* ]] || {
  die "runtime and build directories must not contain one another"
}

require_managed_output_path() {
  local name=$1
  local path=$2
  local basename=${path##*/}
  local parent=${path%/*}
  [[ $basename == studyvis-webkit* && $parent != / && $parent != "$path" ]] || {
    die "$name must name a dedicated studyvis-webkit* directory below a parent: $path"
  }
}
require_managed_output_path STUDYVIS_WEBKIT_RUNTIME_DIR "$runtime_dir"
require_managed_output_path STUDYVIS_WEBKIT_BUILD_DIR "$work_root"

patch_file="$script_dir/patches/webkitgtk-${webkit_version}-appimage-sandbox.patch"
patch_relative=${patch_file#"$repo_root/"}
runtime_lib_relative=usr/lib/x86_64-linux-gnu
runtime_libdir="$runtime_dir/$runtime_lib_relative"
runtime_pkgconfig="$runtime_libdir/pkgconfig"
licenses="$runtime_dir/usr/share/licenses/studyvis-webkit-runtime"
manifest="$licenses/BUILD-MANIFEST.txt"
marker="$runtime_dir/.studyvis-webkit-runtime"
librice_notice_generator="$script_dir/generate-librice-third-party-notices.mjs"
librice_notice="$licenses/LIBRICE-THIRD-PARTY-NOTICES.txt"
librice_notice_manifest="$licenses/LIBRICE-THIRD-PARTY-NOTICES.json"
gstreamer_plugin="$runtime_libdir/gstreamer-1.0/libgstwebrtc.so"
gstreamer_helpers="$runtime_libdir/gstreamer-1.0"
gstreamer_package_name="StudyVis GStreamer $gstreamer_version (runtime r$runtime_revision)"
gstreamer_license_sha256=dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551
meson_license_sha256=cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30

gstreamer_meson_options=(
  '--prefix=/usr'
  '--libdir=lib/x86_64-linux-gnu'
  '--libexecdir=lib/x86_64-linux-gnu'
  '--buildtype=release'
  '--wrap-mode=nofallback'
  '-Dauto_features=disabled'
  '-Ddefault_library=shared'
  '-Dtests=disabled'
  '-Dexamples=disabled'
  '-Ddoc=disabled'
  '-Dnls=disabled'
  "-Dpackage-name=$gstreamer_package_name"
  '-Dpackage-origin=https://github.com/scotej/studyvis'
)
# These arrays are selected by name in gstreamer_option_arrays.
# shellcheck disable=SC2034
gstreamer_core_options=(
  '-Dtools=enabled' '-Dintrospection=disabled' '-Dbenchmarks=disabled'
  '-Dptp-helper=enabled' '-Dptp-helper-permissions=none'
)
# shellcheck disable=SC2034
gstreamer_base_options=(
  '-Dtools=disabled' '-Dintrospection=disabled' '-Dorc=enabled'
  '-Dapp=enabled' '-Daudioconvert=enabled' '-Daudiorate=enabled'
  '-Daudioresample=enabled' '-Daudiotestsrc=enabled' '-Dvideotestsrc=enabled'
  '-Dgio=enabled' '-Dopus=enabled' '-Dplayback=enabled' '-Dtypefind=enabled'
  '-Dvideoconvertscale=enabled' '-Dvideorate=enabled' '-Dvolume=enabled'
  '-Dalsa=enabled' '-Dgl=enabled' '-Dx11=enabled'
  '-Dgl_api=opengl,gles2' '-Dgl_platform=egl,glx'
  '-Dgl_winsys=x11,wayland,egl,surfaceless,gbm'
)
# shellcheck disable=SC2034
gstreamer_good_options=(
  '-Dorc=enabled' '-Dautodetect=enabled' '-Dpulse=enabled'
  '-Dv4l2=enabled' '-Dv4l2-gudev=enabled'
  '-Drtp=enabled' '-Drtpmanager=enabled' '-Dvpx=enabled'
)
# shellcheck disable=SC2034
gstreamer_bad_options=(
  '-Dtools=disabled' '-Dintrospection=disabled' '-Dorc=enabled'
  '-Dgpl=disabled' '-Dwebrtc=enabled' '-Ddtls=enabled'
  '-Dsrtp=enabled' '-Dsctp=enabled' '-Dsctp-internal-usrsctp=disabled'
)
libnice_meson_options=(
  '--prefix=/usr'
  '--libdir=lib/x86_64-linux-gnu'
  '--buildtype=release'
  '--wrap-mode=nofallback'
  '-Dauto_features=disabled'
  '-Ddefault_library=shared'
  '-Dtests=disabled'
  '-Dexamples=disabled'
  '-Dgtk_doc=disabled'
  '-Dintrospection=disabled'
  '-Dgupnp=disabled'
  '-Dgstreamer=enabled'
  '-Dcrypto-library=openssl'
)
gstreamer_option_arrays=(
  gstreamer_core_options gstreamer_base_options gstreamer_good_options gstreamer_bad_options
)
gstreamer_plugins=(
  coreelements app audioconvert audiorate audioresample audiotestsrc videotestsrc
  opengl gio opus playback typefindfunctions videoconvertscale videorate volume
  autodetect pulseaudio alsa video4linux2 rtp rtpmanager vpx nice dtls sctp srtp webrtc
)
gstreamer_packages=(
  gstreamer-1.0 gstreamer-base-1.0 gstreamer-app-1.0
  gstreamer-rtp-1.0 gstreamer-sdp-1.0
  gstreamer-webrtc-1.0 gstreamer-webrtc-nice-1.0 gstreamer-sctp-1.0
  gstreamer-audio-1.0 gstreamer-video-1.0 gstreamer-pbutils-1.0 gstreamer-gl-1.0
)
gstreamer_libraries=(
  libgstreamer-1.0.so.0 libgstbase-1.0.so.0 libgstnet-1.0.so.0 libgstcontroller-1.0.so.0
  libgstapp-1.0.so.0 libgstaudio-1.0.so.0 libgstfft-1.0.so.0 libgstpbutils-1.0.so.0
  libgstriff-1.0.so.0 libgstrtp-1.0.so.0 libgstrtsp-1.0.so.0 libgstsdp-1.0.so.0
  libgsttag-1.0.so.0 libgstvideo-1.0.so.0 libgstallocators-1.0.so.0 libgstgl-1.0.so.0
  libgstsctp-1.0.so.0 libgstwebrtc-1.0.so.0 libgstwebrtcnice-1.0.so.0 libnice.so.10
)

# Keep every host-independent option in one array. It drives configuration,
# cache assertions, and the shipped manifest, so those three cannot drift.
webkit_cmake_options=(
  '-DPORT:STRING=GTK'
  '-DCMAKE_BUILD_TYPE:STRING=Release'
  '-DCMAKE_INSTALL_PREFIX:PATH=/usr'
  '-DCMAKE_INSTALL_LIBDIR:PATH=lib/x86_64-linux-gnu'
  '-DCMAKE_INSTALL_LIBEXECDIR:PATH=lib/x86_64-linux-gnu'
  '-DCMAKE_SKIP_RPATH:BOOL=ON'
  '-DUSE_GTK4:BOOL=OFF'
  '-DENABLE_EXPERIMENTAL_FEATURES:BOOL=OFF'
  '-DENABLE_WEB_RTC:BOOL=ON'
  '-DENABLE_MEDIA_STREAM:BOOL=ON'
  '-DUSE_GSTREAMER:BOOL=ON'
  '-DUSE_GSTREAMER_WEBRTC:BOOL=ON'
  '-DUSE_LIBRICE:BOOL=ON'
  '-DENABLE_BUBBLEWRAP_SANDBOX:BOOL=ON'
  '-DBWRAP_EXECUTABLE:FILEPATH=/usr/bin/bwrap'
  '-DDBUS_PROXY_EXECUTABLE:FILEPATH=/usr/bin/xdg-dbus-proxy'
  '-DENABLE_WAYLAND_TARGET:BOOL=ON'
  '-DENABLE_X11_TARGET:BOOL=ON'
  '-DENABLE_QUARTZ_TARGET:BOOL=OFF'
  '-DUSE_GBM:BOOL=ON'
  '-DUSE_LIBDRM:BOOL=ON'
  '-DUSE_SYSTEM_SYSPROF_CAPTURE:BOOL=ON'
  '-DENABLE_DOCUMENTATION:BOOL=OFF'
  '-DENABLE_INTROSPECTION:BOOL=OFF'
  '-DENABLE_MINIBROWSER:BOOL=OFF'
  '-DENABLE_WEBDRIVER:BOOL=OFF'
  '-DENABLE_SPEECH_SYNTHESIS:BOOL=OFF'
  '-DUSE_FLITE:BOOL=OFF'
  '-DENABLE_GAMEPAD:BOOL=OFF'
  '-DUSE_AVIF:BOOL=OFF'
  '-DUSE_JPEGXL:BOOL=OFF'
  '-DUSE_LIBBACKTRACE:BOOL=OFF'
)

expected_manifest() {
  local option index
  printf '%s\n' \
    'manifest-format=2' \
    "runtime-id=$runtime_id" \
    'architecture=x86_64' \
    "webkit-version=$webkit_version" \
    "webkit-source-url=$webkit_url" \
    "webkit-source-sha256=$webkit_sha256" \
    "webkit-patch-path=$patch_relative" \
    "webkit-patch-sha256=$webkit_patch_sha256" \
    "librice-version=$rice_version" \
    "librice-source-url=$rice_url" \
    "librice-source-sha256=$rice_sha256" \
    "librice-cargo-lock-sha256=$rice_lock_sha256" \
    "librice-notice-sha256=$rice_notice_sha256" \
    "librice-notice-manifest-sha256=$rice_notice_manifest_sha256" \
    "gstreamer-version=$gstreamer_version" \
    "gstreamer-license-sha256=$gstreamer_license_sha256" \
    "gstreamer-notice-sha256=$gstreamer_notice_sha256" \
    "gstreamer-license-inventory-sha256=$gstreamer_license_inventory_sha256" \
    'gstreamer-license-file-count=15' \
    "libnice-version=$libnice_version" \
    "libnice-source-url=$libnice_url" \
    "libnice-source-sha256=$libnice_sha256" \
    "libnice-licensing-sha256=$libnice_licensing_sha256" \
    "libnice-lgpl-sha256=$libnice_lgpl_sha256" \
    "libnice-mpl-sha256=$libnice_mpl_sha256" \
    "gstreamer-meson-version=$meson_version" \
    "gstreamer-meson-source-url=$meson_url" \
    "gstreamer-meson-source-sha256=$meson_sha256" \
    "gstreamer-meson-license-sha256=$meson_license_sha256" \
    "gstreamer-ptp-license-url=$gstreamer_ptp_license_url" \
    "gstreamer-ptp-license-sha256=$gstreamer_ptp_license_sha256" \
    'gstreamer-ptp-compiler-policy=Rust standard library only; no Cargo dependencies; release CI pins Rust 1.97.1' \
    'gstreamer-install-policy=matched core/base/good/bad and libnice shared libraries; curated plugins; system PipeWire plugin' \
    'gstreamer-rpath-policy=remove all build-prefix RPATH and RUNPATH entries before packaging' \
    'gstreamer-sctp-policy=dynamic Noble libusrsctp; no bundled static usrsctp' \
    'librice-cargo-closure=union of locked/offline x86_64 normal edges for rice-proto/capi and rice-io/capi' \
    "cargo-c-version=$cargo_c_version" \
    'compiler-policy=GCC >= 12.2 or Clang; release CI pins GCC 12' \
    'gstreamer-policy=matched source-built maintained 1.28 stable series; early transceiver association and complete remote stream identities' \
    'cmake-generator=Ninja' \
    "appimage-runtime-relative-directory=$appimage_runtime_dirname" \
    "appimage-runtime-install-directory=/usr/bin/$appimage_runtime_dirname" \
    'appimage-runtime-processes=WebKitNetworkProcess,WebKitWebProcess,WebKitGPUProcess' \
    'appimage-runtime-injected-bundle=injected-bundle/libwebkit2gtkinjectedbundle.so' \
    'appimage-sandbox-helpers=/usr/bin/bwrap,/usr/bin/xdg-dbus-proxy'
  for option in "${webkit_cmake_options[@]}"; do
    printf 'cmake-option=%s\n' "$option"
  done
  for option in "${gstreamer_meson_options[@]}"; do
    printf 'gstreamer-meson-option=%s\n' "$option"
  done
  for option in "${libnice_meson_options[@]}"; do
    printf 'libnice-meson-option=%s\n' "$option"
  done
  for index in "${!gstreamer_components[@]}"; do
    printf '%s\n' \
      "${gstreamer_components[$index]}-source-url=${gstreamer_urls[$index]}" \
      "${gstreamer_components[$index]}-source-sha256=${gstreamer_hashes[$index]}"
    local -n component_options="${gstreamer_option_arrays[$index]}"
    for option in "${component_options[@]}"; do
      printf '%s-meson-option=%s\n' "${gstreamer_components[$index]}" "$option"
    done
  done
  for option in "${gstreamer_packages[@]}"; do
    printf 'gstreamer-pkg-config=%s = %s\n' "$option" "$gstreamer_version"
  done
  # The manifest keeps relocation placeholders literal for cache reuse.
  # shellcheck disable=SC2016
  printf '%s\n' \
    'cmake-option=-DRice_PROTO_LIBRARY:FILEPATH=${RUNTIME_ROOT}/usr/lib/x86_64-linux-gnu/librice-proto.so' \
    'cmake-option=-DRice_IO_LIBRARY:FILEPATH=${RUNTIME_ROOT}/usr/lib/x86_64-linux-gnu/librice-io.so' \
    'cmake-option=-DRiceProto_INCLUDE_DIR:PATH=${RUNTIME_ROOT}/usr/include/rice' \
    'cmake-option=-DRiceIo_INCLUDE_DIR:PATH=${RUNTIME_ROOT}/usr/include/rice' \
    'rice-link-policy=Rice::Io imports Rice::Proto; both are direct WebKit subprocess dependencies' \
    'wayland-protocols-policy=resolve host pkgdatadir without PKG_CONFIG_SYSROOT_DIR and assert Ninja inputs' \
    'pkg-config-policy=runtime .pc files are rebased to ${RUNTIME_ROOT}; no PKG_CONFIG_SYSROOT_DIR' \
    'webkit-license-file-count=59' \
    'license-payload=COPYING.LIB' \
    'license-payload=LICENSE-APPLE' \
    'license-payload=LICENSE-LGPL-2' \
    'license-payload=LICENSE-LGPL-2.1' \
    'license-payload=librice-LICENSE-APACHE' \
    'license-payload=librice-LICENSE-MIT' \
    'license-payload=LIBRICE-THIRD-PARTY-NOTICES.txt' \
    'license-payload=LIBRICE-THIRD-PARTY-NOTICES.json' \
    'license-payload=webkitgtk-appimage-sandbox.patch' \
    'license-payload=GStreamer-LICENSE-LGPL-2.1' \
    'license-payload=GStreamer-PTP-LICENSE-MPL-2.0' \
    'license-payload=Libnice-LICENSING' \
    'license-payload=Libnice-LICENSE-LGPL-2.1' \
    'license-payload=Libnice-LICENSE-MPL-1.1' \
    'license-payload=GSTREAMER-THIRD-PARTY-LICENSES.txt' \
    'license-payload=GSTREAMER-LICENSE-FILES.sha256' \
    'license-payload=Meson-LICENSE-APACHE-2.0' \
    'license-payload=WEBKIT-LICENSE-FILES.sha256' \
    'license-payload=WEBKIT-THIRD-PARTY-LICENSES.txt'
}

usage() {
  cat >&2 <<USAGE
usage: $0 [--print-prefix|--print-pkg-config-path|--print-manifest]
       $0 --source-bundle <output.tar.gz>
USAGE
}

mode=build
source_bundle_output=
case ${1:-} in
  --print-prefix)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    printf '%s\n' "$runtime_dir"
    exit 0
    ;;
  --print-pkg-config-path)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    printf '%s\n' "$runtime_pkgconfig"
    exit 0
    ;;
  --print-manifest)
    [[ $# -eq 1 ]] || { usage; exit 2; }
    mode=print-manifest
    ;;
  --source-bundle)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    mode=source-bundle
    source_bundle_output=$2
    ;;
  '')
    [[ $# -eq 0 ]] || { usage; exit 2; }
    ;;
  *)
    usage
    exit 2
    ;;
esac

[[ -f $patch_file && ! -L $patch_file ]] || die "missing regular patch file: $patch_file"
[[ -f $librice_notice_generator && ! -L $librice_notice_generator ]] || {
  die "missing regular librice notice generator: $librice_notice_generator"
}
read -r actual_patch_sha256 _ < <(sha256sum "$patch_file")
[[ $actual_patch_sha256 == "$webkit_patch_sha256" ]] || {
  die "patch SHA256 mismatch (expected $webkit_patch_sha256, got $actual_patch_sha256)"
}
[[ $(grep -Fc "\"$appimage_runtime_dirname\"" "$patch_file") -eq 2 ]] || {
  die "patch does not contain both exact AppImage runtime directory locators"
}

if [[ $mode == print-manifest ]]; then
  expected_manifest
  exit 0
fi

for command_name in cmp find grep mktemp mv node pkg-config readelf realpath sha256sum wc; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing runtime-cache dependency: $command_name"
done

downloads="$work_root/downloads"
webkit_archive="$downloads/webkitgtk-$webkit_version.tar.xz"
rice_archive="$downloads/librice-$rice_version.tar.gz"
libnice_archive="$downloads/libnice-$libnice_version.tar.gz"
meson_archive="$downloads/meson-$meson_version.tar.gz"

download_verified() {
  local url=$1
  local destination=$2
  local expected=$3
  local actual temporary
  if [[ -f $destination ]]; then
    read -r actual _ < <(sha256sum "$destination")
    [[ $actual == "$expected" ]] && return 0
  fi
  temporary=$(mktemp "${destination}.download.XXXXXX")
  if ! curl --fail --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-all-errors --connect-timeout 30 \
    --output "$temporary" "$url"; then
    rm -f -- "$temporary"
    return 1
  fi
  read -r actual _ < <(sha256sum "$temporary")
  if [[ $actual != "$expected" ]]; then
    rm -f -- "$temporary"
    die "download SHA256 mismatch for $url (expected $expected, got $actual)"
  fi
  mv -f -- "$temporary" "$destination"
}

download_gstreamer_sources() {
  local index
  for index in "${!gstreamer_components[@]}"; do
    download_verified "${gstreamer_urls[$index]}" \
      "$downloads/${gstreamer_components[$index]}-$gstreamer_version.tar.xz" \
      "${gstreamer_hashes[$index]}"
  done
  download_verified "$libnice_url" "$libnice_archive" "$libnice_sha256"
  download_verified "$meson_url" "$meson_archive" "$meson_sha256"
  download_verified "$gstreamer_ptp_license_url" "$downloads/MPL-2.0.txt" \
    "$gstreamer_ptp_license_sha256"
}

generate_gstreamer_licenses() {
  python3 - "$downloads" "$1" "$gstreamer_version" "$libnice_version" "$meson_version" <<'PY'
import hashlib
from pathlib import Path
import re
import sys
import tarfile

downloads, output = map(Path, sys.argv[1:3])
version, libnice_version, meson_version = sys.argv[3:6]
output.mkdir(parents=True, exist_ok=True)
inventory = []
notices = [b"StudyVis GStreamer upstream license and author inventory\n"]
for component in ("gstreamer", "gst-plugins-base", "gst-plugins-good", "gst-plugins-bad"):
    with tarfile.open(downloads / f"{component}-{version}.tar.xz") as archive:
        for member in sorted(archive.getmembers(), key=lambda entry: entry.name):
            name = Path(member.name).name.upper()
            if not member.isfile() or not re.fullmatch(r"COPYING(?:\..*)?|LICENSE(?:\..*)?|NOTICE(?:\..*)?|AUTHORS", name):
                continue
            data = archive.extractfile(member).read()
            inventory.append(f"{hashlib.sha256(data).hexdigest()}  {member.name}\n")
            notices.extend([f"\n===== {member.name} =====\n\n".encode(), data, b"\n"])
        if component == "gst-plugins-bad":
            (output / "GStreamer-LICENSE-LGPL-2.1").write_bytes(
                archive.extractfile(f"{component}-{version}/COPYING").read()
            )
        if component == "gstreamer":
            ptp_path = f"{component}-{version}/libs/gst/helpers/ptp/main.rs"
            ptp_source = archive.extractfile(ptp_path).read()
            ptp_notice = ptp_source.split(b"\n\n", 1)[0] + b"\n"
            inventory.append(f"{hashlib.sha256(ptp_notice).hexdigest()}  {ptp_path}:license-header\n")
            notices.extend([f"\n===== {ptp_path}:license-header =====\n\n".encode(), ptp_notice])
with tarfile.open(downloads / f"libnice-{libnice_version}.tar.gz") as archive:
    for filename in ("AUTHORS", "COPYING", "COPYING.LGPL", "COPYING.MPL"):
        member_name = f"libnice-{libnice_version}/{filename}"
        data = archive.extractfile(member_name).read()
        inventory.append(f"{hashlib.sha256(data).hexdigest()}  {member_name}\n")
        notices.extend([f"\n===== {member_name} =====\n\n".encode(), data, b"\n"])
    (output / "Libnice-LICENSING").write_bytes(
        archive.extractfile(f"libnice-{libnice_version}/COPYING").read()
    )
    (output / "Libnice-LICENSE-LGPL-2.1").write_bytes(
        archive.extractfile(f"libnice-{libnice_version}/COPYING.LGPL").read()
    )
    (output / "Libnice-LICENSE-MPL-1.1").write_bytes(
        archive.extractfile(f"libnice-{libnice_version}/COPYING.MPL").read()
    )
ptp_license = (downloads / "MPL-2.0.txt").read_bytes()
(output / "GStreamer-PTP-LICENSE-MPL-2.0").write_bytes(ptp_license)
inventory.append(f"{hashlib.sha256(ptp_license).hexdigest()}  MPL-2.0.txt\n")
notices.extend([b"\n===== gst-ptp-helper: Mozilla Public License 2.0 =====\n\n", ptp_license])
with tarfile.open(downloads / f"meson-{meson_version}.tar.gz") as archive:
    (output / "Meson-LICENSE-APACHE-2.0").write_bytes(
        archive.extractfile(f"meson-{meson_version}/COPYING").read()
    )
(output / "GSTREAMER-LICENSE-FILES.sha256").write_text("".join(inventory), encoding="utf-8")
(output / "GSTREAMER-THIRD-PARTY-LICENSES.txt").write_bytes(b"".join(notices))
PY
  local actual
  read -r actual _ < <(sha256sum "$1/GSTREAMER-THIRD-PARTY-LICENSES.txt")
  [[ $actual == "$gstreamer_notice_sha256" ]] || die "unexpected GStreamer third-party notices"
  read -r actual _ < <(sha256sum "$1/GSTREAMER-LICENSE-FILES.sha256")
  [[ $actual == "$gstreamer_license_inventory_sha256" ]] || die "unexpected GStreamer license inventory"
  [[ $(wc -l <"$1/GSTREAMER-LICENSE-FILES.sha256") -eq 15 ]] || {
    die "unexpected GStreamer/libnice license file count"
  }
}

create_source_bundle() (
  local requested_output=$1
  local output parent temporary_root temporary_output bundle_name bundle_dir
  local bundle_sha256 actual_notice_sha256 actual_notice_manifest_sha256
  local index

  [[ $requested_output == *.tar.gz ]] || die "source bundle output must end in .tar.gz"
  if [[ $requested_output != /* ]]; then
    requested_output="$PWD/$requested_output"
  fi
  [[ ! -L $requested_output ]] || die "refusing symlinked source bundle output: $requested_output"
  output=$(normalize_output_path source-bundle-output "$requested_output")
  [[ ! -d $output && ! -L $output ]] || die "refusing source bundle directory or symlink: $output"
  [[ $output != "$webkit_archive" && $output != "$rice_archive" && \
     $output != "$libnice_archive" && $output != "$meson_archive" && \
     $output != "$downloads"/gst*.tar.xz ]] || {
    die "source bundle output must not replace a verified source archive: $output"
  }
  parent=${output%/*}
  [[ -n $parent ]] || parent=/
  [[ -d $parent && -w $parent ]] || die "source bundle parent is not writable: $parent"

  for command_name in curl find gzip install python3 sort tar xargs; do
    command -v "$command_name" >/dev/null 2>&1 || die "missing source-bundle dependency: $command_name"
  done
  install -d "$downloads"
  download_verified "$webkit_url" "$webkit_archive" "$webkit_sha256"
  download_verified "$rice_url" "$rice_archive" "$rice_sha256"
  download_gstreamer_sources

  temporary_root=$(mktemp -d "$work_root/source-bundle.XXXXXX")
  temporary_output=$(mktemp "$parent/.studyvis-webkit-source.XXXXXX")
  trap 'rm -rf -- "$temporary_root"; rm -f -- "$temporary_output"' EXIT
  bundle_name="studyvis-webkit-runtime-source-$runtime_id"
  bundle_dir="$temporary_root/$bundle_name"
  install -d "$bundle_dir/scripts/patches" "$bundle_dir/sources" "$bundle_dir/licenses"
  install -m 0755 "$script_dir/build-linux-webkit-runtime.sh" \
    "$bundle_dir/scripts/build-linux-webkit-runtime.sh"
  install -m 0644 "$script_dir/linux-webkit-runtime.env" \
    "$bundle_dir/scripts/linux-webkit-runtime.env"
  install -m 0755 "$librice_notice_generator" \
    "$bundle_dir/scripts/generate-librice-third-party-notices.mjs"
  install -m 0644 "$patch_file" "$bundle_dir/$patch_relative"
  install -m 0644 "$webkit_archive" "$bundle_dir/sources/webkitgtk-$webkit_version.tar.xz"
  install -m 0644 "$rice_archive" "$bundle_dir/sources/librice-$rice_version.tar.gz"
  for index in "${!gstreamer_components[@]}"; do
    install -m 0644 "$downloads/${gstreamer_components[$index]}-$gstreamer_version.tar.xz" \
      "$bundle_dir/sources/"
  done
  install -m 0644 "$libnice_archive" "$bundle_dir/sources/"
  install -m 0644 "$meson_archive" "$bundle_dir/sources/"
  install -m 0644 "$downloads/MPL-2.0.txt" "$bundle_dir/sources/"
  generate_gstreamer_licenses "$bundle_dir/licenses"
  node "$librice_notice_generator" --check "$licenses" \
    --expected-lock-sha "$rice_lock_sha256"
  read -r actual_notice_sha256 _ < <(sha256sum "$librice_notice")
  [[ $actual_notice_sha256 == "$rice_notice_sha256" ]] || {
    die "librice notice output does not match the pinned closure"
  }
  read -r actual_notice_manifest_sha256 _ < <(sha256sum "$librice_notice_manifest")
  [[ $actual_notice_manifest_sha256 == "$rice_notice_manifest_sha256" ]] || {
    die "librice notice manifest does not match the pinned closure"
  }
  install -m 0644 "$librice_notice" "$librice_notice_manifest" \
    "$bundle_dir/licenses/"
  expected_manifest >"$bundle_dir/BUILD-MANIFEST.txt"
  cat >"$bundle_dir/SOURCE-BUNDLE-README.txt" <<README
StudyVis corresponding source bundle for $runtime_id

This archive contains the exact verified WebKitGTK, librice, GStreamer
core/base/good/bad, libnice, and Meson archives, StudyVis's patch, build/notice-generation
scripts, pinned supply-chain environment, the deterministic build manifest,
and the exact locked librice dependency notice pair shipped in the AppImage.
To reconstruct the modified WebKitGTK source tree:

  tar -xf sources/webkitgtk-$webkit_version.tar.xz
  patch -d webkitgtk-$webkit_version -p1 < $patch_relative

The GStreamer and libnice archives are unmodified upstream releases. The builder
installs core, base, good, libnice, and bad in that order, with the complete Meson
options and exact ABI versions recorded in BUILD-MANIFEST.txt. Meson subproject
downloads are disabled. External dependencies, including PipeWire and dynamic
libusrsctp, remain the Ubuntu 24.04 packages inventoried in the companion Linux
system-sources archive. The AppImage carries only the curated plugins.
The matching gst-ptp-helper source is in the GStreamer core archive under
libs/gst/helpers/ptp and uses only the Rust standard library, with no Cargo
dependencies. Its copyright notice and complete Mozilla Public License 2.0
are included in the GStreamer license inventory; the separately pinned
canonical MPL 2.0 text is also included in sources/MPL-2.0.txt.

Verify every payload first with:

  sha256sum --check SHA256SUMS
README
  (
    cd "$bundle_dir"
    find BUILD-MANIFEST.txt SOURCE-BUNDLE-README.txt scripts licenses sources -type f -print0 \
      | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS
  )
  chmod 0644 "$bundle_dir/BUILD-MANIFEST.txt" \
    "$bundle_dir/SOURCE-BUNDLE-README.txt" "$bundle_dir/SHA256SUMS"

  LC_ALL=C tar --create --format=posix --sort=name \
    --mtime='@0' --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' \
    --pax-option=delete=atime,delete=ctime \
    --directory "$temporary_root" "$bundle_name" | \
    gzip --no-name --best >"$temporary_output"
  chmod 0644 "$temporary_output"
  mv -f -- "$temporary_output" "$output"
  read -r bundle_sha256 _ < <(sha256sum "$output")
  echo "Created deterministic source bundle: $output"
  echo "SHA256: $bundle_sha256"
)

if [[ $mode == source-bundle ]]; then
  create_source_bundle "$source_bundle_output"
  exit 0
fi

required_runtime_files=(
  "$runtime_libdir/libwebkit2gtk-4.1.so.0"
  "$runtime_libdir/libjavascriptcoregtk-4.1.so.0"
  "$runtime_libdir/librice-proto.so.0"
  "$runtime_libdir/librice-io.so.0"
  "$runtime_libdir/libnice.so.10"
  "$gstreamer_plugin"
  "$runtime_libdir/webkit2gtk-4.1/WebKitNetworkProcess"
  "$runtime_libdir/webkit2gtk-4.1/WebKitWebProcess"
  "$runtime_libdir/webkit2gtk-4.1/WebKitGPUProcess"
  "$runtime_libdir/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"
  "$runtime_pkgconfig/webkit2gtk-4.1.pc"
  "$runtime_pkgconfig/javascriptcoregtk-4.1.pc"
  "$runtime_pkgconfig/rice-proto.pc"
  "$runtime_pkgconfig/rice-io.pc"
  "$runtime_pkgconfig/nice.pc"
  "$licenses/COPYING.LIB"
  "$licenses/LICENSE-APPLE"
  "$licenses/LICENSE-LGPL-2"
  "$licenses/LICENSE-LGPL-2.1"
  "$licenses/librice-LICENSE-APACHE"
  "$licenses/librice-LICENSE-MIT"
  "$librice_notice"
  "$librice_notice_manifest"
  "$licenses/webkitgtk-appimage-sandbox.patch"
  "$licenses/GStreamer-LICENSE-LGPL-2.1"
  "$licenses/GStreamer-PTP-LICENSE-MPL-2.0"
  "$licenses/Libnice-LICENSING"
  "$licenses/Libnice-LICENSE-LGPL-2.1"
  "$licenses/Libnice-LICENSE-MPL-1.1"
  "$licenses/GSTREAMER-THIRD-PARTY-LICENSES.txt"
  "$licenses/GSTREAMER-LICENSE-FILES.sha256"
  "$licenses/Meson-LICENSE-APACHE-2.0"
  "$licenses/WEBKIT-LICENSE-FILES.sha256"
  "$licenses/WEBKIT-THIRD-PARTY-LICENSES.txt"
  "$manifest"
)

verify_gstreamer_packages() {
  local package resolved_libdir
  pkg-config --exact-version="$gstreamer_version" "${gstreamer_packages[@]}" || return 1
  for package in "${gstreamer_packages[@]}"; do
    resolved_libdir=$(pkg-config --variable=libdir "$package") || return 1
    [[ $resolved_libdir == "$runtime_libdir" ]] || return 1
  done
}

gstreamer_runtime_is_complete() {
  local elf_header dynamic library plugin helper package
  [[ -s $gstreamer_plugin && ! -L $gstreamer_plugin ]] || return 1
  for plugin in "${gstreamer_plugins[@]}"; do
    [[ -f $runtime_libdir/gstreamer-1.0/libgst$plugin.so ]] || return 1
    if [[ $plugin != nice ]]; then
      grep -aFq "$gstreamer_package_name" "$runtime_libdir/gstreamer-1.0/libgst$plugin.so" || return 1
    fi
  done
  for helper in gst-plugin-scanner gst-ptp-helper; do
    [[ -x $gstreamer_helpers/$helper ]] || return 1
  done
  for library in "${gstreamer_libraries[@]}"; do
    [[ -s $runtime_libdir/$library ]] || return 1
  done
  while IFS= read -r -d '' library; do
    elf_header=$(readelf -h "$library" 2>/dev/null) || return 1
    grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64' <<<"$elf_header" || return 1
    dynamic=$(readelf -d "$library" 2>/dev/null) || return 1
    if grep -Eq '\((RPATH|RUNPATH)\)' <<<"$dynamic"; then
      return 1
    fi
  done < <(find "$runtime_libdir" -maxdepth 2 -type f \( -name 'libgst*.so*' -o -name 'libnice.so*' -o -name 'gst-plugin-scanner' -o -name 'gst-ptp-helper' \) -print0)
  for package in "${gstreamer_packages[@]}"; do
    grep -Fqx "Version: $gstreamer_version" "$runtime_pkgconfig/$package.pc" || return 1
  done
  grep -Fqx "Version: $libnice_version" "$runtime_pkgconfig/nice.pc" || return 1
}

runtime_is_complete() {
  local actual_runtime_patch_sha256 actual_notice_sha256 actual_notice_manifest_sha256 file
  local elf_header webkit_needed actual_gstreamer_sha256
  [[ -f $marker && ! -L $marker && $(<"$marker") == "$runtime_id" ]] || return 1
  for file in "${required_runtime_files[@]}"; do
    [[ -s $file ]] || return 1
  done
  cmp -s "$manifest" <(expected_manifest) || return 1
  read -r actual_runtime_patch_sha256 _ < <(
    sha256sum "$licenses/webkitgtk-appimage-sandbox.patch"
  )
  [[ $actual_runtime_patch_sha256 == "$webkit_patch_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/GStreamer-LICENSE-LGPL-2.1")
  [[ $actual_gstreamer_sha256 == "$gstreamer_license_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/GStreamer-PTP-LICENSE-MPL-2.0")
  [[ $actual_gstreamer_sha256 == "$gstreamer_ptp_license_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/Meson-LICENSE-APACHE-2.0")
  [[ $actual_gstreamer_sha256 == "$meson_license_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/Libnice-LICENSING")
  [[ $actual_gstreamer_sha256 == "$libnice_licensing_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/Libnice-LICENSE-LGPL-2.1")
  [[ $actual_gstreamer_sha256 == "$libnice_lgpl_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/Libnice-LICENSE-MPL-1.1")
  [[ $actual_gstreamer_sha256 == "$libnice_mpl_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/GSTREAMER-THIRD-PARTY-LICENSES.txt")
  [[ $actual_gstreamer_sha256 == "$gstreamer_notice_sha256" ]] || return 1
  read -r actual_gstreamer_sha256 _ < <(sha256sum "$licenses/GSTREAMER-LICENSE-FILES.sha256")
  [[ $actual_gstreamer_sha256 == "$gstreamer_license_inventory_sha256" ]] || return 1
  [[ $(wc -l <"$licenses/GSTREAMER-LICENSE-FILES.sha256") -eq 15 ]] || return 1
  gstreamer_runtime_is_complete || return 1
  [[ $(wc -l <"$licenses/WEBKIT-LICENSE-FILES.sha256") -eq 59 ]] || return 1
  node "$librice_notice_generator" --check "$licenses" \
    --expected-lock-sha "$rice_lock_sha256" >/dev/null || return 1
  read -r actual_notice_sha256 _ < <(sha256sum "$librice_notice")
  [[ $actual_notice_sha256 == "$rice_notice_sha256" ]] || return 1
  read -r actual_notice_manifest_sha256 _ < <(sha256sum "$librice_notice_manifest")
  [[ $actual_notice_manifest_sha256 == "$rice_notice_manifest_sha256" ]] || return 1

  for file in \
    "$runtime_libdir/libwebkit2gtk-4.1.so.0" \
    "$runtime_libdir/libjavascriptcoregtk-4.1.so.0" \
    "$runtime_libdir/librice-proto.so.0" \
    "$runtime_libdir/librice-io.so.0" \
    "$runtime_libdir/libnice.so.10" \
    "$runtime_libdir/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"; do
    elf_header=$(readelf -h "$file" 2>/dev/null) || return 1
    grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64' <<<"$elf_header" || return 1
  done
  for file in \
    "$runtime_libdir/webkit2gtk-4.1/WebKitNetworkProcess" \
    "$runtime_libdir/webkit2gtk-4.1/WebKitWebProcess" \
    "$runtime_libdir/webkit2gtk-4.1/WebKitGPUProcess"; do
    [[ -x $file ]] || return 1
    elf_header=$(readelf -h "$file" 2>/dev/null) || return 1
    grep -Eq 'Machine:[[:space:]]+Advanced Micro Devices X86-64' <<<"$elf_header" || return 1
  done

  grep -aFq "$appimage_runtime_dirname" \
    "$runtime_libdir/libwebkit2gtk-4.1.so.0" || return 1
  webkit_needed=$(readelf -d "$runtime_libdir/libwebkit2gtk-4.1.so.0") || return 1
  grep -Fq 'Shared library: [librice-proto.so.0]' <<<"$webkit_needed" || return 1
  grep -Fq 'Shared library: [librice-io.so.0]' <<<"$webkit_needed" || return 1
}

rebase_pc_file() {
  local pc_file=$1
  local temporary line
  [[ -f $pc_file && ! -L $pc_file ]] || die "missing regular pkg-config file: $pc_file"
  temporary=$(mktemp "${pc_file}.tmp.XXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      prefix=*) printf 'prefix=%s/usr\n' "$runtime_dir" ;;
      libdir=*) printf 'libdir=%s\n' "$runtime_libdir" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$pc_file" >"$temporary"
  # GStreamer's GL platform aliases contain only headers and Requires. Give
  # those valid metadata-only modules the same explicit library root as the
  # modules that own a shared library.
  if ! grep -q '^libdir=' "$pc_file"; then
    printf 'libdir=%s\n' "$runtime_libdir" >>"$temporary"
  fi
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$pc_file"
  grep -Fqx "prefix=$runtime_dir/usr" "$pc_file" || die "failed to rebase $pc_file prefix"
  grep -Fqx "libdir=$runtime_libdir" "$pc_file" || die "failed to rebase $pc_file libdir"
}

rebase_pkgconfig_files() {
  local pc_file
  for pc_file in \
    "$runtime_pkgconfig/rice-proto.pc" \
    "$runtime_pkgconfig/rice-io.pc" \
    "$runtime_pkgconfig/nice.pc" \
    "$runtime_pkgconfig/javascriptcoregtk-4.1.pc" \
    "$runtime_pkgconfig/webkit2gtk-4.1.pc"; do
    rebase_pc_file "$pc_file"
  done
  for pc_file in "$runtime_pkgconfig"/gstreamer-*.pc; do
    rebase_pc_file "$pc_file"
  done
}

verify_runtime_pkgconfig() {
  local resolved_libdir
  unset PKG_CONFIG_SYSROOT_DIR
  export PKG_CONFIG_PATH="$runtime_pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  pkg-config --exact-version="$rice_version" rice-proto rice-io
  pkg-config --exact-version="$libnice_version" nice
  pkg-config --exact-version="$webkit_version" javascriptcoregtk-4.1 webkit2gtk-4.1
  verify_gstreamer_packages || die "pkg-config did not resolve the complete pinned GStreamer runtime"
  resolved_libdir=$(pkg-config --variable=libdir nice)
  [[ $resolved_libdir == "$runtime_libdir" ]] || {
    die "pkg-config resolved libnice outside the pinned runtime: $resolved_libdir"
  }
  resolved_libdir=$(pkg-config --variable=libdir webkit2gtk-4.1)
  [[ $resolved_libdir == "$runtime_libdir" ]] || {
    die "pkg-config resolved WebKitGTK outside the pinned runtime: $resolved_libdir"
  }
}

if runtime_is_complete; then
  # GitHub caches and local moves can restore the directory at a different
  # absolute path. Rebase the development metadata every time it is reused.
  rebase_pkgconfig_files
  verify_runtime_pkgconfig
  echo "Using cached $runtime_id at $runtime_dir"
  exit 0
fi

for command_name in \
  bison cargo cmake curl find flex gdbus-codegen gperf install ninja patch patchelf perl \
  python3 readelf ruby sort tar unifdef; do
  command -v "$command_name" >/dev/null 2>&1 || {
    die "missing WebKitGTK build dependency: $command_name"
  }
done
[[ -x /usr/bin/bwrap ]] || die "required sandbox helper is not executable: /usr/bin/bwrap"
[[ -x /usr/bin/xdg-dbus-proxy ]] || {
  die "required sandbox helper is not executable: /usr/bin/xdg-dbus-proxy"
}
[[ $(uname -m) == x86_64 ]] || die "the published Linux runtime is pinned to x86_64"

cargo_c_output=$(cargo cinstall --version 2>&1) || die "cargo-c is required"
[[ $cargo_c_output =~ (^|[[:space:]])${cargo_c_version}([+[:space:]]|$) ]] || {
  die "cargo-c $cargo_c_version is required (got: $cargo_c_output)"
}

if [[ -n ${CC:-} || -n ${CXX:-} ]]; then
  [[ -n ${CC:-} && -n ${CXX:-} ]] || die "set CC and CXX together"
  cc_name=$CC
  cxx_name=$CXX
else
  cc_name=gcc-12
  cxx_name=g++-12
  command -v "$cc_name" >/dev/null 2>&1 || cc_name=cc
  command -v "$cxx_name" >/dev/null 2>&1 || cxx_name=c++
fi
cc=$(command -v "$cc_name") || die "C compiler is not executable: $cc_name"
cxx=$(command -v "$cxx_name") || die "C++ compiler is not executable: $cxx_name"
cc=$(realpath --canonicalize-existing -- "$cc")
cxx=$(realpath --canonicalize-existing -- "$cxx")

# WebKit's unified translation units routinely need ~2 GB of RAM each, so the
# job count is the smaller of the CPU count and what memory can actually feed.
# A fixed 2 left hosted runners half idle for two hours; an OOM kill deep in
# the build costs far more than the parallelism saves.
detect_webkit_jobs() {
  local cpus memory_kilobytes memory_jobs
  cpus=$(nproc)
  memory_kilobytes=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  memory_jobs=$((memory_kilobytes / 2 / 1024 / 1024))
  [[ $memory_jobs -ge 1 ]] || memory_jobs=1
  [[ $cpus -ge 1 ]] || cpus=1
  if [[ $cpus -lt $memory_jobs ]]; then
    printf '%s\n' "$cpus"
  else
    printf '%s\n' "$memory_jobs"
  fi
}
webkit_jobs=${STUDYVIS_WEBKIT_JOBS:-$(detect_webkit_jobs)}
require_match STUDYVIS_WEBKIT_JOBS "$webkit_jobs" '^[1-9][0-9]*$'
webkit_keep_build=${STUDYVIS_WEBKIT_KEEP_BUILD:-0}
require_match STUDYVIS_WEBKIT_KEEP_BUILD "$webkit_keep_build" '^[01]$'

webkit_source="$work_root/webkitgtk-$webkit_version"
webkit_build="$work_root/webkitgtk-build"
rice_source="$work_root/librice-$rice_version"
libnice_source="$work_root/libnice-$libnice_version"
libnice_build="$work_root/libnice-build"
meson_source="$work_root/meson-$meson_version"
for generated_path in \
  "$webkit_source" "$webkit_build" "$rice_source" "$libnice_source" \
  "$libnice_build" "$meson_source"; do
  [[ $generated_path != "$runtime_dir" && $runtime_dir != "$generated_path"/* ]] || {
    die "unsafe overlap between runtime and generated build path: $generated_path"
  }
done

# A partial or stale cache must not contribute undeclared files to a new
# runtime. The managed-path checks above make this an exact, dedicated prefix.
if [[ -e $runtime_dir ]]; then
  rm -rf -- "$runtime_dir"
fi
install -d "$downloads" "$runtime_dir"
download_verified "$webkit_url" "$webkit_archive" "$webkit_sha256"
download_verified "$rice_url" "$rice_archive" "$rice_sha256"
download_gstreamer_sources

expected_webkit_extraction() {
  printf '%s\n' \
    "webkit-source-sha256=$webkit_sha256" \
    "webkit-patch-sha256=$webkit_patch_sha256"
}
expected_rice_extraction() {
  printf '%s\n' "librice-source-sha256=$rice_sha256"
}

webkit_extract_marker="$webkit_source/.studyvis-extracted"
if [[ ! -f $webkit_extract_marker ]] || \
  ! cmp -s "$webkit_extract_marker" <(expected_webkit_extraction); then
  rm -rf -- "$webkit_source"
  install -d "$webkit_source"
  tar --extract --file "$webkit_archive" --directory "$webkit_source" \
    --strip-components=1 --no-same-owner --no-same-permissions
  patch --batch --forward --fuzz=0 --directory="$webkit_source" --strip=1 <"$patch_file"
  expected_webkit_extraction >"$webkit_extract_marker"
fi

rice_extract_marker="$rice_source/.studyvis-extracted"
if [[ ! -f $rice_extract_marker ]] || \
  ! cmp -s "$rice_extract_marker" <(expected_rice_extraction); then
  rm -rf -- "$rice_source"
  install -d "$rice_source"
  tar --extract --file "$rice_archive" --directory "$rice_source" \
    --strip-components=1 --no-same-owner --no-same-permissions
  expected_rice_extraction >"$rice_extract_marker"
fi

# #312: WebKit needs the 1.28 negotiation lifecycle and stream identities.
# Build all four GStreamer components and libnice against one prefix so no
# Ubuntu 1.24/0.1.21 library can satisfy a newer plugin on the build runner.
rm -rf -- "$meson_source"
install -d "$meson_source"
tar --extract --file "$meson_archive" --directory "$meson_source" \
  --strip-components=1 --no-same-owner --no-same-permissions
unset PKG_CONFIG_SYSROOT_DIR
export PKG_CONFIG_PATH="$runtime_pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$runtime_libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
for component_index in "${!gstreamer_components[@]}"; do
  component=${gstreamer_components[$component_index]}
  gstreamer_source="$work_root/$component-$gstreamer_version"
  gstreamer_build="$work_root/$component-build"
  rm -rf -- "$gstreamer_source" "$gstreamer_build"
  install -d "$gstreamer_source"
  tar --extract --file "$downloads/$component-$gstreamer_version.tar.xz" \
    --directory "$gstreamer_source" --strip-components=1 --no-same-owner --no-same-permissions
  declare -n component_options="${gstreamer_option_arrays[$component_index]}"
  env CC="$cc" CXX="$cxx" python3 "$meson_source/meson.py" \
    setup "$gstreamer_build" "$gstreamer_source" \
    "${gstreamer_meson_options[@]}" "${component_options[@]}"
  ninja -C "$gstreamer_build" -j "$webkit_jobs"
  DESTDIR="$runtime_dir" python3 "$meson_source/meson.py" \
    install -C "$gstreamer_build" --no-rebuild --strip
  for pc_file in "$runtime_pkgconfig"/gstreamer-*.pc; do
    rebase_pc_file "$pc_file"
  done
  if [[ $component == gst-plugins-good ]]; then
    rm -rf -- "$libnice_source" "$libnice_build"
    install -d "$libnice_source"
    tar --extract --file "$libnice_archive" --directory "$libnice_source" \
      --strip-components=1 --no-same-owner --no-same-permissions
    env CC="$cc" CXX="$cxx" python3 "$meson_source/meson.py" \
      setup "$libnice_build" "$libnice_source" "${libnice_meson_options[@]}"
    ninja -C "$libnice_build" -j "$webkit_jobs"
    DESTDIR="$runtime_dir" python3 "$meson_source/meson.py" \
      install -C "$libnice_build" --no-rebuild --strip
    rebase_pc_file "$runtime_pkgconfig/nice.pc"
  fi
done
while IFS= read -r -d '' gstreamer_elf; do
  patchelf --remove-rpath "$gstreamer_elf"
done < <(find "$runtime_libdir" -maxdepth 2 -type f \( -name 'libgst*.so*' -o -name 'libnice.so*' -o -name 'gst-plugin-scanner' -o -name 'gst-ptp-helper' \) -print0)
verify_gstreamer_packages || die "the source-built GStreamer ABI is incomplete or resolves outside the runtime"
gstreamer_runtime_is_complete || die "the source-built GStreamer runtime is incomplete"
generate_gstreamer_licenses "$licenses"

read -r actual_rice_lock_sha256 _ < <(sha256sum "$rice_source/Cargo.lock")
[[ $actual_rice_lock_sha256 == "$rice_lock_sha256" ]] || {
  die "librice Cargo.lock SHA256 mismatch (expected $rice_lock_sha256, got $actual_rice_lock_sha256)"
}

# Install both C ABI libraries into WebKit's staging prefix. Do not set a
# global PKG_CONFIG_SYSROOT_DIR: that also rewrites system package data such as
# wayland-protocols and makes CMake search for XML below the runtime prefix.
(
  cd "$rice_source"
  cargo fetch --locked
  install -d "$licenses"
  node "$librice_notice_generator" --write "$rice_source" "$licenses"
  node "$librice_notice_generator" --check "$licenses" \
    --expected-lock-sha "$rice_lock_sha256"
  read -r actual_notice_sha256 _ < <(sha256sum "$librice_notice")
  [[ $actual_notice_sha256 == "$rice_notice_sha256" ]] || {
    die "generated librice notice SHA256 mismatch: $actual_notice_sha256"
  }
  read -r actual_notice_manifest_sha256 _ < <(sha256sum "$librice_notice_manifest")
  [[ $actual_notice_manifest_sha256 == "$rice_notice_manifest_sha256" ]] || {
    die "generated librice notice manifest SHA256 mismatch: $actual_notice_manifest_sha256"
  }
  cargo cinstall --frozen --release -p rice-proto --features capi \
    --prefix /usr --libdir /usr/lib/x86_64-linux-gnu --destdir "$runtime_dir"
  cargo cinstall --frozen --release -p rice-io --features capi \
    --prefix /usr --libdir /usr/lib/x86_64-linux-gnu --destdir "$runtime_dir"
)

rice_include="$runtime_dir/usr/include/rice"
rice_proto_library="$runtime_libdir/librice-proto.so"
rice_io_library="$runtime_libdir/librice-io.so"
[[ -f $rice_include/rice-proto.h && -f $rice_include/rice-io.h ]] || {
  die "cargo-c did not install the expected librice headers"
}
[[ -e $rice_proto_library && -e $rice_io_library ]] || {
  die "cargo-c did not install the expected librice libraries"
}
rebase_pc_file "$runtime_pkgconfig/rice-proto.pc"
rebase_pc_file "$runtime_pkgconfig/rice-io.pc"
unset PKG_CONFIG_SYSROOT_DIR
export PKG_CONFIG_PATH="$runtime_pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
pkg-config --exact-version="$rice_version" rice-proto rice-io

wayland_protocols_datadir=$(pkg-config --variable=pkgdatadir wayland-protocols)
[[ $wayland_protocols_datadir == /* ]] || {
  die "wayland-protocols did not report an absolute pkgdatadir: $wayland_protocols_datadir"
}
wayland_protocols_datadir=$(realpath --canonicalize-existing -- "$wayland_protocols_datadir")
[[ $wayland_protocols_datadir != "$runtime_dir"/* ]] || {
  die "wayland-protocols was incorrectly resolved below the WebKit runtime"
}
for protocol_xml in \
  unstable/pointer-constraints/pointer-constraints-unstable-v1.xml \
  unstable/relative-pointer/relative-pointer-unstable-v1.xml; do
  [[ -f $wayland_protocols_datadir/$protocol_xml ]] || {
    die "required Wayland protocol is missing: $wayland_protocols_datadir/$protocol_xml"
  }
done

# A fresh cache prevents a prior failed configure (especially one affected by
# an inherited pkg-config sysroot) from retaining host paths or feature flags.
install -d "$webkit_build"
rm -f -- "$webkit_build/CMakeCache.txt"
rm -rf -- "$webkit_build/CMakeFiles"

cmake -S "$webkit_source" -B "$webkit_build" -G Ninja \
  "${webkit_cmake_options[@]}" \
  -DCMAKE_C_COMPILER:FILEPATH="$cc" \
  -DCMAKE_CXX_COMPILER:FILEPATH="$cxx" \
  -DRice_PROTO_LIBRARY:FILEPATH="$rice_proto_library" \
  -DRice_IO_LIBRARY:FILEPATH="$rice_io_library" \
  -DRiceProto_INCLUDE_DIR:PATH="$rice_include" \
  -DRiceIo_INCLUDE_DIR:PATH="$rice_include"

cmake_cache="$webkit_build/CMakeCache.txt"
for option in "${webkit_cmake_options[@]}"; do
  expected_cache_line=${option#-D}
  grep -Fqx "$expected_cache_line" "$cmake_cache" || {
    die "WebKitGTK configure did not retain $expected_cache_line"
  }
done
for expected_cache_line in \
  "Rice_PROTO_LIBRARY:FILEPATH=$rice_proto_library" \
  "Rice_IO_LIBRARY:FILEPATH=$rice_io_library" \
  "RiceProto_INCLUDE_DIR:PATH=$rice_include" \
  "RiceIo_INCLUDE_DIR:PATH=$rice_include"; do
  grep -Fqx "$expected_cache_line" "$cmake_cache" || {
    die "WebKitGTK configure did not retain $expected_cache_line"
  }
done
for compiler_cache in "CMAKE_C_COMPILER=$cc" "CMAKE_CXX_COMPILER=$cxx"; do
  compiler_variable=${compiler_cache%%=*}
  expected_compiler=${compiler_cache#*=}
  configured_compiler=$(sed -n "s|^${compiler_variable}:[^=]*=||p" "$cmake_cache")
  [[ -n $configured_compiler && -x $configured_compiler ]] || {
    die "WebKitGTK configure did not retain an executable $compiler_variable"
  }
  configured_compiler=$(realpath --canonicalize-existing -- "$configured_compiler")
  [[ $configured_compiler == "$expected_compiler" ]] || {
    die "WebKitGTK configure retained $compiler_variable=$configured_compiler, expected $expected_compiler"
  }
done

# Some GTK options are adjusted after dependency probing. Assert the generated
# configuration too, so a nominal ON cache entry cannot mask an ineffective
# Wayland/X11, sandbox, WebRTC, GStreamer, or librice target.
cmake_config="$webkit_build/cmakeconfig.h"
[[ -f $cmake_config ]] || die "WebKitGTK configure did not generate $cmake_config"
for expected_define in \
  '#define ENABLE_BUBBLEWRAP_SANDBOX 1' \
  '#define ENABLE_DOCUMENTATION 0' \
  '#define ENABLE_EXPERIMENTAL_FEATURES 0' \
  '#define ENABLE_GAMEPAD 0' \
  '#define ENABLE_INTROSPECTION 0' \
  '#define ENABLE_MEDIA_STREAM 1' \
  '#define ENABLE_MINIBROWSER 0' \
  '#define ENABLE_QUARTZ_TARGET 0' \
  '#define ENABLE_SPEECH_SYNTHESIS 0' \
  '#define ENABLE_WAYLAND_TARGET 1' \
  '#define ENABLE_WEB_RTC 1' \
  '#define ENABLE_WEBDRIVER 0' \
  '#define ENABLE_X11_TARGET 1' \
  '#define USE_GBM 1' \
  '#define USE_GSTREAMER 1' \
  '#define USE_GSTREAMER_WEBRTC 1' \
  '#define USE_LIBDRM 1' \
  '#define USE_LIBRICE 1' \
  '#define USE_SYSTEM_SYSPROF_CAPTURE 1' \
  '#define WTF_PLATFORM_QUARTZ 0' \
  '#define WTF_PLATFORM_WAYLAND 1' \
  '#define WTF_PLATFORM_X11 1'; do
  grep -Fqx "$expected_define" "$cmake_config" || {
    die "WebKitGTK generated configuration is missing: $expected_define"
  }
done

# The final WebKit subprocess links do not consume transitive DSO symbols on
# GNU linkers. Catch an omitted Rice::Proto interface dependency before the
# multi-hour compile reaches its three final executable links.
for process_name in WebKitNetworkProcess WebKitWebProcess WebKitGPUProcess; do
  process_link_edge=$(grep -F "build bin/$process_name:" "$webkit_build/build.ninja") || {
    die "WebKitGTK configure did not generate the $process_name link edge"
  }
  [[ $process_link_edge == *"$rice_io_library"* ]] || {
    die "$process_name link edge is missing Rice::Io"
  }
  [[ $process_link_edge == *"$rice_proto_library"* ]] || {
    die "$process_name link edge is missing Rice::Proto"
  }
done
for protocol_xml in \
  unstable/pointer-constraints/pointer-constraints-unstable-v1.xml \
  unstable/relative-pointer/relative-pointer-unstable-v1.xml; do
  grep -Fq "$wayland_protocols_datadir/$protocol_xml" "$webkit_build/build.ninja" || {
    die "WebKitGTK Ninja graph has an invalid Wayland protocol input: $protocol_xml"
  }
done

printf 'Compiling WebKitGTK with %s parallel jobs (%s CPUs, %s kB MemTotal)\n' \
  "$webkit_jobs" "$(nproc)" "$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
cmake --build "$webkit_build" --parallel "$webkit_jobs"
DESTDIR="$runtime_dir" cmake --install "$webkit_build" --strip

install -d "$licenses"
install -m 0644 \
  "$webkit_source/Source/JavaScriptCore/COPYING.LIB" \
  "$webkit_source/Source/WebCore/LICENSE-APPLE" \
  "$webkit_source/Source/WebCore/LICENSE-LGPL-2" \
  "$webkit_source/Source/WebCore/LICENSE-LGPL-2.1" \
  "$licenses/"
install -m 0644 "$rice_source/LICENSE-APACHE" "$licenses/librice-LICENSE-APACHE"
install -m 0644 "$rice_source/LICENSE-MIT" "$licenses/librice-LICENSE-MIT"
install -m 0644 "$patch_file" "$licenses/webkitgtk-appimage-sandbox.patch"

# WebKit installs resources containing several vendored components in addition
# to its main LGPL/BSD surface. Preserve every upstream COPYING/LICENSE/NOTICE
# file in both a readable aggregate and a per-file checksum inventory.
mapfile -d '' -t webkit_license_files < <(
  find "$webkit_source/Source" -type f \
    \( -iname 'copying*' -o -iname 'license*' -o -iname 'notice*' \) \
    -print0 | LC_ALL=C sort -z
)
[[ ${#webkit_license_files[@]} -eq 59 ]] || {
  die "expected 59 WebKit license files, found ${#webkit_license_files[@]}"
}
license_bundle="$licenses/WEBKIT-THIRD-PARTY-LICENSES.txt"
license_hashes="$licenses/WEBKIT-LICENSE-FILES.sha256"
{
  printf '%s\n' \
    'StudyVis WebKitGTK upstream license inventory' \
    "Source: $webkit_url" \
    "SHA256: $webkit_sha256"
  for license_file in "${webkit_license_files[@]}"; do
    license_relative=${license_file#"$webkit_source/"}
    printf '\n===== %s =====\n\n' "$license_relative"
    cat "$license_file"
    printf '\n'
  done
} >"$license_bundle"
{
  for license_file in "${webkit_license_files[@]}"; do
    license_relative=${license_file#"$webkit_source/"}
    read -r license_sha256 _ < <(sha256sum "$license_file")
    printf '%s  %s\n' "$license_sha256" "$license_relative"
  done
} >"$license_hashes"
chmod 0644 "$license_bundle" "$license_hashes"

rebase_pkgconfig_files
verify_runtime_pkgconfig

manifest_temporary=$(mktemp "$licenses/.BUILD-MANIFEST.txt.XXXXXX")
expected_manifest >"$manifest_temporary"
chmod 0644 "$manifest_temporary"
mv -f -- "$manifest_temporary" "$manifest"
printf '%s\n' "$runtime_id" >"$marker"

runtime_is_complete || die "the installed WebKitGTK runtime is incomplete"

if [[ $webkit_keep_build != 1 ]]; then
  rm -rf -- "$webkit_build" "$webkit_source" "$rice_source" \
    "$libnice_source" "$libnice_build" "$meson_source"
  for component in "${gstreamer_components[@]}"; do
    rm -rf -- "$work_root/$component-build" "$work_root/$component-$gstreamer_version"
  done
fi

echo "Built $runtime_id at $runtime_dir"
