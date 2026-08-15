#!/usr/bin/env bash
# Prove that every x86_64 ELF in an extracted AppImage has a closed dynamic
# dependency graph. A DT_NEEDED/PT_INTERP name must resolve to an exact ELF
# byte inside the AppImage or be part of the reviewed host ABI boundary.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <absolute-AppDir> <absolute-runtime-prefix> <absolute-inventory.tsv>" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
appdir=$1
runtime_prefix=$2
inventory=$3

for command_name in cat file find grep head mktemp mv readelf realpath rm sed sha256sum sort; do
  command -v "$command_name" >/dev/null 2>&1 || {
    die "missing ELF-closure dependency: $command_name"
  }
done

normalize_existing() {
  local name=$1
  local value=$2
  [[ $value == /* && $value != *$'\n'* && $value != *$'\r'* && $value != *$'\t'* ]] || {
    die "$name must be an absolute path without control whitespace: $value"
  }
  realpath --canonicalize-existing -- "$value"
}

appdir=$(normalize_existing AppDir "$appdir")
runtime_prefix=$(normalize_existing runtime-prefix "$runtime_prefix")
[[ -d $appdir && ! -L $appdir ]] || die "AppDir is missing or symlinked: $appdir"
[[ -f $runtime_prefix && ! -L $runtime_prefix ]] || {
  die "runtime prefix is missing or symlinked: $runtime_prefix"
}
[[ $inventory == /* && $inventory != *$'\n'* && $inventory != *$'\r'* && $inventory != *$'\t'* ]] || {
  die "inventory path must be absolute without control whitespace: $inventory"
}
inventory_parent=${inventory%/*}
[[ -d $inventory_parent && -w $inventory_parent && ! -L $inventory ]] || {
  die "inventory destination is unsafe or unwritable: $inventory"
}

is_elf() {
  file -Lb -- "$1" | grep -q '^ELF '
}

elf_architecture() {
  readelf -h -- "$1" 2>/dev/null \
    | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p' \
    | head -n 1
}

declare -A external_abi=()
allowlist="$script_dir/linux-appimage-external-sonames.txt"
[[ -s $allowlist && ! -L $allowlist ]] || die "external ABI allowlist is missing"
while IFS= read -r soname || [[ -n $soname ]]; do
  soname=${soname%%#*}
  soname=${soname//[[:space:]]/}
  [[ -n $soname ]] || continue
  [[ $soname =~ ^[A-Za-z0-9+_.-]+$ ]] || die "invalid external ABI entry: $soname"
  [[ ! -v external_abi[$soname] ]] || die "duplicate external ABI entry: $soname"
  external_abi[$soname]=1
done <"$allowlist"
[[ ${#external_abi[@]} -gt 0 ]] || die "external ABI allowlist is empty"

declare -a elf_paths=()
while IFS= read -r -d '' path; do
  rel=${path#"$appdir/"}
  [[ $rel != "$path" && $rel != *$'\n'* && $rel != *$'\r'* && $rel != *$'\t'* ]] || {
    die "unsafe AppImage ELF path: $path"
  }
  if is_elf "$path"; then
    [[ $(elf_architecture "$path") == 'Advanced Micro Devices X86-64' ]] || {
      die "non-x86_64 ELF in x86_64 AppImage: $rel"
    }
    elf_paths+=("$rel")
  fi
done < <(find "$appdir" -type f -print0 | LC_ALL=C sort -z)
[[ ${#elf_paths[@]} -gt 0 ]] || die "AppImage contains no regular ELF payload"
is_elf "$runtime_prefix" || die "pre-SquashFS AppImage runtime is not ELF"
[[ $(elf_architecture "$runtime_prefix") == 'Advanced Micro Devices X86-64' ]] || {
  die "pre-SquashFS AppImage runtime is not x86_64"
}

resolve_bundled_provider() {
  local name=$1
  local consumer=$2
  local consumer_dir=${consumer%/*}
  local dynamic_kind dynamic_path entry expanded candidate resolved sha
  local -a app_ld_dirs=(
    "$appdir/usr/lib"
    "$appdir/usr/lib/x86_64-linux-gnu"
    "$appdir/usr/lib32"
    "$appdir/usr/lib64"
    "$appdir/lib"
    "$appdir/lib/x86_64-linux-gnu"
    "$appdir/lib32"
    "$appdir/lib64"
  )
  local -a rpath_dirs=()
  local -a runpath_dirs=()
  local -a search_dirs=()

  # linuxdeploy preserves/sets origin-relative RPATH/RUNPATH entries. Model
  # glibc's ordering relative to the LD_LIBRARY_PATH prepended by AppRun:
  # DT_RPATH (when there is no DT_RUNPATH), AppRun's packaged directories, then
  # DT_RUNPATH. A consumer's own directory is never an implicit search path.
  while IFS=$'\t' read -r dynamic_kind dynamic_path; do
    IFS=':' read -r -a dynamic_entries <<<"$dynamic_path"
    for entry in "${dynamic_entries[@]}"; do
      [[ -n $entry ]] || continue
      expanded=${entry//\$\{ORIGIN\}/$consumer_dir}
      expanded=${expanded//\$ORIGIN/$consumer_dir}
      [[ $expanded != *'$'* ]] || continue
      if [[ $dynamic_kind == RPATH ]]; then
        rpath_dirs+=("$expanded")
      else
        runpath_dirs+=("$expanded")
      fi
    done
  done < <(
    readelf -d -- "$consumer" 2>/dev/null \
      | sed -n \
        -e 's/.*(RPATH).*\[\([^]]*\)\].*/RPATH\t\1/p' \
        -e 's/.*(RUNPATH).*\[\([^]]*\)\].*/RUNPATH\t\1/p'
  )

  if [[ ${#runpath_dirs[@]} -eq 0 ]]; then
    search_dirs+=("${rpath_dirs[@]}")
  fi
  search_dirs+=("${app_ld_dirs[@]}")
  search_dirs+=("${runpath_dirs[@]}")

  for entry in "${search_dirs[@]}"; do
    expanded=$(realpath --canonicalize-missing -- "$entry" 2>/dev/null) || continue
    [[ $expanded == "$appdir" || $expanded == "$appdir/"* ]] || continue
    candidate="$expanded/$name"
    [[ -f $candidate ]] || continue
    resolved=$(realpath --canonicalize-existing -- "$candidate" 2>/dev/null) || continue
    [[ $resolved == "$appdir/"* && -f $resolved ]] || continue
    is_elf "$resolved" || continue
    sha=$(sha256sum -- "$resolved")
    sha=${sha%% *}
    printf '%s\t%s\n' "$sha" "${resolved#"$appdir/"}"
    return 0
  done
  return 1
}

# Every alias is checked to stay within this exact AppDir. Dependency
# resolution below follows the alias at the consumer's actual candidate path,
# so duplicate executable basenames in unrelated directories are harmless.
while IFS= read -r -d '' link; do
  rel=${link#"$appdir/"}
  [[ $rel != "$link" && $rel != *$'\n'* && $rel != *$'\r'* && $rel != *$'\t'* ]] || {
    die "unsafe AppImage symlink path: $link"
  }
  resolved=$(realpath --canonicalize-existing -- "$link" 2>/dev/null) || {
    die "broken AppImage symlink: $rel"
  }
  [[ $resolved == "$appdir/"* ]] || die "AppImage symlink escapes AppDir: $rel"
done < <(find "$appdir" -type l -print0 | LC_ALL=C sort -z)

temporary=$(mktemp "$inventory_parent/.studyvis-elf-closure.XXXXXX")
final_temporary=$(mktemp "$inventory_parent/.studyvis-elf-closure-final.XXXXXX")
cleanup() {
  rm -f -- "$temporary" "$final_temporary"
}
trap cleanup EXIT
: >"$temporary"

audit_consumer() {
  local label=$1
  local path=$2
  local relationship name interpreter resolution_sha resolution_path
  mapfile -t needed < <(
    readelf -d -- "$path" 2>/dev/null \
      | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' \
      | LC_ALL=C sort -u
  )
  for name in "${needed[@]}"; do
    [[ $name =~ ^[A-Za-z0-9+_.-]+$ ]] || die "unsafe DT_NEEDED name in $label: $name"
    relationship=DT_NEEDED
    if resolution=$(resolve_bundled_provider "$name" "$path"); then
      IFS=$'\t' read -r resolution_sha resolution_path <<<"$resolution"
      printf '%s\t%s\t%s\tbundled\t%s %s\n' \
        "$label" "$relationship" "$name" \
        "$resolution_sha" "$resolution_path" >>"$temporary"
    elif [[ -v external_abi[$name] ]]; then
      printf '%s\t%s\t%s\texternal-base-ABI\tlinux-appimage-external-sonames.txt\n' \
        "$label" "$relationship" "$name" >>"$temporary"
    else
      die "unresolved non-allowlisted DT_NEEDED '$name' in $label"
    fi
  done

  interpreter=$(
    readelf -l -- "$path" 2>/dev/null \
      | sed -n 's/.*Requesting program interpreter: \([^]]*\)].*/\1/p' \
      | head -n 1
  )
  if [[ -n $interpreter ]]; then
    name=${interpreter##*/}
    [[ $name =~ ^[A-Za-z0-9+_.-]+$ ]] || die "unsafe PT_INTERP name in $label: $name"
    if resolution=$(resolve_bundled_provider "$name" "$path"); then
      IFS=$'\t' read -r resolution_sha resolution_path <<<"$resolution"
      printf '%s\tPT_INTERP\t%s\tbundled\t%s %s\n' \
        "$label" "$name" "$resolution_sha" "$resolution_path" >>"$temporary"
    elif [[ -v external_abi[$name] ]]; then
      printf '%s\tPT_INTERP\t%s\texternal-base-ABI\tlinux-appimage-external-sonames.txt\n' \
        "$label" "$name" >>"$temporary"
    else
      die "unresolved non-allowlisted PT_INTERP '$name' in $label"
    fi
  fi
}

for rel in "${elf_paths[@]}"; do
  audit_consumer "$rel" "$appdir/$rel"
done
audit_consumer '@appimage-runtime-prefix' "$runtime_prefix"

LC_ALL=C sort -t $'\t' -k1,1 -k2,2 -k3,3 "$temporary" -o "$temporary"
printf 'appimage_path\trelationship\tname\tresolution\tevidence\n' >"$final_temporary"
cat "$temporary" >>"$final_temporary"
mv -- "$final_temporary" "$inventory"
rm -f -- "$temporary"
trap - EXIT
echo "Audited ${#elf_paths[@]} packaged ELFs plus the AppImage runtime against the reviewed host ABI boundary."
