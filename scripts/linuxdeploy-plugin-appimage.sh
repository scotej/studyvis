#!/usr/bin/env bash
# #312: host EGL drivers load newer Wayland APIs than Noble's bundled client.
# Vulkan likewise uses the host loader and vendor ICDs.
# Apply those host ABI boundaries after every dependency-deploying input plugin,
# before the unchanged pinned output tool generates the AppImage/signatures.
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output_tool="$script_dir/studyvis-appimage-output.AppImage"
[[ -f $output_tool && -x $output_tool && ! -L $output_tool ]] || {
  die "verified AppImage output tool is missing: $output_tool"
}

case $#:${1:-} in
1:--plugin-type | 1:--plugin-api-version)
  exec "$output_tool" "$@"
  ;;
2:--appdir)
  appdir=$2
  ;;
1:--appdir=*)
  appdir=${1#--appdir=}
  ;;
*)
  die "expected --appdir <AppDir>, --plugin-type, or --plugin-api-version"
  ;;
esac

[[ -d $appdir && ! -L $appdir ]] || die "AppDir is missing or symlinked: $appdir"
logical_appdir=$(realpath --canonicalize-existing --no-symlinks -- "$appdir")
appdir=$(realpath --canonicalize-existing -- "$appdir")
[[ $appdir == "$logical_appdir" ]] || die "refusing a symlinked AppDir path: $logical_appdir"
[[ ${appdir##*/} == *.AppDir ]] || die "refusing a directory without an .AppDir suffix: $appdir"
[[ -d $appdir/usr && ! -L $appdir/usr ]] || die "AppDir usr directory is missing or symlinked"

for libdir in "$appdir/usr/lib" "$appdir/usr/lib64"; do
  [[ ! -L $libdir ]] || die "refusing a symlinked AppDir library directory: $libdir"
  [[ -e $libdir ]] || continue
  [[ -d $libdir ]] || die "AppDir library path is not a directory: $libdir"
  find "$libdir" \( -name 'libwayland-client.so*' -o -name 'libvulkan.so*' \) \
    \( -type f -o -type l \) -delete
done

exec "$output_tool" --appdir "$appdir"
