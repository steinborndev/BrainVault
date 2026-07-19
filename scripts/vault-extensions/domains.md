---
type: meta
title: "Domain Registry"
created: 2026-07-19
updated: 2026-07-19
tags:
  - meta
  - domains
status: evergreen
related:
  - "[[index]]"
---

# Domain Registry

The list of meta-categories this wiki uses. Every page carries exactly one of these keys in
its `domain:` frontmatter field, which is what the dashboard's graph view filters and colors
by. This page is the single source of truth for that list: the ingestion service reads it and
tells every ingest run to assign a domain from it.

**This page is the contract, not a suggestion.** An ingest may only pick a key listed under
"Domains" below, or `unassigned` when nothing fits. It must never invent a new key — that is
how the field drifted before this registry existed (`mrna-delivery` and `drug-delivery` were
both filed as domains, at a different altitude than `cooking`).

## How a new domain is born

Pages that fit nothing get `domain: unassigned`. They stay fully visible and searchable —
`unassigned` is a normal bucket in the graph view, not a hole. When enough of them accumulate
around a shared theme (rule of thumb: **five or more** coherent pages), that is the evidence
that a real domain has formed, and a new key gets added to this page. Adding it is a human
decision; the service only surfaces the candidates. One or two stray pages are not a domain.

To add one: append a `## <key>` section below, in the same shape as the others, then run the
domain backfill from the dashboard's Wartung tab so existing pages get re-sorted.

## Conventions

- Keys are lowercase, hyphenated, singular in spirit, and broad — a domain is a shelf, not a
  book. Prefer `finance` over `investment-funds`.
- Keep them at a comparable altitude. If one key would sit inside another, it is a tag, not a
  domain.
- The tag lists below are *guidance for classification*, not a lookup table. A page whose tags
  match nothing may still clearly belong to a domain; judge by what the page is about.
- Entity-shaped tags (`person`, `organization`, `product`, `researcher`) say what a page *is*,
  not what it is *about*. Never classify by those.

## Domains

## biomedicine

Biology, medicine, pharmacology and drug delivery: mRNA therapeutics, lipid nanoparticles,
vaccines, formulation and the cell biology around them.

**Tags:** `mrna-delivery`, `biomedical`, `drug-delivery`, `lipid-nanoparticle`,
`endosomal-escape`, `pharmaceutics`, `vaccine`, `rna-engineering`, `lipid-chemistry`,
`covid-19`, `dragonscale`, `immunology`

## finance

Money, markets and their regulation: investment funds, securities, costs and fees, banking
rules, and consumer-facing financial guidance.

**Tags:** `german-finance`, `investment-funds`, `finance`, `banking`, `regulation`,
`securities`

## cooking

Food and drink: recipes, techniques, ingredients, and coffee.

**Tags:** `cooking`, `recipe`, `food`, `coffee`, `ingredient`

## knowledge-management

How knowledge itself is captured, structured and compounded: the LLM-wiki pattern, hot
caches, note-taking method, and the theory behind this vault.

**Tags:** `knowledge-management`, `llm-wiki`, `llm-wiki-pattern`, `compounding-knowledge`,
`methodology`, `cherry-picks`

## ai-tooling

The AI tooling ecosystem as a subject: Claude and its plugins, claude-obsidian and its
siblings, the repos and communities around them, and the SEO tooling built on top.

**Tags:** `claude`, `claude-obsidian`, `claude-ecosystem`, `claude-seo`, `github-repo`,
`github`, `ecosystem`, `community`, `seo`, `competitive-analysis`, `llm`, `agent`

## meta

The wiki's own machinery rather than a subject: index and overview pages, the hot cache, the
log, session records, folds, lint reports, and this page. Reserved — reach for it only when a
page is vault infrastructure.

**Tags:** `meta`, `index`, `hot-cache`, `session`, `fold`
