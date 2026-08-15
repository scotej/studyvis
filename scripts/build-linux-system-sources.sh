#!/usr/bin/env bash
# Audit every ELF in one finished AppImage and, for a tagged release, archive
# matching Ubuntu sources/copyrights plus the exact pinned packaging toolset.
# The inventory starts from artifact bytes, never our apt install list. An ELF
# must be classified as StudyVis, pinned WebKit/llama/AppRun, or tied
# unambiguously to the installed Noble package by byte hash or GNU build-id.

set -euo pipefail
export LC_ALL=C

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage:
  build-linux-system-sources.sh --appimage <StudyVis.AppImage> --output <bundle.tar.gz>
  build-linux-system-sources.sh --appimage <StudyVis.AppImage> --inventory-only <directory>

The full bundle mode requires an amd64 Ubuntu 24.04 host with enabled deb-src
entries for every configured binary repository.  Inventory-only mode performs
the same exact-payload/package/copyright audit without downloading sources.
EOF
  exit 2
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
# shellcheck source=scripts/linuxdeploy-tools.env
source "$script_dir/linuxdeploy-tools.env"
# shellcheck source=scripts/linux-appimage-legal.env
source "$script_dir/linux-appimage-legal.env"
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"
# shellcheck source=scripts/linux-webkit-runtime.env
source "$script_dir/linux-webkit-runtime.env"
appimage=
output=
inventory_output=
mode=

while [[ $# -gt 0 ]]; do
  case $1 in
    --appimage)
      [[ $# -ge 2 ]] || usage
      appimage=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 && -z $mode ]] || usage
      mode=bundle
      output=$2
      shift 2
      ;;
    --inventory-only)
      [[ $# -ge 2 && -z $mode ]] || usage
      mode=inventory
      inventory_output=$2
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n $appimage && -n $mode ]] || usage

for command_name in \
  awk bash cmp dpkg dpkg-query file find grep gzip head install mkdir mktemp mv \
  node readelf readlink realpath rm sed sha256sum sort tar tr uname wc xargs; do
  command -v "$command_name" >/dev/null 2>&1 || {
    die "missing system-source audit dependency: $command_name"
  }
done
if [[ $mode == bundle ]]; then
  for command_name in apt-get curl; do
    command -v "$command_name" >/dev/null 2>&1 || die "missing source download dependency: $command_name"
  done
fi

[[ $(uname -m) == x86_64 ]] || die "the system-source audit is pinned to x86_64"
[[ -r /etc/os-release ]] || die "cannot identify the packaging operating system"
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || {
  die "official system-source bundles must be generated on Ubuntu 24.04 (found ${ID:-unknown} ${VERSION_ID:-unknown})"
}
[[ $(dpkg --print-architecture) == amd64 ]] || die "the package database is not amd64"

