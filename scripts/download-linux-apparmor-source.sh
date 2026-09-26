#!/usr/bin/env bash
# Noble's installed AppArmor .7 can outlive its entry in the current Sources
# index. Ubuntu's signed 2026-06-15 noble-updates InRelease records
# main/source/Sources.xz SHA256 e6dbcd91c8fc5f3c5d2ccc7ecb20c66e6d2375e8409b2338e9ee1bcc687b1e83;
# that source index records the file hashes below. Never substitute a newer
# source version.

set -euo pipefail

[[ $# -eq 1 && $1 == /* && -d $1 && ! -L $1 ]] || {
  echo 'usage: download-linux-apparmor-source.sh <empty absolute output directory>' >&2
  exit 2
}
output_dir=$1
[[ -z $(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
  echo "error: AppArmor source output directory is not empty: $output_dir" >&2
  exit 1
}

source_url=https://snapshot.ubuntu.com/ubuntu/20260615T000000Z/pool/main/a/apparmor
version=4.0.1really4.0.1-0ubuntu0.24.04.7
files=(
  "apparmor_${version}.dsc"
  'apparmor_4.0.1really4.0.1.orig.tar.gz'
  "apparmor_${version}.debian.tar.xz"
)
hashes=(
  4dacfccd0fc68a09c9a0012eef8254190202c5c888fe0c4e2bafe2de55907202
  b0d72cedc48e533d189ea415bde721ad597101c77fa398fdd2858ec4f58f7e26
  5b5c5518af3227781a3104924dc42b7e18628205aa389e2594799a08ee2f1860
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
