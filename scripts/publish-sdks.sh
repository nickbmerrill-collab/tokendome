#!/usr/bin/env bash
# Publish both @tokendome/* SDKs to npm.
#
# Prereqs:
#   - You are an owner of the @tokendome npm scope (or have write access to it)
#   - You have an npm auth token in your shell:  export NPM_TOKEN=npm_…
#   - You've bumped the version in sdks/{anthropic,openai}/package.json if needed
#
# Usage:
#   ./scripts/publish-sdks.sh           # publish both
#   ./scripts/publish-sdks.sh anthropic # publish just anthropic
#   ./scripts/publish-sdks.sh --dry-run # show what would be published
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=""
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    anthropic|openai) TARGETS+=("$arg") ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then TARGETS=(anthropic openai); fi

if [ -z "${NPM_TOKEN:-}" ] && [ -z "$DRY_RUN" ]; then
  echo "✘ NPM_TOKEN not set. Generate at https://www.npmjs.com/settings/<you>/tokens"
  echo "  then: export NPM_TOKEN=npm_…"
  exit 1
fi

# Configure npm with the token so publish doesn't prompt.
if [ -n "${NPM_TOKEN:-}" ]; then
  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc.tokendome.tmp
  export NPM_CONFIG_USERCONFIG="$HOME/.npmrc.tokendome.tmp"
  trap 'rm -f "$HOME/.npmrc.tokendome.tmp"' EXIT
fi

for t in "${TARGETS[@]}"; do
  echo
  echo "── @tokendome/$t ──────────────────────────"
  cd "$ROOT/sdks/$t"
  npm install --silent
  npm run build
  npm publish --access public $DRY_RUN
done

echo
echo "✓ Done. Once published, users install with:"
echo "    npm i @tokendome/anthropic"
echo "    npm i @tokendome/openai"
