#!/usr/bin/env bash
# Noble's installed AppArmor can outlive its entry in the current Sources
# index. These exact source tuples are authenticated by Ubuntu's signed
# noble-updates InRelease -> main/source/Sources.xz chain:
# .7: 2026-06-15, SHA256 e6dbcd91c8fc5f3c5d2ccc7ecb20c66e6d2375e8409b2338e9ee1bcc687b1e83
# .8: 2026-10-01, SHA256 d42dfea9edfb46b7b219624d457b0b99015ca743baeb21b8a5ad586c56b605fa
# Never substitute a newer source version or accept an unreviewed tuple.

set -euo pipefail

[[ $# -ge 1 && $# -le 2 && $1 == /* && -d $1 && ! -L $1 ]] || {
  echo 'usage: download-linux-apparmor-source.sh <empty absolute output directory> [exact version]' >&2
  exit 2
}
output_dir=$1
[[ -z $(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
  echo "error: AppArmor source output directory is not empty: $output_dir" >&2
  exit 1
}

version=${2-4.0.1really4.0.1-0ubuntu0.24.04.7}
case $version in
  4.0.1really4.0.1-0ubuntu0.24.04.7)
    snapshot=20260615T000000Z
    dsc_sha=4dacfccd0fc68a09c9a0012eef8254190202c5c888fe0c4e2bafe2de55907202
    debian_sha=5b5c5518af3227781a3104924dc42b7e18628205aa389e2594799a08ee2f1860
    ;;
  4.0.1really4.0.1-0ubuntu0.24.04.8)
    snapshot=20261001T000000Z
    dsc_sha=f73d91f3b5f648cee59474189982a96791728826818f58b61edd50967e8f206b
    debian_sha=ee743b137754d09da93b579abaac21da8526eef5a32834a8d3e011710bd14885
    ;;
  *)
    echo "error: no reviewed Ubuntu snapshot source for apparmor=$version" >&2
    exit 1
    ;;
esac
source_url=https://snapshot.ubuntu.com/ubuntu/$snapshot/pool/main/a/apparmor
files=(
  "apparmor_${version}.dsc"
  'apparmor_4.0.1really4.0.1.orig.tar.gz'
  "apparmor_${version}.debian.tar.xz"
)
hashes=(
  "$dsc_sha"
  b0d72cedc48e533d189ea415bde721ad597101c77fa398fdd2858ec4f58f7e26
  "$debian_sha"
)

scratch=$(mktemp -d "$output_dir/.apparmor-source.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
for index in "${!files[@]}"; do
  filename=${files[$index]}
  curl --fail --silent --show-error --location --proto '=https' \
    --proto-redir '=https' --tlsv1.2 --retry 3 --retry-all-errors \
    --connect-timeout 30 --output "$scratch/$filename" \
    "$source_url/$filename"
  printf '%s  %s\n' "${hashes[$index]}" "$scratch/$filename" \
    | sha256sum --check --strict --status
done
mv -- "$scratch"/* "$output_dir/"
echo "Downloaded verified Ubuntu snapshot source: apparmor=$version"
