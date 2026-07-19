#!/usr/bin/env bash
# Install the domain registry seed page into the vault (SPEC.md §12.4, Meta-Kategorien Stufe 2).
#
# The registry lists the meta-categories pages may be filed under. Once installed, the VAULT's
# copy is the source of truth — the service reads it on every ingest and hands it to the agent
# as a closed list, and you edit it in the dashboard's page view (or here). This script only
# seeds it.
#
# Deliberately NON-destructive: an existing registry is never overwritten, because it is user
# content by then. Pass --force to replace it anyway (a backup is written alongside).
#
# Usage:
#   scripts/install-domain-registry.sh [VAULT_ROOT] [--force]   # default VAULT_ROOT: ~/vault
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="$REPO/scripts/vault-extensions/domains.md"
FORCE=0
VAULT_ROOT_ARG="$HOME/vault"

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) VAULT_ROOT_ARG="$arg" ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

[ -f "$SEED" ] || die "seed not found: $SEED"
VAULT_ROOT="$(cd "$VAULT_ROOT_ARG" 2>/dev/null && pwd)" || die "vault not found: $VAULT_ROOT_ARG"
[ -d "$VAULT_ROOT/wiki" ] || die "not a vault (no wiki/ directory): $VAULT_ROOT"

TARGET="$VAULT_ROOT/wiki/meta/domains.md"

if [ -f "$TARGET" ] && [ "$FORCE" -eq 0 ]; then
  echo "registry already installed: $TARGET"
  echo "(edit it in the dashboard, or re-run with --force to replace it with the seed)"
  exit 0
fi

if [ -f "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
  cp "$TARGET" "$BACKUP"
  echo "backed up existing registry to $BACKUP"
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SEED" "$TARGET"
echo "installed domain registry: $TARGET"
echo
echo "next steps:"
echo "  1. review/adjust the domains in the dashboard (Vault tab → wiki/meta/domains.md)"
echo "  2. run the domain backfill from the Wartung tab to file existing pages"
echo
echo "note: the registry is a vault page, so it is committed like any other vault content."
