#!/usr/bin/env bash
# Install this repo's git hooks by pointing core.hooksPath at scripts/git-hooks.
#
# The commit-msg hook stops private vault content (entity/source names, handles) from leaking
# into this PUBLIC repo's commit messages. It reads the vault at VAULT_ROOT (env, else ~/vault)
# and passes silently when no vault is present. See scripts/git-hooks/commit-msg for details.
#
# core.hooksPath is LOCAL git config (not committed), so every fresh clone must run this once.
# setup-all.sh calls it for you.
#
# Usage: scripts/install-git-hooks.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "error: not a git repo: $REPO" >&2; exit 1; }

chmod +x "$REPO/scripts/git-hooks/commit-msg"
git config core.hooksPath scripts/git-hooks

echo "installed git hooks (core.hooksPath = scripts/git-hooks)"
echo "  - commit-msg: blocks vault entity/source names from leaking into commit messages"
