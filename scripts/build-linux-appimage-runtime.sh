#!/usr/bin/env bash
# Build StudyVis's AppImage type-2 runtime from a complete, immutable source
# tuple.  This intentionally does not consume the mutable upstream continuous
# runtime or Alpine APK bytes.

set -euo pipefail
export LC_ALL=C
export TZ=UTC
umask 022

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: build-linux-appimage-runtime.sh --output <absolute-new-directory> [--source-cache <absolute-directory>]

The official build requires amd64 Ubuntu 22.04 with the exact Jammy
clang-14/gcc-11/libgcc-11-dev/binutils versions recorded in
linux-appimage-runtime.env.  A source cache may contain any of the exact
archive filenames; every cached or downloaded byte is SHA256-verified.
EOF
  exit 2
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"
source_manifest="$script_dir/linux-appimage-runtime-sources.tsv"

output=
source_cache=
while [[ $# -gt 0 ]]; do
  case $1 in
    --output)
      [[ $# -ge 2 && -z $output ]] || usage
      output=$2
      shift 2
      ;;
    --source-cache)
      [[ $# -ge 2 && -z $source_cache ]] || usage
      source_cache=$2
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
[[ -n $output ]] || usage

for command_name in \
  ar autoconf automake awk bash cat clang-14 cp curl dd dirname dpkg \
  dpkg-query file find gcc-11 getconf grep head install ld.bfd libtoolize \
  make mktemp mv ninja nm objcopy od patch pkg-config python3 ranlib \
  readelf realpath rm sed sha256sum sort strings strip tar touch tr uname \
  wc xz; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing runtime-build dependency: $command_name"
done

[[ $output == /* && $output != *$'\n'* && $output != *$'\r'* && $output != *$'\t'* ]] || {
  die "output must be absolute and contain no control whitespace"
}
output=$(realpath --canonicalize-missing -- "$output")
[[ $output != / && ${output%/*} != / ]] || die "refusing broad output path: $output"
[[ ! -e $output && ! -L $output ]] || die "output already exists: $output"
output_parent=${output%/*}
[[ -d $output_parent && -w $output_parent && ! -L $output_parent ]] || {
  die "output parent is missing, unwritable, or symlinked: $output_parent"
}
if [[ -n $source_cache ]]; then
  [[ $source_cache == /* && $source_cache != *$'\n'* && $source_cache != *$'\r'* && $source_cache != *$'\t'* ]] || {
    die "source cache must be absolute and contain no control whitespace"
  }
  source_cache=$(realpath --canonicalize-existing -- "$source_cache")
  [[ -d $source_cache && ! -L $source_cache ]] || die "source cache is not a regular directory"
fi

[[ $(uname -m) == x86_64 ]] || die "the official AppImage runtime build is x86_64-only"
[[ -r /etc/os-release ]] || die "cannot identify build operating system"
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 22.04 ]] || {
  die "official runtime builds require Ubuntu 22.04 (found ${ID:-unknown} ${VERSION_ID:-unknown})"
}
[[ $(dpkg --print-architecture) == amd64 ]] || die "official runtime builds require the amd64 package database"

verify_package() {
  local binary_package=$1
  local expected_version=$2
  local expected_source=$3
  local expected_source_version=$4
  local metadata
  metadata=$(dpkg-query -W -f='${Version}\t${source:Package}\t${source:Version}\n' "$binary_package" 2>/dev/null) || {
    die "required Jammy package is not installed: $binary_package"
  }
  local version source_name source_version
  IFS=$'\t' read -r version source_name source_version <<<"$metadata"
  [[ $version == "$expected_version" ]] || {
    die "$binary_package version drift: expected $expected_version, got $version"
  }
  [[ ${source_name:-$binary_package} == "$expected_source" ]] || {
    die "$binary_package source package drift: expected $expected_source, got ${source_name:-unknown}"
  }
  [[ ${source_version:-$version} == "$expected_source_version" ]] || {
    die "$binary_package source version drift: expected $expected_source_version, got ${source_version:-unknown}"
  }
}

verify_package \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_VERSION" \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_CLANG_SOURCE_VERSION"
verify_package \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_VERSION" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE_VERSION"
verify_package \
  "$STUDYVIS_APPIMAGE_RUNTIME_LIBGCC_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_LIBGCC_VERSION" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_GCC_SOURCE_VERSION"
verify_package \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_PACKAGE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_VERSION" \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_SOURCE" \
  "$STUDYVIS_APPIMAGE_RUNTIME_BINUTILS_SOURCE_VERSION"

scratch_parent=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
scratch_parent=$(realpath --canonicalize-existing -- "$scratch_parent")
[[ -d $scratch_parent && -w $scratch_parent && ! -L $scratch_parent ]] || {
  die "temporary directory is missing, unwritable, or symlinked: $scratch_parent"
}
work_root=$(mktemp -d "$scratch_parent/studyvis-appimage-runtime.XXXXXX")
cleanup() {
  rm -rf -- "$work_root"
}
trap cleanup EXIT

export SOURCE_DATE_EPOCH=$STUDYVIS_APPIMAGE_RUNTIME_SOURCE_DATE_EPOCH
export ZERO_AR_DATE=1
export ARFLAGS=rcD
export REALGCC=gcc-11

download_dir="$work_root/downloads"
source_root="$work_root/source"
build_root="$work_root/build"
prefix="$work_root/prefix"
result="$work_root/result"
mkdir -p "$download_dir" "$source_root" "$build_root" "$prefix" \
  "$result/sources" "$result/licenses"

source_inventory="$result/SOURCE-INVENTORY.tsv"
license_inventory="$result/LICENSE-INVENTORY.tsv"
printf 'component\tversion\tarchive\turl\tsha256\tlicense\n' >"$source_inventory"
printf 'component\tlicense\tpath\tsha256\n' >"$license_inventory"

declare -A source_versions=()
declare -A source_archives=()
declare -A source_licenses=()
declare -A source_license_ids=()
line_number=0
while IFS=$'\t' read -r component version archive url expected_sha license license_paths extra; do
  line_number=$((line_number + 1))
  if [[ $line_number -eq 1 ]]; then
    [[ $component == component && $version == version && $archive == archive && \
       $url == url && $expected_sha == sha256 && $license == license && \
       $license_paths == license_paths && -z ${extra:-} ]] || {
      die "invalid source-manifest header"
    }
    continue
  fi
  [[ -n $component && $component =~ ^[a-z0-9][a-z0-9-]*$ && \
     -n $version && $version != *$'\n'* && $version != *$'\r'* && $version != *$'\t'* && \
     $archive =~ ^[A-Za-z0-9._+-]+\.(tar\.gz|tar\.xz)$ && \
     $url == https://* && $expected_sha =~ ^[0-9a-f]{64}$ && \
     -n $license && -n $license_paths && -z ${extra:-} ]] || {
    die "invalid source tuple on manifest line $line_number"
  }
  [[ ! -v source_versions[$component] ]] || die "duplicate source component: $component"
  source_versions[$component]=$version
  source_archives[$component]=$archive
  source_licenses[$component]=$license_paths
  source_license_ids[$component]=$license

  archive_path="$download_dir/$archive"
  if [[ -n $source_cache && -f $source_cache/$archive && ! -L $source_cache/$archive ]]; then
    install -m 0644 -- "$source_cache/$archive" "$archive_path"
  else
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      --output "$archive_path" -- "$url"
  fi
  actual_sha=$(sha256sum -- "$archive_path")
  actual_sha=${actual_sha%% *}
  [[ $actual_sha == "$expected_sha" ]] || {
    die "$component source SHA256 mismatch: expected $expected_sha, got $actual_sha"
  }
  install -m 0644 -- "$archive_path" "$result/sources/$archive"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$component" "$version" "sources/$archive" "$url" "$expected_sha" "$license" \
    >>"$source_inventory"
done <"$source_manifest"

for required_component in type2-runtime musl zlib zstd libfuse squashfuse meson; do
  [[ -v source_versions[$required_component] ]] || die "source manifest omits $required_component"
done
[[ ${#source_versions[@]} -eq 7 ]] || die "source manifest has an unexpected component"

extract_component() {
  local component=$1
  local destination=$2
  local archive="$download_dir/${source_archives[$component]}"
  mkdir -p "$destination"
  case $archive in
    # Source ownership is not a build input. Avoid archive-owned UID/GID
    # restoration so this exact recipe also works in rootless user namespaces.
    *.tar.gz) tar --no-same-owner -xzf "$archive" --strip-components=1 -C "$destination" ;;
    *.tar.xz) tar --no-same-owner -xJf "$archive" --strip-components=1 -C "$destination" ;;
    *) die "unsupported source archive: $archive" ;;
  esac
}

type2_source="$source_root/type2-runtime"
musl_source="$source_root/musl"
zlib_source="$source_root/zlib"
zstd_source="$source_root/zstd"
fuse_source="$source_root/libfuse"
squashfuse_source="$source_root/squashfuse"
meson_source="$source_root/meson"
extract_component type2-runtime "$type2_source"
extract_component musl "$musl_source"
extract_component zlib "$zlib_source"
extract_component zstd "$zstd_source"
extract_component libfuse "$fuse_source"
extract_component squashfuse "$squashfuse_source"
extract_component meson "$meson_source"

for component in type2-runtime musl zlib zstd libfuse squashfuse meson; do
  case $component in
    type2-runtime) component_source=$type2_source ;;
    musl) component_source=$musl_source ;;
    zlib) component_source=$zlib_source ;;
    zstd) component_source=$zstd_source ;;
    libfuse) component_source=$fuse_source ;;
    squashfuse) component_source=$squashfuse_source ;;
    meson) component_source=$meson_source ;;
  esac
  IFS=';' read -r -a license_paths <<<"${source_licenses[$component]}"
  for license_path in "${license_paths[@]}"; do
    [[ $license_path != /* && $license_path != *..* && \
       -f $component_source/$license_path && ! -L $component_source/$license_path ]] || {
      die "$component license path is missing or unsafe: $license_path"
    }
    license_name="${component}-${license_path//\//_}"
    install -m 0644 -- "$component_source/$license_path" "$result/licenses/$license_name"
    license_sha=$(sha256sum -- "$result/licenses/$license_name")
    license_sha=${license_sha%% *}
    printf '%s\t%s\tlicenses/%s\t%s\n' \
      "$component" "${source_license_ids[$component]}" "$license_name" "$license_sha" \
      >>"$license_inventory"
  done
done

# Prevent source and debug paths from depending on the runner's temporary path.
mapped_root=/usr/src/studyvis-appimage-runtime
common_cflags="-Os -g -fPIC -ffunction-sections -fdata-sections -fno-ident -march=x86-64 -mtune=generic -ffile-prefix-map=$work_root=$mapped_root -fdebug-prefix-map=$work_root=$mapped_root"
jobs=${STUDYVIS_RUNTIME_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}
[[ $jobs =~ ^[1-9][0-9]*$ && $jobs -le 64 ]] || die "invalid STUDYVIS_RUNTIME_BUILD_JOBS: $jobs"

# musl supplies the complete libc/sysroot and the compiler wrapper used by all
# dependency builds.  REALGCC prevents the wrapper from silently selecting a
# different host GCC.
(
  cd "$musl_source"
  CC=gcc-11 CFLAGS="$common_cflags" \
    ./configure --prefix="$prefix" --disable-shared
  make -j "$jobs"
  make install
)
[[ -x $prefix/bin/musl-gcc && -f $prefix/lib/rcrt1.o && -f $prefix/lib/libc.a ]] || {
  die "musl did not install the required static-PIE sysroot"
}
grep -Fq 'gcc-11' "$musl_source/config.mak" || die "musl did not record gcc-11"
grep -Fq -- '-march=x86-64' "$musl_source/config.mak" || die "musl lost the baseline ISA flag"

export CC="$prefix/bin/musl-gcc"
export AR=ar
export RANLIB=ranlib
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR=

(
  cd "$zlib_source"
  CC="$CC" CFLAGS="$common_cflags" ./configure --static --prefix="$prefix"
  make -j "$jobs"
  make install
)

# Only zstd's decompressor/common code is built.  No compressor, dictionary
# builder, deprecated API, legacy frame decoder, or multithreaded library is
# permitted into the archive.
make -C "$zstd_source/lib" -j "$jobs" libzstd.a \
  CC="$CC" AR="$AR" CFLAGS="$common_cflags" \
  ZSTD_LIB_COMPRESSION=0 ZSTD_LIB_DECOMPRESSION=1 \
  ZSTD_LIB_DICTBUILDER=0 ZSTD_LIB_DEPRECATED=0 ZSTD_LEGACY_SUPPORT=0
make -C "$zstd_source/lib" install-static install-includes install-pc \
  PREFIX="$prefix" CC="$CC" AR="$AR" CFLAGS="$common_cflags" \
  ZSTD_LIB_COMPRESSION=0 ZSTD_LIB_DECOMPRESSION=1 \
  ZSTD_LIB_DICTBUILDER=0 ZSTD_LIB_DEPRECATED=0 ZSTD_LEGACY_SUPPORT=0
if ar t "$prefix/lib/libzstd.a" | grep -Eq \
  '(^|/)(zstd_compress|zstd_compress_superblock|zstd_double_fast|zstd_fast|zstd_lazy|zstd_ldm|zstdmt_compress|zstd_v0[1-7]|zdict)\.o$'; then
  die "zstd archive contains a disabled compressor/dictionary/legacy object"
fi

patch_file="$type2_source/patches/libfuse/mount.c.diff"
[[ $(sha256sum "$patch_file" | awk '{print $1}') == 1c7fd9e26717545a476b226b083a9f9d05676c180edbd71a04bbd8a73599dc44 ]] || {
  die "type2-runtime libfuse patch drifted"
}
(
  cd "$fuse_source"
  patch --batch --forward -p1 <"$patch_file"
)
fuse_build="$build_root/libfuse"
# libfuse probes a few target functions with Meson's `cc.run()`.  musl-gcc
# would otherwise make those temporary probes dynamically linked against a
# loader that is intentionally absent from the static runtime prefix.  Make
# just its probe/link mode static so the native Jammy build can execute them.
fuse_cc="$CC -static"
CC="$fuse_cc" CFLAGS="$common_cflags" \
PKG_CONFIG_PATH='' PKG_CONFIG_LIBDIR="$PKG_CONFIG_LIBDIR" \
  python3 "$meson_source/meson.py" setup "$fuse_build" "$fuse_source" \
    --prefix="$prefix" --libdir=lib --buildtype=minsize --wrap-mode=nodownload \
    -Ddefault_library=static -Db_staticpic=true -Dauto_features=disabled \
    -Dutils=false -Dexamples=false -Dtests=false -Duseroot=false \
    -Ddisable-mtab=true -Ddisable-libc-symbol-version=true \
    -Dudevrulesdir= -Dinitscriptdir=
python3 "$meson_source/meson.py" compile -C "$fuse_build" -j "$jobs"
python3 "$meson_source/meson.py" install -C "$fuse_build" --no-rebuild
[[ -f $prefix/lib/libfuse3.a ]] || die "libfuse static library was not installed"
grep -Fq -- '-march=x86-64' "$fuse_build/compile_commands.json" || {
  die "libfuse compile database lost the baseline ISA flag"
}

(
  cd "$squashfuse_source"
  ./autogen.sh
  CC="$CC" CFLAGS="$common_cflags" \
  CPPFLAGS="-DFUSE_USE_VERSION=32 -I$prefix/include -I$prefix/include/fuse3" \
  LDFLAGS="-static -L$prefix/lib -Wl,--gc-sections" \
  PKG_CONFIG_PATH='' PKG_CONFIG_LIBDIR="$PKG_CONFIG_LIBDIR" \
    ./configure --prefix="$prefix" --disable-shared --enable-static \
      --disable-demo --without-xz --without-lzo --without-lz4 \
      --with-zlib="$prefix" --with-zstd="$prefix" \
      --with-fuse-include="$prefix/include/fuse3" \
      --with-fuse-lib="$prefix/lib" --with-fuse-soname=fuse3
  grep -Eq '^sq_decompressors = +ZLIB ZSTD$' Makefile || {
    die "squashfuse enabled an unexpected decompressor"
  }
  grep -Eq '^sq_high_level = yes$' Makefile || die "squashfuse high-level library is disabled"
  grep -Eq '^sq_low_level = yes$' Makefile || die "squashfuse low-level library is disabled"
  make -j "$jobs"
  make install
)
# type2-runtime calls this internal squashfuse helper directly.  squashfuse
# deliberately leaves it out of its public install set, so retain the exact
# source header beside the installed static archive for this closed build.
install -m 0644 -- "$squashfuse_source/fuseprivate.h" \
  "$prefix/include/squashfuse/fuseprivate.h"
for archive in \
  "$prefix/lib/libsquashfuse.a" "$prefix/lib/libsquashfuse_ll.a" \
  "$prefix/lib/libzstd.a" "$prefix/lib/libz.a" "$prefix/lib/libfuse3.a" \
  "$prefix/lib/libpthread.a" "$prefix/lib/libdl.a" "$prefix/lib/librt.a" \
  "$prefix/lib/libc.a"; do
  [[ -f $archive && ! -L $archive ]] || die "required static link input is missing: $archive"
done

gcc_libdir=$(dirname -- "$(gcc-11 -print-libgcc-file-name)")
gcc_libdir=$(realpath --canonicalize-existing -- "$gcc_libdir")
[[ $gcc_libdir == /usr/lib/gcc/x86_64-linux-gnu/11 ]] || {
  die "gcc-11 library directory drifted: $gcc_libdir"
}
crtbegin=$(realpath --canonicalize-existing -- "$(gcc-11 -print-file-name=crtbeginS.o)")
crtend=$(realpath --canonicalize-existing -- "$(gcc-11 -print-file-name=crtendS.o)")
libgcc=$(realpath --canonicalize-existing -- "$(gcc-11 -print-libgcc-file-name)")
libgcc_eh=$(realpath --canonicalize-existing -- "$(gcc-11 -print-file-name=libgcc_eh.a)")
for input in "$crtbegin" "$crtend" "$libgcc" "$libgcc_eh"; do
  [[ $input == "$gcc_libdir"/* && -f $input && ! -L $input ]] || {
    die "gcc-11 selected an unsafe or missing final-link input: $input"
  }
done

runtime_object="$build_root/runtime.o"
runtime_unstripped="$result/runtime-x86_64.unstripped"
runtime="$result/runtime-x86_64"
raw_link_map="$build_root/runtime-x86_64.link-map"
clang-14 --target=x86_64-linux-musl --sysroot="$prefix" \
  -march=x86-64 -mtune=generic -fPIE \
  -I"$prefix/include" -I"$prefix/include/fuse3" \
  -std=gnu99 -Os -g -D_FILE_OFFSET_BITS=64 -DFUSE_USE_VERSION=32 \
  "-DGIT_COMMIT=\"$STUDYVIS_APPIMAGE_RUNTIME_VERSION\"" \
  -ffunction-sections -fdata-sections -fno-ident \
  "-ffile-prefix-map=$work_root=$mapped_root" \
  "-fdebug-prefix-map=$work_root=$mapped_root" \
  -c "$type2_source/src/runtime/runtime.c" -o "$runtime_object"

# Explicit start files and archives make the closure independent of Clang's
# host GCC discovery.  libgcc is present only to preserve normal musl/GCC link
# semantics; this runtime is required to select zero libgcc archive members.
clang-14 --target=x86_64-linux-musl --sysroot="$prefix" \
  -static -static-pie -fuse-ld=bfd -nostdlib \
  -Wl,--gc-sections -Wl,--build-id=sha1 -Wl,--no-undefined \
  -Wl,-Map,"$raw_link_map" \
  -Wl,-T,"$type2_source/src/runtime/data_sections.ld" \
  "$prefix/lib/rcrt1.o" "$prefix/lib/crti.o" "$crtbegin" "$runtime_object" \
  -Wl,--start-group \
  "$prefix/lib/libsquashfuse.a" "$prefix/lib/libsquashfuse_ll.a" \
  "$prefix/lib/libzstd.a" "$prefix/lib/libz.a" "$prefix/lib/libfuse3.a" \
  "$prefix/lib/libpthread.a" "$prefix/lib/libdl.a" "$prefix/lib/librt.a" \
  "$libgcc" "$libgcc_eh" "$prefix/lib/libc.a" \
  -Wl,--end-group "$crtend" "$prefix/lib/crtn.o" \
  -o "$runtime_unstripped"

sed "s#$work_root#$mapped_root#g" "$raw_link_map" >"$result/runtime-x86_64.link-map"
if grep -Eq 'libgcc(_eh)?\.a\(' "$result/runtime-x86_64.link-map"; then
  die "final runtime unexpectedly selected a libgcc archive member"
fi
for required_input in \
  libsquashfuse.a libsquashfuse_ll.a libzstd.a libz.a libfuse3.a libc.a \
  rcrt1.o crti.o crtn.o crtbeginS.o crtendS.o libgcc.a libgcc_eh.a; do
  grep -Fq "$required_input" "$result/runtime-x86_64.link-map" || {
    die "link map omits declared input: $required_input"
  }
done
if grep -E '/usr/(local/)?lib|/lib/x86_64-linux-gnu' "$result/runtime-x86_64.link-map" \
  | grep -Fv '/usr/lib/gcc/x86_64-linux-gnu/11/' >/dev/null; then
  die "link map contains an undeclared host library path"
fi

install -m 0755 -- "$runtime_unstripped" "$runtime"
strip --strip-all -- "$runtime"
printf 'AI\002' | dd of="$runtime" bs=1 seek=8 conv=notrunc status=none

elf_type=$(readelf -hW "$runtime" | awk -F: '/^[[:space:]]*Type:/{gsub(/^[[:space:]]+/, "", $2); print $2}')
[[ $elf_type == DYN\ \(* ]] || die "runtime is not an ET_DYN static PIE: $elf_type"
if readelf -lW "$runtime" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)'; then
  die "runtime unexpectedly has a PT_INTERP"
fi
if readelf -dW "$runtime" | grep -Eq '\(NEEDED\)'; then
  die "runtime unexpectedly has a dynamic dependency"
fi
[[ -z $(nm -u "$runtime_unstripped") ]] || die "runtime contains undefined symbols"
[[ $(od -An -tx1 -j8 -N3 "$runtime" | tr -d ' \n') == 414902 ]] || {
  die "runtime is missing the type-2 AppImage magic at ELF offset 8"
}

section_size() {
  local section=$1
  readelf -SW "$runtime" | awk -v wanted="$section" '$2 == wanted { print $6 }'
}
[[ $(section_size .digest_md5) == 000010 ]] || die "runtime has the wrong .digest_md5 size"
[[ $(section_size .upd_info) == 000400 ]] || die "runtime has the wrong .upd_info size"
[[ $(section_size .sha256_sig) == 000400 ]] || die "runtime has the wrong .sha256_sig size"
[[ $(section_size .sig_key) == 002000 ]] || die "runtime has the wrong .sig_key size"

version_output=$($runtime --appimage-version 2>&1)
[[ $version_output == "AppImage runtime version: $STUDYVIS_APPIMAGE_RUNTIME_VERSION" ]] || {
  die "runtime version marker is wrong: $version_output"
}
for symbol in sqfs_open_image fuse_session_loop ZSTD_decompress inflate; do
  nm "$runtime_unstripped" | grep -Eq "[[:space:]]${symbol}$" || {
    die "runtime is missing required linked symbol: $symbol"
  }
done
if nm "$runtime_unstripped" | grep -Eq '[[:space:]](mi_|ZSTD_compress|ZSTD_createCCtx|ZSTDv0[1-7])'; then
  die "runtime contains deliberately excluded mimalloc/compressor/legacy code"
fi
if readelf -nW "$runtime" | grep -Eq 'x86 ISA needed:.*x86-64-(v[234]|v[2-4])'; then
  die "runtime requires a post-baseline x86-64 ISA level"
fi
if strings "$runtime_unstripped" | grep -Fq "$work_root"; then
  die "runtime embeds the runner's temporary build path"
fi

toolchain_inventory="$result/TOOLCHAIN-INVENTORY.tsv"
printf 'role\tbinary_package\tbinary_version\tsource_package\tsource_version\tcommand\tcommand_version\n' \
  >"$toolchain_inventory"
record_tool() {
  local role=$1
  local package=$2
  local command_path=$3
  local command_version=$4
  local metadata version source_name source_version
  metadata=$(dpkg-query -W -f='${Version}\t${source:Package}\t${source:Version}\n' "$package")
  IFS=$'\t' read -r version source_name source_version <<<"$metadata"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$role" "$package" "$version" "${source_name:-$package}" \
    "${source_version:-$version}" "$command_path" "$command_version" \
    >>"$toolchain_inventory"
}
record_tool final-c-compiler clang-14 "$(command -v clang-14)" "$(clang-14 --version | head -1)"
record_tool dependency-c-compiler gcc-11 "$(command -v gcc-11)" "$(gcc-11 --version | head -1)"
record_tool linker binutils "$(command -v ld.bfd)" "$(ld.bfd --version | head -1)"
record_tool linked-gcc-runtime libgcc-11-dev "$gcc_libdir" "$STUDYVIS_APPIMAGE_RUNTIME_LIBGCC_VERSION"
for package in autoconf automake libtool make ninja-build pkg-config python3 tar xz-utils; do
  dpkg-query -W "$package" >/dev/null 2>&1 || die "cannot inventory build-tool package: $package"
  record_tool build-tool "$package" - -
done

link_inputs="$result/runtime-x86_64.link-inputs.tsv"
printf 'role\tpath\tsha256\n' >"$link_inputs"
record_link_input() {
  local role=$1
  local path=$2
  local display_path=$path
  case $display_path in
    "$work_root"/*) display_path="$mapped_root/${display_path#"$work_root"/}" ;;
  esac
  local sha
  sha=$(sha256sum -- "$path")
  sha=${sha%% *}
  printf '%s\t%s\t%s\n' "$role" "$display_path" "$sha" >>"$link_inputs"
}
record_link_input musl-crt "$prefix/lib/rcrt1.o"
record_link_input musl-crt "$prefix/lib/crti.o"
record_link_input gcc-crt "$crtbegin"
record_link_input runtime-object "$runtime_object"
for archive in \
  "$prefix/lib/libsquashfuse.a" "$prefix/lib/libsquashfuse_ll.a" \
  "$prefix/lib/libzstd.a" "$prefix/lib/libz.a" "$prefix/lib/libfuse3.a" \
  "$prefix/lib/libpthread.a" "$prefix/lib/libdl.a" "$prefix/lib/librt.a" \
  "$libgcc" "$libgcc_eh" "$prefix/lib/libc.a"; do
  record_link_input static-archive "$archive"
done
record_link_input gcc-crt "$crtend"
record_link_input musl-crt "$prefix/lib/crtn.o"

runtime_sha=$(sha256sum -- "$runtime")
runtime_sha=${runtime_sha%% *}
runtime_unstripped_sha=$(sha256sum -- "$runtime_unstripped")
runtime_unstripped_sha=${runtime_unstripped_sha%% *}
runtime_size=$(wc -c <"$runtime")
build_id=$(readelf -nW "$runtime" | sed -n 's/.*Build ID: \([0-9A-Fa-f][0-9A-Fa-f]*\).*/\1/p' | head -n 1)
[[ $build_id =~ ^[0-9a-fA-F]{40}$ ]] || die "runtime build-id is missing or malformed"
{
  printf 'key\tvalue\n'
  printf 'build_revision\t%s\n' "$STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION"
  printf 'type2_commit\t%s\n' "$STUDYVIS_APPIMAGE_RUNTIME_COMMIT"
  printf 'runtime_version\t%s\n' "$STUDYVIS_APPIMAGE_RUNTIME_VERSION"
  printf 'source_date_epoch\t%s\n' "$SOURCE_DATE_EPOCH"
  printf 'target\tx86_64-linux-musl\n'
  printf 'isa\tx86-64-baseline\n'
  printf 'elf_type\tET_DYN\n'
  printf 'linkage\tstatic-pie-no-interpreter-no-needed\n'
  printf 'allocator\tmusl-mallocng\n'
  printf 'zstd_features\tdecompression-only,no-legacy,no-dictbuilder,no-multithreading\n'
  printf 'runtime_size\t%s\n' "$runtime_size"
  printf 'runtime_sha256\t%s\n' "$runtime_sha"
  printf 'runtime_unstripped_sha256\t%s\n' "$runtime_unstripped_sha"
  printf 'gnu_build_id\t%s\n' "$build_id"
} >"$result/RUNTIME-BUILD-METADATA.tsv"

cp -p -- "$script_dir/linux-appimage-runtime.env" \
  "$result/linux-appimage-runtime.env"
cp -p -- "$source_manifest" "$result/linux-appimage-runtime-sources.tsv"
cp -p -- "$script_dir/build-linux-appimage-runtime.sh" \
  "$result/build-linux-appimage-runtime.sh"
(
  cd "$result"
  # SHA256SUMS is excluded from the input set, so this does not read the file
  # the shell opens for the pipeline's output.
  # shellcheck disable=SC2094
  find . -type f ! -name SHA256SUMS -printf '%P\n' \
    | LC_ALL=C sort \
    | xargs -r sha256sum -- >SHA256SUMS
)

mv -- "$result" "$output"
trap - EXIT
rm -rf -- "$work_root"
echo "Built source-closed AppImage runtime: $output/runtime-x86_64 ($runtime_sha)"
