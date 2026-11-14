#!/usr/bin/env bash
# Run as root in an x86_64 amazonlinux:2023 container with Go, git, jq, e2fsprogs and zstd.
set -euo pipefail
out=$(realpath -m "${1:?usage: build-guest-image.sh OUT-DIR}")
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root=$work/root
image=$work/guest.ext4
commit=$(git -C "$src" rev-parse HEAD)
# The last commit touching a guest input (guest-inputs.txt), so unchanged inputs rebuild the same image.
mapfile -t inputs < <(grep -Ev '^(#|$)' "$src/camelfsd/scripts/guest-inputs.txt")
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$src" log -1 --format=%ct -- "${inputs[@]}")}
export E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH

(
  cd "$src/camelfsd"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags guest -trimpath -ldflags='-s -w' -o "$work/camelfsd" ./cmd/camelfsd
)
# Use the container's versioned AL2023 repository snapshot and configuration.
release=$(rpm -q --qf '%{VERSION}' system-release)
dnf_root=(dnf -y -q --installroot="$root" --releasever="$release"
  --setopt=reposdir=/etc/yum.repos.d --setopt=varsdir=/etc/dnf/vars)
"${dnf_root[@]}" --setopt=install_weak_deps=False install \
  bash coreutils findutils grep sed gawk tar gzip xz bzip2 unzip which procps-ng util-linux iproute shadow-utils \
  ca-certificates curl git make gcc gcc-c++ python3 python3-pip e2fsprogs
install -d -m 0755 "$root/repo" "$root/out"
install -D -m 0755 "$work/camelfsd" "$root/usr/local/bin/camelfsd"
install -D -m 0755 "$work/camelfsd" "$root/sbin/camel-init"
"${dnf_root[@]}" clean all
rpm --root "$root" -qa --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n' | LC_ALL=C sort > "$work/packages"
find "$root" -print0 | LC_ALL=C sort -z | xargs -0 -r touch -h -d "@$SOURCE_DATE_EPOCH"
truncate -s 6G "$image"
mkfs.ext4 -q -F -L camel-root -U 48b9cb85-f1d8-46cf-a0fb-01664c0df5f4 \
  -E hash_seed=42ef6f74-3b41-45e1-8e23-85b753db3ac8,lazy_itable_init=0,lazy_journal_init=0 -d "$root" "$image"
sha=$(sha256sum "$image" | cut -d ' ' -f1)
zstd -q -T0 -6 "$image" -o "$work/guest.ext4.zst"
zsha=$(sha256sum "$work/guest.ext4.zst" | cut -d ' ' -f1)
jq -n --arg sha "$sha" --argjson bytes "$(stat -c %s "$image")" --arg zsha "$zsha" --arg commit "$commit" \
  --argjson zbytes "$(stat -c %s "$work/guest.ext4.zst")" --rawfile packages "$work/packages" \
  '{sha256:$sha,bytes:$bytes,zstdSha256:$zsha,zstdBytes:$zbytes,camelfsdCommit:$commit,packages:($packages|split("\n")|map(select(length>0)))}' > "$work/guest.json"
mv "$work/guest.ext4.zst" "$out/guest-$sha.ext4.zst"
mv "$work/guest.json" "$out/guest-$sha.json"
echo "Guest image $sha: $(stat -c %s "$image") bytes ext4, $(stat -c %s "$out/guest-$sha.ext4.zst") bytes zstd"
