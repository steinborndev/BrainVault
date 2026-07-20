#!/usr/bin/env bash
#
# Installs the preprocessing toolchain (SPEC.md §5, TASKS-M1 §3). The apt packages need
# root, so this script uses sudo and will prompt for a password. Idempotent — safe to
# re-run. After it finishes, `npm run smoke -- --tools` (or detectTools) should report
# every tool present.
#
set -euo pipefail

# pip --user installs land in ~/.local/bin (yt-dlp). On a fresh account that dir is not
# on PATH yet — Ubuntu's ~/.profile only adds it once it EXISTS, i.e. from the next login
# on — so extend PATH here or the verification below reports a false MISS (fresh-WSL e2e
# finding, 2026-07-20). The systemd unit template carries ~/.local/bin already.
export PATH="$HOME/.local/bin:$PATH"

echo "==> System packages (apt, needs sudo)"
sudo apt-get update
sudo apt-get install -y \
  poppler-utils \
  ocrmypdf \
  tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
  pandoc \
  libimage-exiftool-perl

echo "==> Python extractors (pip)"
# python-pptx / openpyxl / odfpy back scripts/extract-office.py for pptx/xlsx/odf.
# Two fresh-Ubuntu realities (found in the fresh-WSL e2e test, 2026-07-20):
#  - a stock 24.04 ships python3 WITHOUT pip → install it via apt first;
#  - PEP 668 marks the system python "externally managed" and refuses plain --user
#    installs. python-pptx is not packaged by Ubuntu, so pip stays the only path for
#    the libraries; user-site installs with --break-system-packages are the sanctioned
#    non-venv escape for pure-python packages like these.
# `--user` is invalid inside a virtualenv (pyenv/venv/conda), so only add it when we are
# NOT in one — otherwise install into the active environment directly.
if ! python3 -m pip --version >/dev/null 2>&1; then
  sudo apt-get install -y python3-pip
fi
PIP_FLAGS="--user"
if python3 -c 'import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)' 2>/dev/null; then
  PIP_FLAGS=""  # inside a virtualenv
elif python3 -m pip install --help 2>/dev/null | grep -q break-system-packages; then
  PIP_FLAGS="--user --break-system-packages"
fi
python3 -m pip install ${PIP_FLAGS} --upgrade python-pptx openpyxl odfpy

echo "==> yt-dlp (pip, for YouTube URL ingestion: metadata + subtitles)"
python3 -m pip install ${PIP_FLAGS} --upgrade yt-dlp

echo "==> defuddle (npm, for URL/web extraction)"
# Installed globally under the user's npm prefix; no sudo if the prefix is user-owned.
# Ships the `defuddle` binary (the old `defuddle-cli` package merged into it).
npm install -g defuddle

echo "==> Verifying"
missing=0
for tool in pdftotext pdfinfo ocrmypdf tesseract pandoc exiftool defuddle yt-dlp; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  ok   %s\n' "$tool"
  else
    printf '  MISS %s\n' "$tool"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "Some tools are still missing — see above." >&2
  exit 1
fi
echo "All preprocessing tools present."
