#!/usr/bin/env bash
set -euo pipefail

install_root="${1:?usage: install-cargo-c.sh <isolated-install-root> <version>}"
version="${2:?missing cargo-c version}"
if [[ "$install_root" != /* || "$install_root" == / || "$install_root" == "${HOME}/.cargo" ]]; then
  echo 'cargo-c requires a dedicated absolute installation root' >&2
  exit 1
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'cargo-c requires an exact numeric version' >&2
  exit 1
fi

has_pinned_tools() {
  local tool output
  for tool in cargo-capi cargo-cbuild cargo-cinstall; do
    [[ -x "$install_root/bin/$tool" ]] || return 1
    output=$("$install_root/bin/$tool" --version) || return 1
    case "$output" in
      *" ${version}"|*" ${version}+"*) ;;
      *) return 1 ;;
    esac
  done
}

# rust-cache also restores ~/.cargo/bin. A cache miss here must never depend
# on which unrelated global tools that restore happened to contain.
if ! has_pinned_tools; then
  cargo install cargo-c --root "$install_root" --version "=$version" --locked --force
fi
has_pinned_tools
