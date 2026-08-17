#!/usr/bin/env bash
# Verify the source-built AppImage runtime output and, optionally, an exact
# pre-SquashFS prefix after normalising only appimagetool's reserved fields.

set -euo pipefail
export LC_ALL=C

die() {
  echo "error: $*" >&2
  exit 1
}

[[ $# -eq 1 || $# -eq 2 ]] || {
  echo "usage: $0 <runtime-build-directory> [AppImage-runtime-prefix]" >&2
  exit 2
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linux-appimage-runtime.env
source "$script_dir/linux-appimage-runtime.env"

for command_name in awk cmp cp dd find grep mktemp od readelf realpath rm sha256sum tr wc; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing runtime verifier dependency: $command_name"
done

build_dir=$(realpath --canonicalize-existing -- "$1")
[[ -d $build_dir && ! -L $build_dir ]] || die "runtime build directory is missing or symlinked"
[[ ${build_dir##*/} == "studyvis-appimage-runtime-r${STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION}" ]] || {
  die "runtime build directory has the wrong revision: $build_dir"
}
# Captured, not piped: `grep -q` stops at its first match, which SIGPIPEs a
# still-writing producer and, under `set -o pipefail`, turns the match into a
# failed pipeline — silently skipping the `die` it was supposed to trigger.
runtime_symlink=$(find "$build_dir" -type l -print -quit)
if [[ -n $runtime_symlink ]]; then
  die "runtime build output contains a symlink"
fi

for required in \
  runtime-x86_64 runtime-x86_64.unstripped runtime-x86_64.link-map \
  runtime-x86_64.link-inputs.tsv RUNTIME-BUILD-METADATA.tsv \
  SOURCE-INVENTORY.tsv LICENSE-INVENTORY.tsv TOOLCHAIN-INVENTORY.tsv \
  SHA256SUMS build-linux-appimage-runtime.sh linux-appimage-runtime.env \
  linux-appimage-runtime-sources.tsv; do
  [[ -s $build_dir/$required && -f $build_dir/$required && ! -L $build_dir/$required ]] || {
    die "runtime build output is missing $required"
  }
done
cmp -s "$build_dir/build-linux-appimage-runtime.sh" "$script_dir/build-linux-appimage-runtime.sh" || {
  die "cached runtime builder does not match the repository"
}
cmp -s "$build_dir/linux-appimage-runtime.env" "$script_dir/linux-appimage-runtime.env" || {
  die "cached runtime tuple does not match the repository"
}
cmp -s "$build_dir/linux-appimage-runtime-sources.tsv" "$script_dir/linux-appimage-runtime-sources.tsv" || {
  die "cached runtime source manifest does not match the repository"
}
(cd "$build_dir" && sha256sum --check --strict SHA256SUMS >/dev/null) || {
  die "runtime build SHA256SUMS verification failed"
}

metadata_value() {
  local key=$1
  awk -F '\t' -v key="$key" '$1 == key { count++; value=$2 } END { if (count == 1) print value; else exit 1 }' \
    "$build_dir/RUNTIME-BUILD-METADATA.tsv"
}
[[ $(metadata_value build_revision) == "$STUDYVIS_APPIMAGE_RUNTIME_BUILD_REVISION" ]] || die "runtime build revision drifted"
[[ $(metadata_value type2_commit) == "$STUDYVIS_APPIMAGE_RUNTIME_COMMIT" ]] || die "runtime source commit drifted"
[[ $(metadata_value runtime_version) == "$STUDYVIS_APPIMAGE_RUNTIME_VERSION" ]] || die "runtime version marker drifted"
[[ $(metadata_value target) == x86_64-linux-musl ]] || die "runtime target drifted"
[[ $(metadata_value isa) == x86-64-baseline ]] || die "runtime ISA policy drifted"
[[ $(metadata_value linkage) == static-pie-no-interpreter-no-needed ]] || die "runtime linkage policy drifted"
[[ $(metadata_value gnu_build_id) =~ ^[0-9a-fA-F]{40}$ ]] || {
  die "runtime build metadata has an invalid GNU build-id"
}

runtime="$build_dir/runtime-x86_64"
runtime_size=$(wc -c <"$runtime")
runtime_sha=$(sha256sum -- "$runtime")
runtime_sha=${runtime_sha%% *}
[[ $runtime_size == "$(metadata_value runtime_size)" ]] || die "runtime size does not match its build metadata"
[[ $runtime_sha == "$(metadata_value runtime_sha256)" ]] || die "runtime hash does not match its build metadata"
[[ $(od -An -tx1 -j8 -N3 "$runtime" | tr -d ' \n') == 414902 ]] || die "runtime lacks type-2 magic"
[[ $($runtime --appimage-version 2>&1) == "AppImage runtime version: $STUDYVIS_APPIMAGE_RUNTIME_VERSION" ]] || {
  die "runtime executable has the wrong version marker"
}
runtime_header=$(readelf -hW "$runtime")
runtime_program_headers=$(readelf -lW "$runtime")
runtime_dynamic=$(readelf -dW "$runtime")
grep -Eq 'Type:[[:space:]]+DYN' <<<"$runtime_header" || die "runtime is not ET_DYN"
if grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)' <<<"$runtime_program_headers"; then
  die "runtime has PT_INTERP"
fi
if grep -Eq '\(NEEDED\)' <<<"$runtime_dynamic"; then
  die "runtime has DT_NEEDED"
fi

[[ $# -eq 2 ]] || exit 0
prefix=$(realpath --canonicalize-existing -- "$2")
[[ -f $prefix && ! -L $prefix ]] || die "AppImage runtime prefix is missing or symlinked"
[[ $(wc -c <"$prefix") -eq $runtime_size ]] || die "AppImage runtime prefix has the wrong size"

section_tuple() {
  local file=$1 section=$2
  readelf -SW "$file" | awk -v wanted="$section" '
    /^[[:space:]]*\[[[:space:]0-9]+\]/ {
      line=$0; sub(/^[[:space:]]*\[[[:space:]0-9]+\][[:space:]]+/, "", line)
      n=split(line, field, /[[:space:]]+/)
      if (field[1] == wanted) { count++; tuple=field[4] " " field[5] }
    }
    END { if (count == 1) print tuple; else exit 1 }
  '
}

scratch=$(mktemp -d "${TMPDIR:-/tmp}/studyvis-runtime-verify.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
cp -- "$runtime" "$scratch/runtime"
cp -- "$prefix" "$scratch/prefix"
for section in .digest_md5 .upd_info .sha256_sig .sig_key; do
  runtime_tuple=$(section_tuple "$runtime" "$section") || die "source runtime lacks unique $section"
  prefix_tuple=$(section_tuple "$prefix" "$section") || die "AppImage prefix lacks unique $section"
  [[ $runtime_tuple == "$prefix_tuple" ]] || die "AppImage prefix changed the $section layout"
  read -r offset size <<<"$runtime_tuple"
  [[ $offset =~ ^[0-9A-Fa-f]+$ && $size =~ ^[0-9A-Fa-f]+$ ]] || die "invalid $section layout"
  for copy in "$scratch/runtime" "$scratch/prefix"; do
    dd if=/dev/zero of="$copy" bs=1 seek=$((16#$offset)) count=$((16#$size)) \
      conv=notrunc status=none
  done
done
cmp -s "$scratch/runtime" "$scratch/prefix" || {
  die "AppImage runtime prefix differs outside appimagetool's reserved fields"
}
