#!/usr/bin/env bash
# Install the BrainVault (vault-service) systemd USER unit so the service starts with WSL
# and survives a restart (TASKS-M5 §1 DoD). Idempotent: re-run after changing VAULT_ROOT
# or upgrading node. It resolves the repo path and the real node binary (nvm's node is not
# on systemd's PATH) and bakes them into the unit.
#
# Usage:
#   scripts/install-systemd.sh [VAULT_ROOT]        # default VAULT_ROOT: ~/vault
#
# After install, enable lingering so it runs without an active login session:
#   loginctl enable-linger "$USER"
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO/scripts/vault-service.service.template"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/vault-service.service"
ENV_FILE="$HOME/.config/vault-service/env"
VAULT_ROOT_ARG="${1:-$HOME/vault}"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"
command -v systemctl >/dev/null || die "systemctl not found — systemd (user) is required."

# Resolve the REAL node path (nvm installs symlinks); systemd needs an absolute ExecStart.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found on PATH. Load nvm first: . ~/.nvm/nvm.sh"
NODE="$(readlink -f "$NODE")"
NODEDIR="$(dirname "$NODE")"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $("$NODE" -v))."

# Resolve VAULT_ROOT to an absolute path and sanity-check it looks like the vault.
VAULT_ROOT="$(cd "$VAULT_ROOT_ARG" 2>/dev/null && pwd || true)"
[ -n "$VAULT_ROOT" ] || die "VAULT_ROOT does not exist: $VAULT_ROOT_ARG"
[ -d "$VAULT_ROOT/wiki" ] && [ -d "$VAULT_ROOT/skills" ] || \
  die "VAULT_ROOT does not look like a claude-obsidian vault (no wiki/ + skills/): $VAULT_ROOT"

# The app loads its Anthropic credential from this file. A missing file is fine now: the
# service starts in SETUP MODE and the dashboard collects the credential (Maintenance →
# Settings) — mention it so nobody hunts for a startup failure that no longer happens.
if [ ! -f "$ENV_FILE" ]; then
  echo "note: no credential file at $ENV_FILE yet — the service will start in setup mode;"
  echo "      open the dashboard and add the credential under Maintenance → Settings."
fi

# yt-dlp (YouTube URL ingestion) is often installed under pyenv shims or ~/.local/bin,
# neither of which is on systemd's minimal PATH. Append its directory LAST so it never
# shadows the system python3/bash the unit deliberately resolves first.
YTDLP="$(command -v yt-dlp || true)"
EXTRA_PATH=""
if [ -n "$YTDLP" ]; then
  EXTRA_PATH=":$(dirname "$YTDLP")"
else
  echo "warning: yt-dlp not found on PATH — YouTube URL jobs will fail until it is installed" >&2
fi

# deno backs yt-dlp's YouTube extraction (EJS player challenges). Without it on the
# service PATH, YouTube jobs trip the "Sign in to confirm you're not a bot" check far
# more often. Same append-last rule as yt-dlp.
DENO="$(command -v deno || true)"
if [ -n "$DENO" ]; then
  DENODIR="$(dirname "$DENO")"
  case "$EXTRA_PATH" in
    *":$DENODIR"*) ;;
    *) EXTRA_PATH="$EXTRA_PATH:$DENODIR" ;;
  esac
else
  echo "warning: deno not found on PATH — YouTube extraction is degraded and will hit bot checks; run scripts/install-preprocessing-tools.sh" >&2
fi

# Ensure a production build exists (single-process `node dist/main.js`).
if [ ! -f "$REPO/server/dist/main.js" ]; then
  echo "building server + web (no dist yet)…"
  ( cd "$REPO" && npm run build )
fi

mkdir -p "$UNIT_DIR"
sed -e "s#@REPO@#$REPO#g" \
    -e "s#@NODE@#$NODE#g" \
    -e "s#@NODEDIR@#$NODEDIR#g" \
    -e "s#@VAULT_ROOT@#$VAULT_ROOT#g" \
    -e "s#@EXTRA_PATH@#$EXTRA_PATH#g" \
    "$TEMPLATE" > "$UNIT"
echo "wrote $UNIT"

systemctl --user daemon-reload
systemctl --user enable vault-service.service >/dev/null
echo "enabled vault-service (starts on login/boot)."

cat <<EOF

Next steps:
  1. Survive logout / run without an active session (required for WSL autostart):
       loginctl enable-linger "$USER"
  2. Start it now:
       systemctl --user start vault-service
  3. Check it:
       systemctl --user status vault-service
       curl -s http://127.0.0.1:8420/api/v1/health
  4. Logs:
       journalctl --user -u vault-service -f

DoD test: restart WSL (in Windows: 'wsl --shutdown', then reopen), and confirm
  curl http://127.0.0.1:8420/api/v1/health  responds without a manual start.
EOF
