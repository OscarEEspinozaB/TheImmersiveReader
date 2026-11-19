#!/usr/bin/env bash
# Builds the .deb and .rpm in a container (see Containerfile) so they also run on older
# distributions than this machine. Output: src-tauri/target/packages/
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

cp "$root/$out"/build/release/bundle/deb/*.deb "$root/$out"/build/release/bundle/rpm/*.rpm "$root/$out/"
ls -1 "$root/$out"/*.deb "$root/$out"/*.rpm
