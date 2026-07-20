# TASKS-E2E-SETUP — fresh-machine test of the README quick start

Goal (user request, 2026-07-20): verify the PUBLIC repo's quick start end-to-end on a genuinely
fresh environment — the operator's machine has everything installed, so gaps in the setup path
would never surface there. **Acceptance: a verbatim `git clone` + `bash scripts/setup-all.sh` on a
stock system reaches a running dashboard in setup mode; adding a credential yields a successful
first ingest with a clean vault commit.**

## Method

A second, throwaway WSL distro on the same machine (`wsl --install Ubuntu-24.04 --name
brainvault-test --no-launch`, WSL 2.6.1): stock Ubuntu 24.04.4, fresh user with sudo, systemd
enabled via `/etc/wsl.conf`, nothing shared with the real installation. The live service was
stopped for the duration (WSL2 distros share one localhost, port 8420). Chosen over Docker (no
systemd — step 7 untestable) and over a second Linux user (shares apt state — the toolchain step,
the likeliest failure on foreign machines, would go untested). The distro was deleted afterwards
(`wsl --unregister`) — it necessarily held a copy of the credential for the ingest phase
(piped in, filtered of TELEGRAM lines, value never logged).

## Result: PASSED after two published fixes

Run 1 aborted in step 3, run 2 aborted in step 3's verification, run 3 completed cleanly:
dashboard up in setup mode → credential via env file → mini-PDF upload via `POST /jobs` →
`done` with a correct concept page (frontmatter incl. `domain: cooking` — the registry seed of
step 5 demonstrably reached the agent), source page, ONE commit on the pristine vault, `git fsck`
clean. ~2.5M/15k tokens (≈$1.47 est.) for the one-page test PDF.

## Findings

**F1 — stock Ubuntu 24.04 has no pip; PEP 668 blocks system pip installs (fixed, `b7f5c93`).**
`install-preprocessing-tools.sh` died at `python3 -m pip` (`No module named pip`) — on the dev
machine pip always existed via pyenv, so this could never surface locally. Second layer of the
same problem: 24.04's python is "externally managed" (PEP 668) and refuses plain `--user`
installs. Fix: apt-install `python3-pip` when missing; add `--break-system-packages` to user-site
installs on externally-managed pythons (python-pptx is NOT packaged by Ubuntu, so pip remains the
only path for the libraries); virtualenv/pyenv environments keep the old behavior.

**F2 — `~/.local/bin` is not on a fresh account's PATH within the same session (fixed, `a2f6679`).**
pip `--user` puts yt-dlp into `~/.local/bin`; Ubuntu's `~/.profile` adds that dir to PATH only
once it exists — i.e. from the NEXT login on. The script's own verification then reported a false
`MISS yt-dlp` and aborted the setup (`set -e`). Fix: the script exports the PATH entry itself.
The systemd unit template already carried `~/.local/bin`, so the service was never affected —
only the in-session verification.

**Environment notes (no code change):** the stock Ubuntu WSL image ships `git`, `curl` and
`systemctl`, so the quick start's implicit assumptions hold there. A WSL distro idle-stops when
its last external process exits — during multi-step testing, keep it alive (`wsl -d X sleep …`)
or every probe boots it anew (systemd + linger auto-start the service again, which masks the
stop). All WSL2 distros share one localhost: a test instance on 8420 answers probes meant for
the real one — check a distinguishing field (job counts), not just HTTP 200.
