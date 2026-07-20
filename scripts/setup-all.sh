#!/usr/bin/env bash
#
# One-shot setup: from a fresh clone to a running dashboard in a single command.
#
#   bash scripts/setup-all.sh [VAULT_ROOT]     # default VAULT_ROOT: ~/vault
#
# It installs Node (via nvm) if missing, the sandbox + preprocessing toolchain (apt/pip,
# prompts for sudo), clones and seeds the claude-obsidian vault, builds the app, installs
# the systemd user unit, and starts the service.
#
# The one thing it deliberately does NOT do is ask for your Anthropic credential: the
# service starts in SETUP MODE and the dashboard walks you through that step in the
# browser (Maintenance → Settings), which is friendlier than pasting tokens into a shell.
#
# Idempotent — safe to re-run after a failure or an update; every step checks before it acts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT_ROOT="${1:-$HOME/vault}"
# Our fork of AgriciDaniel/claude-obsidian, pinned to the version the service is
# built and tested against (SPEC.md §11 risk 4). Upgrades are a deliberate act:
# merge the upstream tag into the fork, test, re-run permprobe, then bump the ref.
VAULT_REPO_URL="https://github.com/steinborndev/claude-obsidian"
VAULT_REPO_REF="v1.9.2"
NODE_MAJOR_REQUIRED=20

step() { printf '\n\033[1m==> [%s/7] %s\033[0m\n' "$1" "$2"; }
die() { echo "error: $*" >&2; exit 1; }

command -v apt-get >/dev/null || die "this script targets Debian/Ubuntu (apt-get not found)."
command -v systemctl >/dev/null || die "systemd (user) is required — on WSL, enable it in /etc/wsl.conf ([boot] systemd=true) and restart WSL."

step 1 "Node.js >= ${NODE_MAJOR_REQUIRED} (via nvm if missing)"
# nvm may be installed but not loaded in this non-interactive shell.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR_REQUIRED" ]; then
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "installing nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    . "$NVM_DIR/nvm.sh"
  fi
  nvm install "$NODE_MAJOR_REQUIRED"
  nvm alias default "$NODE_MAJOR_REQUIRED"
fi
[ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ] || die "node >= ${NODE_MAJOR_REQUIRED} still not available after nvm install."
echo "node $(node -v) at $(command -v node)"

step 2 "Sandbox dependencies (bubblewrap + socat — apt, needs sudo)"
if dpkg -s bubblewrap socat >/dev/null 2>&1; then
  echo "already installed."
else
  sudo apt-get update
  sudo apt-get install -y bubblewrap socat git
fi

step 3 "Preprocessing toolchain (PDF/Office/OCR/…)"
"$REPO/scripts/install-preprocessing-tools.sh"

step 4 "The vault ($VAULT_ROOT)"
if [ -d "$VAULT_ROOT/wiki" ] && [ -d "$VAULT_ROOT/skills" ]; then
  echo "vault already present."
elif [ -e "$VAULT_ROOT" ]; then
  die "$VAULT_ROOT exists but does not look like a claude-obsidian vault (no wiki/ + skills/). Move it aside or pass a different path."
else
  git clone "$VAULT_REPO_URL" "$VAULT_ROOT"
  # Pin to the tested tag on a real branch (not a detached HEAD — ingest commits land here).
  # Then disable push: the vault fills with private content, and origin is a public repo.
  ( cd "$VAULT_ROOT" \
    && git checkout -B vault-main "$VAULT_REPO_REF" \
    && git remote set-url --push origin PUSH_DISABLED_vault_is_private \
    && bash bin/setup-vault.sh )
fi

step 5 "Domain registry seed (non-destructive)"
"$REPO/scripts/install-domain-registry.sh" "$VAULT_ROOT"

step 6 "Install dependencies and build"
( cd "$REPO" && npm ci && npm run build )

step 7 "systemd user unit + start"
"$REPO/scripts/install-systemd.sh" "$VAULT_ROOT"
loginctl enable-linger "$USER" 2>/dev/null || echo "note: 'loginctl enable-linger $USER' failed — run it manually so the service survives logout."
systemctl --user restart vault-service

sleep 2
if curl -fsS http://127.0.0.1:8420/api/v1/health >/dev/null 2>&1; then
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────
  BrainVault is running.

  Open   http://localhost:8420   in your browser.

  One step left: connect your Anthropic account. The dashboard shows
  a "Set up now" banner that takes you there (Maintenance → Settings).
──────────────────────────────────────────────────────────────────────
EOF
else
  echo "warning: the service did not answer on http://127.0.0.1:8420 yet."
  echo "check:  systemctl --user status vault-service"
  echo "logs:   journalctl --user -u vault-service -e"
fi
