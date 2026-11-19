#!/usr/bin/env bash
# Builds the .deb and .rpm in a container (see Containerfile) so they also run on older
# distributions than this machine. Output: src-tauri/target/packages/TIR_<version>_amd64.deb
# and TIR-<version>-1.x86_64.rpm (the files are renamed; the installed package keeps its
# name, so a new file still upgrades an installed copy).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
out=src-tauri/target/packages
image=immersive-reader-packages

podman build -t "$image" -f "$root/src-tauri/linux/Containerfile" "$root/src-tauri/linux"
mkdir -p "$root/$out/cargo"
podman run --rm --userns=keep-id --security-opt label=disable \
  -v "$root:/src" -w /src -e HOME=/tmp \
  -e CARGO_HOME="/src/$out/cargo" -e CARGO_TARGET_DIR="/src/$out/build" \
  "$image" npx tauri build --bundles deb,rpm

version="$(node -p "require('$root/src-tauri/tauri.conf.json').version")"
bundle="$root/$out/build/release/bundle"
rm -f "$root/$out"/*.deb "$root/$out"/*.rpm
cp "$bundle/deb/The Immersive Reader_${version}_amd64.deb" "$root/$out/TIR_${version}_amd64.deb"
cp "$bundle/rpm/The Immersive Reader-${version}-1.x86_64.rpm" "$root/$out/TIR-${version}-1.x86_64.rpm"
ls -1 "$root/$out"/*.deb "$root/$out"/*.rpm
