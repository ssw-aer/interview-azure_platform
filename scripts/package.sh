#!/usr/bin/env bash
# Builds the deployment package attached to each GitHub Release.
# Produces dist/aurora-interview-app-v<version>.zip with node_modules included,
# so App Service runs it as-is with no build during deployment.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$repo_root/app/package.json').version")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$repo_root"/app/{package.json,package-lock.json,server.js,checks.js} "$work/"
(cd "$work" && npm ci --omit=dev --no-audit --no-fund)

mkdir -p "$repo_root/dist"
out="$repo_root/dist/aurora-interview-app-v${version}.zip"
rm -f "$out"
(cd "$work" && zip -qr "$out" .)
(cd "$repo_root/dist" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")

echo "Built $out"
cat "$out.sha256"
