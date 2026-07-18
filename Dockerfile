# BrainVault (vault-service) — pure Linux userland image (SPEC.md §12.2, TASKS-M5 §5).
#
# Not used under WSL day-to-day; it exists so the service can move to an always-on host
# without a rewrite. Two things make this image non-trivial and are easy to get wrong:
#
#  1. The agent sandbox needs `bubblewrap` (+ `socat`). CLAUDE.md hard rule 4 runs the SDK with
#     `failIfUnavailable: true`, so if bwrap is missing every agent run FAILS LOUDLY rather than
#     silently running unconfined. That is the correct behaviour — but it means the runtime image
#     must ship bwrap, and the container needs unprivileged user namespaces (see README).
#  2. `better-sqlite3` is a native module. It is compiled in a stage that HAS build tools and
#     copied into a slim runtime on the same Debian release, so the ABI matches.

# ---------- build: compile the SPA and the server to plain JS ----------
FROM node:20-bookworm AS build
WORKDIR /app

# Manifests first so a dependency install layer is cached across source edits.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
# web -> web/dist (static), server -> server/dist (runnable JS, single node process)
RUN npm run build

# ---------- prod-deps: runtime dependencies only, still with a compiler available ----------
FROM node:20-bookworm AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# Rebuilds better-sqlite3 against this image's Node/glibc; bookworm here and bookworm-slim
# below share a Debian release, so the resulting binary is valid in the runtime stage.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime

# Sandbox deps (bubblewrap, socat) + the preprocessing toolchain from
# scripts/install-preprocessing-tools.sh. Kept in one layer to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap \
      socat \
      git \
      ca-certificates \
      poppler-utils \
      ocrmypdf \
      tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
      pandoc \
      libimage-exiftool-perl \
      python3 python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages \
      python-pptx openpyxl odfpy \
    && npm install -g defuddle \
    && rm -rf /var/lib/apt/lists/*
# (Deliberately no `apt-get purge python3-pip` here: the few MB saved are not worth an
# autoremove pulling a python3 dependency out from under the extractors.)

# Non-root: bubblewrap's normal mode is unprivileged user namespaces, and nothing here needs root.
#
# The mount points must be created here AND chowned to that user. Letting the VOLUME instruction
# below create them implicitly leaves them root-owned, and Docker seeds an anonymous volume from
# the image directory — so the service failed at startup with SQLITE_CANTOPEN because it could not
# create /data/jobs.db. Measured on the first real container run.
RUN useradd --create-home --uid 10001 vault \
    && mkdir -p /vault /data /inbox \
    && chown vault:vault /vault /data /inbox
WORKDIR /app

COPY --from=prod-deps --chown=vault:vault /app/node_modules ./node_modules
COPY --from=build     --chown=vault:vault /app/server/dist ./server/dist
COPY --from=build     --chown=vault:vault /app/web/dist ./web/dist
COPY --chown=vault:vault package.json ./
COPY --chown=vault:vault server/package.json ./server/

# The vault is mounted, never baked in — it is a configuration value (hard rule 1) and its
# contents are the user's data. SQLite lives outside the vault (hard rule 1: losing the DB must
# never damage the vault), so it gets its own volume.
ENV VAULT_ROOT=/vault \
    DB_PATH=/data/jobs.db \
    WATCH_FOLDER=/inbox \
    NODE_ENV=production
VOLUME ["/vault", "/data", "/inbox"]

# NOTE ON BINDING (hard rule 2 / SPEC.md §9): the default bind stays 127.0.0.1, which inside a
# container means "not reachable from outside". To publish the port you must ALSO configure an
# auth token — the service refuses to start on a non-loopback bind without one:
#   -e HOST=0.0.0.0 -e HTTP_AUTH_MODE=token -e HTTP_AUTH_TOKEN=<secret>
# Do not "fix" this by defaulting HOST to 0.0.0.0 here.
EXPOSE 8420

USER vault
WORKDIR /app/server
# Run the built JS directly: one process, so signals reach the server and no wrapper orphans it.
CMD ["node", "dist/main.js"]
