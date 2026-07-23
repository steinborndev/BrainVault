# Security

BrainVault runs headless AI agent sessions against documents you did not write. This page
describes what the security model does and — just as importantly — what it does not promise.
The full, binding rules live in `CLAUDE.md` and `SPEC.md` §7–§9.

## The model in one paragraph

The service binds `127.0.0.1` and refuses to start on a non-loopback bind without token auth.
State-changing requests with a foreign `Origin` are rejected (drive-by/CSRF guard). Credentials
live only in the service environment (`~/.config/vault-service/env`, chmod 600) — never in the
repo, database, logs, frontend, or API responses. Agent runs execute inside an OS-level sandbox
(bubblewrap via the Claude Agent SDK) with writes confined to `VAULT_ROOT` and no network access
during ingest; a `PreToolUse` hook adds tool-level policy on top. The sandbox is configured
`failIfUnavailable: true`: if it cannot start, runs fail loudly instead of running unconfined.

## Threat model: untrusted documents (prompt injection)

Every ingested file, web page, or pasted text is **untrusted input to an autonomous agent that
writes to your vault**. A malicious document can attempt to instruct the agent ("ignore your
task, do X instead"). The guarantees and their limits:

**What the sandbox holds even against a fully hijacked agent:**

- Writes cannot leave `VAULT_ROOT` (OS-enforced, not prompt-enforced).
- Ingest runs have no web egress — a hijacked run cannot exfiltrate vault contents.
- Credentials are not readable: the credential file lives outside the sandbox's write scope and
  the agent environment only carries the one variable the SDK subprocess itself needs.
- A run cannot outlive its timeout; a stuck tool is killed with its whole process group.

**What is explicitly NOT prevented:**

- A malicious document can poison **vault content**: it can make the agent write misleading
  pages, spam `[[wikilinks]]`, or rewrite existing pages within the vault. This is inherent to
  autonomous ingest. The mitigation is versioning, not prevention: every agent run is exactly
  one git commit, so any run's damage is inspectable (`git show`) and revertable (`git revert`).
  Ingest material you have reason to distrust deserves a look at its commit afterwards.
- The dashboard renders vault markdown inertly (React elements only, `http(s)` links only), so
  poisoned content cannot become script execution in your browser — but it can still be
  *misinformation* that you read and believe.

## Operational hardening that the code enforces

- Upload filenames are reduced to a bare basename before staging; a `../`-carrying name cannot
  escape the vault's `.raw/` staging area.
- Incoming files are never executed; a magic-byte check refuses disguised executables; archives
  are not auto-extracted.
- URL ingestion has an SSRF guard: scheme allowlist, private/link-local/loopback address checks
  against the *resolved* addresses, socket pinning against DNS rebinding, and per-hop redirect
  re-validation.
- All shell-outs use `execFile` with argument arrays (no shell interpolation); git receives
  `--` before pathspecs.
- The wiki page API is confined to `VAULT_ROOT/wiki/*.md` and re-checked after `realpath`, so a
  symlink cannot become a read or write primitive outside the vault.
- The optional Telegram bot (SPEC.md §4.3) is outbound-only long polling - no listening port, the
  localhost bind is untouched. Authorization is a numeric user-id allowlist enforced before any
  other handling and fail-closed at startup (a token without an allowlist refuses to start);
  non-allowlisted senders receive no reply, since every accepted message can start a paid agent
  run. The bot token is handled like the Anthropic credential (env file only, redacted in config
  output, never in a logged URL or error). Files received via Telegram enter the same pipeline as
  uploads (basename reduction, magic-byte check, no execution); completion messages carry page
  titles only, never vault content.
- The optional retrieval index (SPEC.md §12.6) is built by running the vault's own scripts as
  child processes, **fully on-machine**: the service never passes the `--allow-egress` flag and
  additionally strips the Anthropic credential from the child environment, so chunk prefixes are
  synthetic (title + lead) and no page content leaves the box. The index is derived data written
  only under `.vault-meta/` and excluded from vault git. The two planned enhancements are gated:
  local reranking would talk only to a loopback ollama, and LLM-generated prefixes - the one step
  that *would* send page bodies to the Anthropic API - stay behind an explicit, default-off
  setting.

## Verifying the guarantees yourself

Two of the guarantees rest on SDK behaviour that unit tests cannot observe, so the repo ships
live probes. Run them after any SDK upgrade or change to the permission wiring:

```bash
VAULT_ROOT=~/vault npm run permprobe --workspace server   # expects: canary outside vault: blocked
VAULT_ROOT=/tmp/throwaway-vault npm run killprobe --workspace server
```

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's security advisories
("Report a vulnerability" on the repository's Security tab) rather than a public issue.