normalize_existing() {
  local name=$1
  local value=$2
  [[ $value == /* ]] || die "$name must be an absolute path: $value"
  [[ $value != *$'\n'* && $value != *$'\r'* && $value != *$'\t'* ]] || {
    die "$name contains control whitespace"
  }
  realpath --canonicalize-existing -- "$value"
}

normalize_missing() {
  local name=$1
  local value=$2
  [[ $value == /* ]] || die "$name must be an absolute path: $value"
  [[ $value != *$'\n'* && $value != *$'\r'* && $value != *$'\t'* ]] || {
    die "$name contains control whitespace"
  }
  realpath --canonicalize-missing -- "$value"
}

appimage=$(normalize_existing appimage "$appimage")
[[ -f $appimage && -x $appimage ]] || die "AppImage is missing or not executable: $appimage"

scratch_parent=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
scratch_parent=$(normalize_existing temporary-directory "$scratch_parent")
[[ -d $scratch_parent && -w $scratch_parent ]] || {
  die "temporary directory is not writable: $scratch_parent"
}
work_root=$(mktemp -d "$scratch_parent/studyvis-system-source.XXXXXX")
cleanup() {
  rm -rf -- "$work_root"
}
trap cleanup EXIT

extract_root="$work_root/extract"
mkdir -p "$extract_root"
(cd "$extract_root" && "$appimage" --appimage-extract >/dev/null)
appdir="$extract_root/squashfs-root"
[[ -d $appdir && ! -L $appdir ]] || die "AppImage extraction did not create squashfs-root"

bundle_root="$work_root/bundle"
payload_dir="$bundle_root/studyvis-linux-system-sources"
copyright_dir="$payload_dir/copyright"
source_dir="$payload_dir/sources"
build_input_dir="$payload_dir/build-inputs"
mkdir -p "$copyright_dir" "$source_dir" "$build_input_dir"

payload_inventory="$payload_dir/PAYLOAD-INVENTORY.tsv"
package_inventory="$payload_dir/PACKAGE-INVENTORY.tsv"
source_inventory="$payload_dir/SOURCE-INVENTORY.tsv"
classified_inventory="$payload_dir/NON-UBUNTU-PAYLOAD.tsv"
symlink_inventory="$payload_dir/SYMLINK-INVENTORY.tsv"
dynamic_inventory="$payload_dir/DYNAMIC-LINK-INVENTORY.tsv"
tool_inventory="$payload_dir/PACKAGING-TOOL-INVENTORY.tsv"
printf 'appimage_path\tsha256\tgnu_build_id\tbinary_package\tbinary_version\tsource_package\tsource_version\tinstalled_path\tmatch\n' \
  >"$payload_inventory"
printf 'binary_package\tbinary_version\tsource_package\tsource_version\tcopyright_file\tcopyright_sha256\n' \
  >"$package_inventory"
printf 'source_package\tsource_version\tarchive_path\tsha256\n' >"$source_inventory"
printf 'appimage_path\tsha256\tgnu_build_id\tclassification\tevidence\n' >"$classified_inventory"
printf 'appimage_path\tlink_text\tresolved_appimage_path\tresolved_sha256\n' >"$symlink_inventory"
printf 'tool_filename\tinput_url\tinput_sha256\tsource_component\tsource_revision\tsource_url\tsource_sha256\n' \
  >"$tool_inventory"

declare -A queued=()
declare -A payload_class=()
declare -a queue=()

add_payload() {
  local path=$1
  local class=$2
  [[ -f $path && ! -L $path ]] || die "required packaged payload is missing or symlinked: ${path#"$appdir/"}"
  local rel=${path#"$appdir/"}
  [[ $rel != "$path" && $rel != *$'\n'* && $rel != *$'\r'* && $rel != *$'\t'* ]] || {
    die "unsafe packaged payload path: $path"
  }
  if [[ ! -v queued[$rel] ]]; then
    queued[$rel]=1
    payload_class[$rel]=$class
    queue+=("$rel")
  fi
}

# Directly staged sandbox helpers plus Tauri/linuxdeploy's desktop launch
# helpers are exact Ubuntu package bytes.
for rel in usr/bin/bwrap usr/bin/xdg-dbus-proxy usr/bin/xdg-mime usr/bin/xdg-open; do
  add_payload "$appdir/$rel" direct-helper
done

# Independently prove linuxdeploy-plugin-gstreamer received StudyVis's curated
# stage. Do not let this source generator bless a broader plugin directory just
# because the earlier exact-AppImage check should already have rejected it.
plugins="$appdir/usr/lib/gstreamer-1.0"
plugin_manifest="$script_dir/linux-gstreamer-plugins.txt"
declare -A allowed_plugins=()
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
    if [[ -f $plugins/$candidate && ! -L $plugins/$candidate ]]; then
      [[ -z $selected ]] || die "multiple distro alternatives were packaged for $plugin_group"
      selected=$candidate
    fi
  done
  [[ -n $selected ]] || die "required curated GStreamer plugin is missing: $plugin_group"
  allowed_plugins[$selected]=1
done <"$plugin_manifest"

plugin_count=0
while IFS= read -r -d '' path; do
  [[ -f $path && ! -L $path ]] || die "unexpected non-regular GStreamer plugin entry"
  plugin_name=${path##*/}
  [[ -v allowed_plugins[$plugin_name] ]] || die "uncurated GStreamer plugin was packaged: $plugin_name"
  add_payload "$path" gstreamer-plugin
  plugin_count=$((plugin_count + 1))
done < <(find "$plugins" -mindepth 1 -maxdepth 1 -print0 | LC_ALL=C sort -z)
[[ $plugin_count -eq ${#allowed_plugins[@]} ]] || die "curated GStreamer plugin count mismatch"
for forbidden in libgstlibav.so libgstx264.so libgstx265.so; do
  [[ ! -e $plugins/$forbidden && ! -L $plugins/$forbidden ]] || {
    die "forbidden GStreamer codec was packaged: $forbidden"
  }
done

helpers="$appdir/usr/lib/gstreamer1.0/gstreamer-1.0"
declare -A allowed_helpers=(
  [gst-plugin-scanner]=1
  [gst-ptp-helper]=1
)
helper_count=0
while IFS= read -r -d '' path; do
  [[ -f $path && ! -L $path ]] || die "unexpected non-regular GStreamer helper entry"
  helper_name=${path##*/}
  [[ -v allowed_helpers[$helper_name] ]] || die "uncurated GStreamer helper was packaged: $helper_name"
  add_payload "$path" gstreamer-helper
  helper_count=$((helper_count + 1))
done < <(find "$helpers" -mindepth 1 -maxdepth 1 -print0 | LC_ALL=C sort -z)
[[ $helper_count -eq ${#allowed_helpers[@]} ]] || die "curated GStreamer helper count mismatch"

is_elf() {
  file -Lb -- "$1" | grep -q '^ELF '
}

while IFS= read -r -d '' link; do
  rel=${link#"$appdir/"}
  link_text=$(readlink -- "$link")
  [[ $link_text != *$'\n'* && $link_text != *$'\r'* && $link_text != *$'\t'* ]] || {
    die "unsafe AppImage symlink text: $rel"
  }
  resolved=$(realpath --canonicalize-existing -- "$link" 2>/dev/null) || {
    die "broken AppImage symlink: $rel"
  }
  [[ $resolved == "$appdir/"* && -f $resolved ]] || {
    die "AppImage symlink escapes or does not resolve to a file: $rel"
  }
  resolved_rel=${resolved#"$appdir/"}
  resolved_sha=$(sha256sum -- "$resolved")
  resolved_sha=${resolved_sha%% *}
  printf '%s\t%s\t%s\t%s\n' "$rel" "$link_text" "$resolved_rel" "$resolved_sha" \
    >>"$symlink_inventory"
  is_elf "$resolved" && add_payload "$resolved" symlink-target
done < <(find "$appdir" -type l -print0 | sort -z)

elf_build_id() {
  local path=$1
  readelf -n -- "$path" 2>/dev/null \
    | sed -n 's/^[[:space:]]*Build ID: \([0-9A-Fa-f][0-9A-Fa-f]*\)$/\1/p' \
    | tr '[:upper:]' '[:lower:]' \
    | head -n 1
}

# Enumerate every post-extraction ELF, including libraries linuxdeploy found
# through GTK/WebKit/StudyVis rather than through a GStreamer seed. Symlinks
# are represented by the regular target bytes linuxdeploy emitted; no ELF can
# remain outside this classification queue.
elf_count=0
while IFS= read -r -d '' path; do
  if is_elf "$path"; then
    add_payload "$path" appimage-elf
    elf_count=$((elf_count + 1))
  fi
done < <(find "$appdir" -type f -print0 | sort -z)
[[ $elf_count -gt 0 ]] || die "AppImage contains no ELF payload"

declare -A package_rows=()
declare -A source_rows=()

dpkg_metadata() {
  local package=$1
  local metadata
  metadata=$(dpkg-query -W \
    -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' \
    "$package" 2>/dev/null) || return 1
  local binary_package binary_version source_package source_version extra
  IFS=$'\t' read -r binary_package binary_version source_package source_version extra <<<"$metadata"
  [[ -n $binary_package && -n $binary_version && -z ${extra:-} ]] || return 1
  [[ -n $source_package ]] || source_package=${binary_package%%:*}
  [[ -n $source_version ]] || source_version=$binary_version
  for field in "$binary_package" "$binary_version" "$source_package" "$source_version"; do
    [[ $field != *$'\n'* && $field != *$'\r'* && $field != *$'\t'* ]] || return 1
  done
  printf '%s\t%s\t%s\t%s\n' \
    "$binary_package" "$binary_version" "$source_package" "$source_version"
}

find_package_match() {
  local payload=$1
  local payload_sha=$2
  local payload_build_id=$3
  local basename=${payload##*/}
  local search_output
  search_output=$(dpkg-query --search "*/$basename" 2>/dev/null || true)
  [[ -n $search_output ]] || return 1

  local -A matched_packages=()
  local -A matched_paths=()
  local -A matched_kinds=()
  local line owner_field installed_path owner resolved owner_sha owner_build_id kind
  while IFS= read -r line; do
    [[ $line == *": /"* ]] || continue
    owner_field=${line%%: /*}
    installed_path=/${line#*: /}
    [[ -f $installed_path ]] || continue
    resolved=$(realpath --canonicalize-existing -- "$installed_path" 2>/dev/null) || continue
    [[ -f $resolved ]] || continue
    owner=${owner_field%%,*}
    owner=${owner##* }
    [[ -n $owner ]] || continue

    owner_sha=$(sha256sum -- "$resolved")
    owner_sha=${owner_sha%% *}
    kind=
    if [[ $owner_sha == "$payload_sha" ]]; then
      kind=sha256
    elif [[ -n $payload_build_id ]] && is_elf "$resolved"; then
      owner_build_id=$(elf_build_id "$resolved")
      [[ -n $owner_build_id && $owner_build_id == "$payload_build_id" ]] && kind=gnu-build-id
    fi
    [[ -n $kind ]] || continue
    matched_packages[$owner]=1
    matched_paths[$owner]=$installed_path
    matched_kinds[$owner]=$kind
  done <<<"$search_output"

  [[ ${#matched_packages[@]} -eq 1 ]] || {
    if [[ ${#matched_packages[@]} -gt 1 ]]; then
      echo "ambiguous installed owners for ${payload#"$appdir/"}: ${!matched_packages[*]}" >&2
    fi
    return 1
  }
  for owner in "${!matched_packages[@]}"; do
    printf '%s\t%s\t%s\n' "$owner" "${matched_paths[$owner]}" "${matched_kinds[$owner]}"
  done
}

find_copyright() {
  local package=$1
  local base=${package%%:*}
  local candidate resolved
  while IFS= read -r candidate; do
    [[ $candidate == /usr/share/doc/*/copyright && -f $candidate ]] || continue
    resolved=$(realpath --canonicalize-existing -- "$candidate" 2>/dev/null) || continue
    [[ $resolved == /usr/share/doc/*/copyright && -s $resolved ]] || continue
    printf '%s\n' "$resolved"
    return 0
  done < <(dpkg-query -L "$package" 2>/dev/null || true)
  candidate="/usr/share/doc/$base/copyright"
  if [[ -f $candidate ]]; then
    resolved=$(realpath --canonicalize-existing -- "$candidate")
    [[ $resolved == /usr/share/doc/*/copyright && -s $resolved ]] || return 1
    printf '%s\n' "$resolved"
    return 0
  fi
  return 1
}

classify_non_ubuntu() {
  local rel=$1
  local sha=$2
  case $rel in
    usr/bin/studyvis)
      printf 'project-built\ttagged StudyVis source and Cargo/npm locks\n'
      ;;
    usr/bin/llama-server|usr/lib/StudyVis/binaries/llama-runtime-x86_64-unknown-linux-gnu/*|usr/lib/libggml*.so*|usr/lib/libllama*.so*|usr/lib/libmtmd*.so*)
      printf 'pinned-llama\tllama.cpp %s / commit %s; exact source + MIT notice in this bundle\n' \
        "$STUDYVIS_LLAMA_TAG" "$STUDYVIS_LLAMA_COMMIT"
      ;;
    usr/lib/libwebkit2gtk-4.1.so.0|usr/lib/libjavascriptcoregtk-4.1.so.0|usr/lib/librice-proto.so.0|usr/lib/librice-io.so.0|usr/bin/studyvis-webkit-runtime/*|usr/lib/webkit2gtk-4.1/*|usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/*)
      printf 'pinned-webkit\tcompanion linux-webkit-sources archive\n'
      ;;
    AppRun.wrapped)
      [[ $sha == "$STUDYVIS_APPRUN_SHA256" ]] || {
        die "AppRun.wrapped does not match pinned tool byte: $sha"
      }
      [[ $(elf_build_id "$appdir/$rel") == "$STUDYVIS_APPRUN_BUILD_ID" ]] || {
        die "AppRun.wrapped has the wrong GNU build-id"
      }
      printf 'pinned-apprun\tAppImageKit %s source + APPIMAGEKIT-MIT.txt + exact tool byte\n' \
        "$STUDYVIS_APPRUN_SOURCE_COMMIT"
      ;;
    *)
      return 1
      ;;
  esac
}

# `--appimage-extract` begins after the type-2 runtime, so account for that ELF
# prefix explicitly. appimagetool may write update/digest fields into the
# pinned input runtime; its final bytes therefore get their own artifact hash.
runtime_offset=$($appimage --appimage-offset 2>/dev/null) || {
  die "could not read AppImage SquashFS offset"
}
[[ $runtime_offset =~ ^[0-9]+$ ]] || die "invalid AppImage runtime prefix size: $runtime_offset"
[[ -n ${XDG_CACHE_HOME:-} && -n ${LDAI_RUNTIME_FILE:-} ]] || {
  die "XDG_CACHE_HOME and LDAI_RUNTIME_FILE must identify the verified source-built runtime"
}
runtime_build_dir=$(normalize_existing appimage-runtime-build \
  "$XDG_CACHE_HOME/studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}")
expected_runtime=$(normalize_existing appimage-runtime "$LDAI_RUNTIME_FILE")
[[ $expected_runtime == "$runtime_build_dir/runtime-x86_64" ]] || {
  die "LDAI_RUNTIME_FILE is outside the revisioned StudyVis runtime build"
}
runtime_prefix="$work_root/AppImage-runtime-prefix.bin"
head -c "$runtime_offset" -- "$appimage" >"$runtime_prefix"
[[ $(wc -c <"$runtime_prefix") -eq $runtime_offset ]] || die "short AppImage runtime prefix read"
is_elf "$runtime_prefix" || die "AppImage runtime prefix is not ELF"
bash "$script_dir/verify-linux-appimage-runtime.sh" "$runtime_build_dir" "$runtime_prefix"
runtime_prefix_sha=$(sha256sum -- "$runtime_prefix")
runtime_prefix_sha=${runtime_prefix_sha%% *}
runtime_prefix_build_id=$(elf_build_id "$runtime_prefix")
printf '@appimage-runtime-prefix\t%s\t%s\tpinned-appimage-runtime\t%s\n' \
  "$runtime_prefix_sha" "${runtime_prefix_build_id:--}" \
  "StudyVis runtime r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}; type2 ${STUDYVIS_APPIMAGE_RUNTIME_COMMIT}; complete source-built static closure" \
  >>"$classified_inventory"

# Do not let the Noble runner make an incomplete AppImage appear closed by
# resolving arbitrary host libraries. This covers every ELF found above plus
# the pre-SquashFS runtime and records each bundled/external resolution.
bash "$script_dir/audit-linux-appimage-elf-closure.sh" \
  "$appdir" "$runtime_prefix" "$dynamic_inventory"

mapfile -t ordered_payload < <(printf '%s\n' "${!queued[@]}" | LC_ALL=C sort)
for rel in "${ordered_payload[@]}"; do
  path="$appdir/$rel"
  payload_sha=$(sha256sum -- "$path")
  payload_sha=${payload_sha%% *}
  build_id=
  is_elf "$path" && build_id=$(elf_build_id "$path")
  if classification=$(classify_non_ubuntu "$rel" "$payload_sha"); then
    IFS=$'\t' read -r class evidence <<<"$classification"
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$rel" "$payload_sha" "${build_id:--}" "$class" "$evidence" \
      >>"$classified_inventory"
    continue
  fi
  match=$(find_package_match "$path" "$payload_sha" "$build_id") || {
    die "could not map packaged ${payload_class[$rel]} '$rel' to exactly one installed Ubuntu package"
  }
  IFS=$'\t' read -r owner installed_path match_kind <<<"$match"
  metadata=$(dpkg_metadata "$owner") || die "could not read package metadata for $owner"
  IFS=$'\t' read -r binary_package binary_version source_package source_version <<<"$metadata"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$rel" "$payload_sha" "${build_id:--}" "$binary_package" "$binary_version" \
    "$source_package" "$source_version" "$installed_path" "$match_kind" \
    >>"$payload_inventory"
  package_rows[$binary_package]="$metadata"
  source_key="$source_package"$'\t'"$source_version"
  source_rows[$source_key]=1
done

queue_runtime_toolchain_package() {
  local package=$1 expected_version=$2 expected_source=$3 expected_source_version=$4
  local metadata binary_package binary_version source_package source_version
  metadata=$(dpkg_metadata "$package") || die "missing runtime toolchain package: $package"
  IFS=$'\t' read -r binary_package binary_version source_package source_version <<<"$metadata"
  [[ ${binary_package%%:*} == "$package" && $binary_version == "$expected_version" && \
     $source_package == "$expected_source" && $source_version == "$expected_source_version" ]] || {
    die "runtime toolchain package drift: $package"
  }
  package_rows[$binary_package]="$metadata"
  source_rows["$source_package"$'\t'"$source_version"]=1
}
queue_runtime_toolchain_package "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_VERSION" "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_SOURCE_VERSION"
queue_runtime_toolchain_package "$STUDYVIS_APPIMAGE_RUNTIME_GCC_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_VERSION" "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE_VERSION"
queue_runtime_toolchain_package "$STUDYVIS_APPIMAGE_RUNTIME_LIBGCC_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_LIBGCC_VERSION" "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE_VERSION"
queue_runtime_toolchain_package "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_VERSION" "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_SOURCE_VERSION"

mapfile -t ordered_packages < <(printf '%s\n' "${!package_rows[@]}" | LC_ALL=C sort)
for binary_package in "${ordered_packages[@]}"; do
  metadata=${package_rows[$binary_package]}
  IFS=$'\t' read -r _ binary_version source_package source_version <<<"$metadata"
  copyright=$(find_copyright "$binary_package") || {
    die "installed package has no resolvable non-empty copyright file: $binary_package"
  }
  safe_package=${binary_package//:/_}
  destination="copyright/${safe_package}.copyright"
  install -m 0644 -- "$copyright" "$payload_dir/$destination"
  copyright_sha=$(sha256sum -- "$payload_dir/$destination")
  copyright_sha=${copyright_sha%% *}
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$binary_package" "$binary_version" "$source_package" "$source_version" \
    "$destination" "$copyright_sha" >>"$package_inventory"
done

# Preserve the repository-side transformation inputs and the generated hook
# whose variables select packaged-only GStreamer paths.  These files are not
# substitutes for Ubuntu source packages; they explain how those sources were
# turned into the audited AppImage bytes.
for build_input in \
  scripts/stage-linux-appimage-webkit.sh \
  scripts/check-linux-appimage.sh \
  scripts/check-third-party-notices-bundle.ts \
  scripts/generate-third-party-notices.ts \
  scripts/generate-librice-third-party-notices.mjs \
  scripts/audit-linux-appimage-elf-closure.sh \
  scripts/build-linux-system-sources.sh \
  scripts/build-linux-appimage-runtime.sh \
  scripts/prepare-linuxdeploy-tools.sh \
  scripts/verify-linux-appimage-runtime.sh \
  scripts/linuxdeploy-tools.env \
  scripts/linux-appimage-runtime.env \
  scripts/linux-appimage-runtime-sources.tsv \
  scripts/linux-appimage-legal.env \
  scripts/linux-webkit-runtime.env \
  scripts/linux-appimage-external-sonames.txt \
  scripts/linux-gstreamer-plugins.txt \
  scripts/licenses/APPIMAGEKIT-MIT.txt \
  scripts/licenses/LLAMA.CPP-MIT.txt \
  scripts/licenses/TAURI-BINARY-RELEASES-MIT.txt \
  src-tauri/vendor/wry/LICENSE-MIT \
  src-tauri/vendor/wry/LICENSE-APACHE \
  src-tauri/resources/THIRD-PARTY-NOTICES.txt \
  src-tauri/resources/THIRD-PARTY-NOTICES.json \
  src-tauri/tauri.linux.conf.json; do
  [[ -f $repo_root/$build_input && ! -L $repo_root/$build_input ]] || {
    die "missing repository build input: $build_input"
  }
  destination_name=${build_input//\//__}
  install -m 0644 -- "$repo_root/$build_input" "$build_input_dir/$destination_name"
done
webkit_license_dir="$appdir/usr/share/licenses/studyvis-webkit-runtime"
node "$script_dir/generate-librice-third-party-notices.mjs" --check \
  "$webkit_license_dir" --expected-lock-sha "$STUDYVIS_LIBRICE_CARGO_LOCK_SHA256"
for notice_name in LIBRICE-THIRD-PARTY-NOTICES.txt LIBRICE-THIRD-PARTY-NOTICES.json; do
  packaged_notice="$webkit_license_dir/$notice_name"
  [[ -s $packaged_notice && ! -L $packaged_notice ]] || {
    die "packaged librice notice input is missing: $notice_name"
  }
  install -m 0644 -- "$packaged_notice" "$build_input_dir/packaged__$notice_name"
done
read -r packaged_librice_notice_sha _ < <(
  sha256sum "$webkit_license_dir/LIBRICE-THIRD-PARTY-NOTICES.txt"
)
[[ $packaged_librice_notice_sha == "$STUDYVIS_LIBRICE_NOTICE_SHA256" ]] || {
  die "packaged librice notice has the wrong SHA256: $packaged_librice_notice_sha"
}
read -r packaged_librice_manifest_sha _ < <(
  sha256sum "$webkit_license_dir/LIBRICE-THIRD-PARTY-NOTICES.json"
)
[[ $packaged_librice_manifest_sha == "$STUDYVIS_LIBRICE_NOTICE_MANIFEST_SHA256" ]] || {
  die "packaged librice notice manifest has the wrong SHA256: $packaged_librice_manifest_sha"
}
gstreamer_hook="$appdir/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
[[ -s $gstreamer_hook && ! -L $gstreamer_hook ]] || {
  die "packaged linuxdeploy GStreamer AppRun hook is missing"
}
install -m 0644 -- "$gstreamer_hook" "$build_input_dir/linuxdeploy-plugin-gstreamer.AppRun-hook.sh"
gtk_hook="$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
[[ -s $gtk_hook && ! -L $gtk_hook ]] || die "packaged linuxdeploy GTK AppRun hook is missing"
install -m 0644 -- "$gtk_hook" "$build_input_dir/linuxdeploy-plugin-gtk.AppRun-hook.sh"
generated_apprun="$appdir/AppRun"
[[ -s $generated_apprun && ! -L $generated_apprun ]] || die "generated top-level AppRun is missing"
install -m 0644 -- "$generated_apprun" "$build_input_dir/AppRun.generated.sh"

[[ -n ${XDG_CACHE_HOME:-} ]] || die "XDG_CACHE_HOME must name the isolated verified Tauri cache"
tool_cache=$(normalize_existing tauri-tool-cache "$XDG_CACHE_HOME/tauri")
tool_marker="$tool_cache/.studyvis-linuxdeploy-toolset"
[[ -f $tool_marker && ! -L $tool_marker ]] || die "verified Tauri tool cache marker is missing"
[[ $(<"$tool_marker") == "studyvis-linuxdeploy-toolset-r${STUDYVIS_LINUXDEPLOY_TOOLSET_REVISION}" ]] || {
  die "verified Tauri tool cache marker has the wrong revision"
}

# Carry the exact source, licenses, link map/input hashes and toolchain record
# that produced the prefix, but do not duplicate either built runtime ELF.
runtime_evidence_dir="$source_dir/studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}"
install -d "$runtime_evidence_dir/sources" "$runtime_evidence_dir/licenses"
for evidence in \
  RUNTIME-BUILD-METADATA.tsv SOURCE-INVENTORY.tsv LICENSE-INVENTORY.tsv \
  TOOLCHAIN-INVENTORY.tsv runtime-x86_64.link-inputs.tsv runtime-x86_64.link-map \
  build-linux-appimage-runtime.sh linux-appimage-runtime.env \
  linux-appimage-runtime-sources.tsv; do
  install -m 0644 -- "$runtime_build_dir/$evidence" "$runtime_evidence_dir/$evidence"
done
while IFS= read -r -d '' evidence; do
  install -m 0644 -- "$evidence" "$runtime_evidence_dir/sources/${evidence##*/}"
done < <(find "$runtime_build_dir/sources" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)
while IFS= read -r -d '' evidence; do
  install -m 0644 -- "$evidence" "$runtime_evidence_dir/licenses/${evidence##*/}"
done < <(find "$runtime_build_dir/licenses" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)

record_tool_input() {
  local filename=$1
  local input_url=$2
  local expected_sha=$3
  local source_component=$4
  local source_revision=$5
  local source_url=$6
  local source_sha=$7
  local source_path="$tool_cache/$filename"
  [[ -f $source_path && ! -L $source_path ]] || die "verified packaging tool is missing: $filename"
  local actual_sha
  actual_sha=$(sha256sum -- "$source_path")
  actual_sha=${actual_sha%% *}
  [[ $actual_sha == "$expected_sha" ]] || {
    die "cached packaging tool changed after verification: $filename ($actual_sha)"
  }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$filename" "$input_url" "$actual_sha" "$source_component" \
    "$source_revision" "$source_url" "$source_sha" >>"$tool_inventory"
}
record_tool_input AppRun-x86_64 \
  "$STUDYVIS_APPRUN_URL" "$STUDYVIS_APPRUN_SHA256" \
  AppImageKit "$STUDYVIS_APPRUN_SOURCE_COMMIT" \
  "$STUDYVIS_APPRUN_SOURCE_URL" "$STUDYVIS_APPRUN_SOURCE_SHA256"
record_tool_input linuxdeploy-x86_64.AppImage \
  "$STUDYVIS_LINUXDEPLOY_URL" "$STUDYVIS_LINUXDEPLOY_SHA256" \
  linuxdeploy "$STUDYVIS_LINUXDEPLOY_COMMIT" \
  "$STUDYVIS_LINUXDEPLOY_SOURCE_URL" "$STUDYVIS_LINUXDEPLOY_SOURCE_SHA256"
record_tool_input linuxdeploy-plugin-appimage.AppImage \
  "$STUDYVIS_APPIMAGE_PLUGIN_URL" "$STUDYVIS_APPIMAGE_PLUGIN_SHA256" \
  linuxdeploy-plugin-appimage "$STUDYVIS_APPIMAGE_PLUGIN_COMMIT" \
  "$STUDYVIS_APPIMAGE_PLUGIN_SOURCE_URL" "$STUDYVIS_APPIMAGE_PLUGIN_SOURCE_SHA256"
# The pinned plugin AppImage embeds appimagetool; keep that second exact source
# mapping explicit without duplicating the opaque executable in this archive.
record_tool_input linuxdeploy-plugin-appimage.AppImage \
  "$STUDYVIS_APPIMAGE_PLUGIN_URL" "$STUDYVIS_APPIMAGE_PLUGIN_SHA256" \
  appimagetool "$STUDYVIS_APPIMAGETOOL_COMMIT" \
  "$STUDYVIS_APPIMAGETOOL_SOURCE_URL" "$STUDYVIS_APPIMAGETOOL_SOURCE_SHA256"
runtime_input_sha=$(sha256sum -- "$expected_runtime")
runtime_input_sha=${runtime_input_sha%% *}
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}/runtime-x86_64" \
  project-source-build "$runtime_input_sha" StudyVis-type2-runtime \
  "$STUDYVIS_APPIMAGE_RUNTIME_COMMIT" scripts/linux-appimage-runtime-sources.tsv \
  "$(sha256sum "$script_dir/linux-appimage-runtime-sources.tsv" | awk '{print $1}')" \
  >>"$tool_inventory"
record_tool_input linuxdeploy-plugin-gstreamer.sh \
  "$STUDYVIS_GSTREAMER_PLUGIN_URL" "$STUDYVIS_GSTREAMER_PLUGIN_SHA256" \
  linuxdeploy-plugin-gstreamer "$STUDYVIS_GSTREAMER_PLUGIN_COMMIT" \
  "$STUDYVIS_GSTREAMER_PLUGIN_SOURCE_URL" "$STUDYVIS_GSTREAMER_PLUGIN_SOURCE_SHA256"
record_tool_input linuxdeploy-plugin-gtk.sh \
  "$STUDYVIS_GTK_PLUGIN_URL" "$STUDYVIS_GTK_PLUGIN_SHA256" \
  linuxdeploy-plugin-gtk "$STUDYVIS_GTK_PLUGIN_COMMIT" \
  "$STUDYVIS_GTK_PLUGIN_SOURCE_URL" "$STUDYVIS_GTK_PLUGIN_SOURCE_SHA256"

appimage_sha=$(sha256sum -- "$appimage")
appimage_sha=${appimage_sha%% *}
cat >"$payload_dir/README.txt" <<EOF
StudyVis Ubuntu-derived AppImage source and notice bundle

AppImage SHA256: $appimage_sha
Packaging base: Ubuntu 24.04 amd64
Inventory format: 2

Every regular ELF below the AppImage's SquashFS root is classified. Ubuntu
package bytes appear in PAYLOAD-INVENTORY.tsv, including every curated
GStreamer plugin/helper, bwrap, xdg-dbus-proxy and all GTK/native dependencies.
Each row records the packaged hash and maps it to exactly one installed Ubuntu
binary package using either identical SHA256 or the unchanged GNU build-id
(linuxdeploy rewrites RPATHs). NON-UBUNTU-PAYLOAD.tsv hashes the StudyVis,
WebKit, llama, AppRun and pre-SquashFS type-2 runtime bytes and names the pinned
source/provenance status for each. No AppImage ELF is left unclassified.
DYNAMIC-LINK-INVENTORY.tsv proves that every DT_NEEDED/PT_INTERP name for those
ELFs resolves to a hashed ELF inside the AppImage or the reviewed external base
ABI in linux-appimage-external-sonames.txt; no other host borrowing is allowed.

PACKAGE-INVENTORY.tsv records the exact binary-to-source version mapping and
the packaged Debian copyright file. SOURCE-INVENTORY.tsv hashes every file
downloaded from the matching signed apt source index. The sources directory
contains every .dsc/source component plus immutable llama/AppRun/linuxdeploy/
plugin snapshots and the complete StudyVis type2 sources, licenses and link evidence.
PACKAGING-TOOL-INVENTORY.tsv records verified input URLs/hashes and their pinned
source tuples without redistributing the opaque build-tool executables.
Build-inputs records StudyVis staging/config inputs, notices, and generated
top-level/GTK/GStreamer AppRun hooks. The tagged
StudyVis repository supplies the remaining application and Cargo/npm sources.

The pre-SquashFS runtime is built on Noble from immutable type2, musl, zlib,
decompression-only zstd, libfuse and squashfuse sources. Exact compiler/CRT
inputs and source-package versions are inventoried, and the artifact prefix is
compared after normalising only appimagetool-reserved fields.

This mechanical bundle is part of the release gate and is not legal advice.
An unmapped byte, missing copyright notice, unavailable exact source version,
or failed source checksum stops release creation.
EOF

if [[ $mode == bundle ]]; then
  [[ $STUDYVIS_APPIMAGE_RUNTIME_SOURCE_CLOSURE_STATUS == complete ]] || {
    die "publication blocked: pinned AppImage runtime static source closure is ${STUDYVIS_APPIMAGE_RUNTIME_SOURCE_CLOSURE_STATUS}; build a fully pinned replacement runtime"
  }
  tool_source_dir="$source_dir/linuxdeploy-tools"
  mkdir -p "$tool_source_dir"
  download_tool_source() {
    local name=$1
    local url=$2
    local expected_sha=$3
    local source_label=${4:-linuxdeploy-toolset}
    local source_version=${5:-r$STUDYVIS_LINUXDEPLOY_TOOLSET_REVISION}
    local destination="$tool_source_dir/$name"
    [[ $url == https://* && $expected_sha =~ ^[0-9a-f]{64}$ ]] || {
      die "invalid pinned source tuple for $name"
    }
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      --output "$destination" -- "$url"
    local actual_sha
    actual_sha=$(sha256sum -- "$destination")
    actual_sha=${actual_sha%% *}
    [[ $actual_sha == "$expected_sha" ]] || {
      die "packaging-tool source SHA256 mismatch for $name: $actual_sha"
    }
    printf '%s\t%s\t%s\t%s\n' \
      "$source_label" "$source_version" \
      "${destination#"$payload_dir/"}" "$actual_sha" >>"$source_inventory"
  }
  download_tool_source "linuxdeploy-${STUDYVIS_LINUXDEPLOY_COMMIT}.tar.gz" \
    "$STUDYVIS_LINUXDEPLOY_SOURCE_URL" "$STUDYVIS_LINUXDEPLOY_SOURCE_SHA256" \
    linuxdeploy "$STUDYVIS_LINUXDEPLOY_COMMIT"
  download_tool_source "linuxdeploy-plugin-appimage-${STUDYVIS_APPIMAGE_PLUGIN_COMMIT}.tar.gz" \
    "$STUDYVIS_APPIMAGE_PLUGIN_SOURCE_URL" "$STUDYVIS_APPIMAGE_PLUGIN_SOURCE_SHA256" \
    linuxdeploy-plugin-appimage "$STUDYVIS_APPIMAGE_PLUGIN_COMMIT"
  download_tool_source "appimagetool-${STUDYVIS_APPIMAGETOOL_COMMIT}.tar.gz" \
    "$STUDYVIS_APPIMAGETOOL_SOURCE_URL" "$STUDYVIS_APPIMAGETOOL_SOURCE_SHA256" \
    appimagetool "$STUDYVIS_APPIMAGETOOL_COMMIT"
  apprun_source_name="AppImageKit-${STUDYVIS_APPRUN_SOURCE_COMMIT}.tar.gz"
  download_tool_source "$apprun_source_name" \
    "$STUDYVIS_APPRUN_SOURCE_URL" "$STUDYVIS_APPRUN_SOURCE_SHA256" \
    AppRun "$STUDYVIS_APPRUN_SOURCE_COMMIT"
  mapfile -t apprun_source_paths < <(
    tar -tzf "$tool_source_dir/$apprun_source_name" \
      | grep -E '^[^/]+/src/AppRun\.c$'
  )
  [[ ${#apprun_source_paths[@]} -eq 1 ]] || die "AppRun source archive has no unique src/AppRun.c"
  apprun_source_sha=$(
    tar -xOf "$tool_source_dir/$apprun_source_name" "${apprun_source_paths[0]}" \
      | sha256sum
  )
  apprun_source_sha=${apprun_source_sha%% *}
  [[ $apprun_source_sha == "$STUDYVIS_APPRUN_SOURCE_FILE_SHA256" ]] || {
    die "AppRun source file hash does not match the pinned binary's source revision"
  }
  download_tool_source "llama.cpp-${STUDYVIS_LLAMA_COMMIT}.tar.gz" \
    "$STUDYVIS_LLAMA_SOURCE_URL" "$STUDYVIS_LLAMA_SOURCE_SHA256" \
    llama.cpp "$STUDYVIS_LLAMA_COMMIT"
  download_tool_source "linuxdeploy-plugin-gstreamer-${STUDYVIS_GSTREAMER_PLUGIN_COMMIT}.tar.gz" \
    "$STUDYVIS_GSTREAMER_PLUGIN_SOURCE_URL" "$STUDYVIS_GSTREAMER_PLUGIN_SOURCE_SHA256" \
    linuxdeploy-plugin-gstreamer "$STUDYVIS_GSTREAMER_PLUGIN_COMMIT"
  download_tool_source "linuxdeploy-plugin-gtk-${STUDYVIS_GTK_PLUGIN_COMMIT}.tar.gz" \
    "$STUDYVIS_GTK_PLUGIN_SOURCE_URL" "$STUDYVIS_GTK_PLUGIN_SOURCE_SHA256" \
    linuxdeploy-plugin-gtk "$STUDYVIS_GTK_PLUGIN_COMMIT"

  # `apt-get source` must resolve exact versions from authenticated source
  # indexes. Merely having binary indexes is not enough and must fail closed.
  # `$(IDENTIFIER)` is apt's format token, not shell command substitution.
  # shellcheck disable=SC2016
  if ! apt-get indextargets --format '$(IDENTIFIER)' 2>/dev/null \
    | grep -Fxq 'Sources'; then
    die "no apt Sources indexes are enabled; add matching Noble deb-src entries and run apt-get update"
  fi

  mapfile -t ordered_sources < <(printf '%s\n' "${!source_rows[@]}" | LC_ALL=C sort)
  for source_key in "${ordered_sources[@]}"; do
    IFS=$'\t' read -r source_package source_version <<<"$source_key"
    safe_source=${source_package//\//_}
    safe_version=${source_version//\//_}
    download_dir="$source_dir/${safe_source}_${safe_version}"
    mkdir -p "$download_dir"
    (
      cd "$download_dir"
      apt-get source --download-only --only-source "$source_package=$source_version" >/dev/null
    ) || die "could not download exact Ubuntu source $source_package=$source_version"

    mapfile -t dsc_files < <(find "$download_dir" -mindepth 1 -maxdepth 1 -type f -name '*.dsc' -print | LC_ALL=C sort)
    [[ ${#dsc_files[@]} -eq 1 ]] || {
      die "source download did not produce exactly one .dsc for $source_package=$source_version"
    }
    dsc=${dsc_files[0]}
    declared_source=$(sed -n 's/^Source: //p' "$dsc" | head -n 1)
    declared_version=$(sed -n 's/^Version: //p' "$dsc" | head -n 1)
    [[ $declared_source == "$source_package" && $declared_version == "$source_version" ]] || {
      die "downloaded .dsc does not match $source_package=$source_version"
    }

    checksum_rows=$(awk '
      /^Checksums-Sha256:/ { in_checksums = 1; next }
      in_checksums && /^ / { print $1 "\t" $3; next }
      in_checksums { exit }
    ' "$dsc")
    [[ -n $checksum_rows ]] || die "downloaded .dsc has no Checksums-Sha256: $dsc"
    while IFS=$'\t' read -r expected_sha filename; do
      [[ $filename != */* && -f $download_dir/$filename && ! -L $download_dir/$filename ]] || {
        die "unsafe or missing .dsc source component: $filename"
      }
      actual_sha=$(sha256sum -- "$download_dir/$filename")
      actual_sha=${actual_sha%% *}
      [[ $actual_sha == "$expected_sha" ]] || {
        die "source component checksum mismatch: $filename"
      }
    done <<<"$checksum_rows"

    while IFS= read -r source_file; do
      rel_source=${source_file#"$payload_dir/"}
      source_sha=$(sha256sum -- "$source_file")
      source_sha=${source_sha%% *}
      printf '%s\t%s\t%s\t%s\n' \
        "$source_package" "$source_version" "$rel_source" "$source_sha" \
        >>"$source_inventory"
    done < <(find "$download_dir" -mindepth 1 -maxdepth 1 -type f -print | LC_ALL=C sort)
  done
else
  printf 'Source downloads intentionally omitted by --inventory-only.\n' \
    >"$source_dir/INVENTORY-ONLY.txt"
fi

# Self-hash every inventory, source component, input and notice independently
# of tar metadata. SOURCE-INVENTORY also carries the semantic package mapping.
(
  cd "$payload_dir"
  find README.txt PAYLOAD-INVENTORY.tsv NON-UBUNTU-PAYLOAD.tsv SYMLINK-INVENTORY.tsv DYNAMIC-LINK-INVENTORY.tsv PACKAGING-TOOL-INVENTORY.tsv PACKAGE-INVENTORY.tsv \
    SOURCE-INVENTORY.tsv copyright sources build-inputs -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum >MANIFEST.sha256
  sha256sum --check --strict MANIFEST.sha256 >/dev/null
)

if [[ $mode == inventory ]]; then
  [[ $inventory_output == /* ]] || die "inventory output must be an absolute path"
  [[ ! -e $inventory_output && ! -L $inventory_output ]] || {
    die "inventory output already exists: $inventory_output"
  }
  inventory_output=$(normalize_missing inventory-output "$inventory_output")
  parent=${inventory_output%/*}
  [[ -d $parent && -w $parent ]] || die "inventory output parent is not writable: $parent"
  mv -- "$payload_dir" "$inventory_output"
  echo "Audited exact Ubuntu-derived AppImage payload: $inventory_output"
  exit 0
fi

[[ $output == /* && $output == *.tar.gz ]] || {
  die "source bundle output must be an absolute .tar.gz path"
}
[[ ! -e $output && ! -L $output ]] || die "source bundle output already exists: $output"
output=$(normalize_missing source-bundle-output "$output")
parent=${output%/*}
[[ -d $parent && -w $parent ]] || die "source bundle parent is not writable: $parent"
temporary_output=$(mktemp "$parent/.studyvis-system-source.XXXXXX")
trap 'rm -rf -- "$work_root"; rm -f -- "$temporary_output"' EXIT
(
  cd "$bundle_root"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -cf - studyvis-linux-system-sources \
    | gzip -n -9 >"$temporary_output"
)
gzip -t "$temporary_output"
mv -- "$temporary_output" "$output"
trap cleanup EXIT
echo "Created deterministic Ubuntu system source/notice bundle: $output"
