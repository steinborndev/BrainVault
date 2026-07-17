#!/usr/bin/env bash
#
# Installs the preprocessing toolchain (SPEC.md §5, TASKS-M1 §3). The apt packages need
# root, so this script uses sudo and will prompt for a password. Idempotent — safe to
# re-run. After it finishes, `npm run smoke -- --tools` (or detectTools) should report
# every tool present.
#
set -euo pipefail

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
# `--user` is invalid inside a virtualenv (pyenv/venv/conda), so only add it when we are
# NOT in one — otherwise install into the active environment directly.
PIP_USER_FLAG="--user"
if python3 -c 'import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)' 2>/dev/null; then
  PIP_USER_FLAG=""  # inside a virtualenv
fi
python3 -m pip install ${PIP_USER_FLAG} --upgrade python-pptx openpyxl odfpy

echo "==> defuddle (npm, for URL/web extraction)"
# Installed globally under the user's npm prefix; no sudo if the prefix is user-owned.
# Ships the `defuddle` binary (the old `defuddle-cli` package merged into it).
npm install -g defuddle

echo "==> Verifying"
missing=0
for tool in pdftotext pdfinfo ocrmypdf tesseract pandoc exiftool defuddle; do
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
