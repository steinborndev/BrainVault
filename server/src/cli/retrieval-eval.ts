/**
 * Retrieval quality harness (TASKS-RETRIEVE check 1).
 *
 * Answers the question the anecdotes could not: how often does chunk retrieval actually put the
 * right page in front of the agent? Findings F-R6/F-R7 measured single questions and were either
 * confounded (prompt-cache-dominated token counts) or n=1 — this replaces both with a labeled set
 * and a hit rate, and it is the baseline any future retrieval change (stage 3, a different
 * chunker, another reranker) must beat.
 *
 * It calls the SAME `retrieveCandidates` the query path uses, so what it measures is production
 * behaviour, not a reimplementation. Two configurations are reported side by side — BM25 only vs
 * BM25 + semantic rerank — so the rerank stage's actual contribution is visible rather than
 * assumed.
 *
 * The dataset is deliberately NOT in this repo: its questions and expected paths are vault
 * content, and this repo is public (hard rule 7). Point `--data` at a JSONL file, one object per
 * line:
 *   {"id":"…","difficulty":"easy|medium|hard","question":"…","expected":["wiki/…md", …],"note":"…"}
 * `expected` may list several acceptable pages (a synthesis page and its source both count).
 *
 *   npm run retrieval-eval --workspace server -- --data ~/.local/share/vault-service/retrieval-eval.jsonl
 */

import fs from 'node:fs'
import path from 'node:path'
import { retrieveCandidates, isRetrieveProvisioned } from '../pipeline/retrieve-index.js'

interface EvalCase {
  readonly id: string
  readonly question: string
  readonly expected: readonly string[]
  readonly difficulty: string
  readonly note?: string
}

interface CaseOutcome {
  readonly id: string
  readonly difficulty: string
  /** 1-based rank of the first expected page, or 0 when it was not returned at all. */
  readonly hitRank: number
  readonly returned: number
}

interface Summary {
  readonly label: string
  readonly outcomes: readonly CaseOutcome[]
}

const TOP_K = 5

function parseArgs(argv: readonly string[]): { data: string; topK: number } {
  let data = ''
  let topK = TOP_K
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') data = argv[++i] ?? ''
    else if (argv[i] === '--top') topK = Number(argv[++i] ?? TOP_K)
  }
  return { data, topK }
}

function loadCases(file: string): EvalCase[] {
  const raw = fs.readFileSync(file, 'utf8')
  const cases: EvalCase[] = []
  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    let parsed: Partial<EvalCase>
    try {
      parsed = JSON.parse(trimmed) as Partial<EvalCase>
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`)
    }
    if (!parsed.question || !Array.isArray(parsed.expected) || parsed.expected.length === 0) {
      throw new Error(`line ${i + 1}: needs "question" and a non-empty "expected" array`)
    }
    cases.push({
      id: parsed.id ?? `case-${i + 1}`,
      question: parsed.question,
      expected: parsed.expected,
      difficulty: parsed.difficulty ?? 'unrated',
      ...(parsed.note ? { note: parsed.note } : {}),
    })
  })
  return cases
}

async function runConfig(
  vaultRoot: string,
  cases: readonly EvalCase[],
  topK: number,
  rerank: boolean,
  label: string,
): Promise<Summary> {
  const outcomes: CaseOutcome[] = []
  for (const c of cases) {
    const { candidates } = await retrieveCandidates({
      vaultRoot,
      question: c.question,
      topK,
      rerank,
    })
    // Rank of the first candidate matching ANY accepted page; 0 = miss.
    const hitRank = candidates.findIndex((cand) => c.expected.includes(cand.pagePath)) + 1
    outcomes.push({ id: c.id, difficulty: c.difficulty, hitRank, returned: candidates.length })
  }
  return { label, outcomes }
}

const pct = (n: number, total: number): string =>
  total === 0 ? '  n/a' : `${((n / total) * 100).toFixed(0).padStart(3)}%`

function report(summaries: readonly Summary[], cases: readonly EvalCase[]): void {
  const difficulties = [...new Set(cases.map((c) => c.difficulty))]

  console.log('\n=== Retrieval quality ===')
  console.log(`cases: ${cases.length}  (${difficulties.map((d) => `${d}: ${cases.filter((c) => c.difficulty === d).length}`).join(', ')})\n`)

  const header = ['metric'.padEnd(22), ...summaries.map((s) => s.label.padStart(18))].join('')
  console.log(header)
  console.log('-'.repeat(header.length))

  const row = (name: string, pick: (s: Summary) => string): void =>
    console.log([name.padEnd(22), ...summaries.map((s) => pick(s).padStart(18))].join(''))

  const top1 = (s: Summary): number => s.outcomes.filter((o) => o.hitRank === 1).length
  const top5 = (s: Summary): number => s.outcomes.filter((o) => o.hitRank > 0).length
  const missed = (s: Summary): number => s.outcomes.filter((o) => o.hitRank === 0).length

  row('top-1', (s) => `${top1(s)}/${cases.length}  ${pct(top1(s), cases.length)}`)
  row(`top-${TOP_K} (any rank)`, (s) => `${top5(s)}/${cases.length}  ${pct(top5(s), cases.length)}`)
  row('missed entirely', (s) => `${missed(s)}`)

  console.log('')
  for (const d of difficulties) {
    const n = cases.filter((c) => c.difficulty === d).length
    row(`  top-5 · ${d}`, (s) => {
      const hit = s.outcomes.filter((o) => o.difficulty === d && o.hitRank > 0).length
      return `${hit}/${n}  ${pct(hit, n)}`
    })
  }

  // Per-case ranks: with a set this small, the aggregate hides whether a config is
  // systematically better or just shuffling within noise. `-` = not returned at all.
  console.log('\nper-case rank (lower is better, - = missed):')
  const idW = Math.max(...cases.map((c) => c.id.length), 4)
  console.log(
    ['case'.padEnd(idW), 'diff'.padEnd(8), ...summaries.map((s) => s.label.padStart(16)), '  delta'].join(''),
  )
  for (const c of cases) {
    const ranks = summaries.map((s) => s.outcomes.find((o) => o.id === c.id)?.hitRank ?? 0)
    const first = ranks[0] ?? 0
    const last = ranks[ranks.length - 1] ?? 0
    // Only meaningful between the two configs we actually run; a miss counts as worst.
    const score = (r: number): number => (r === 0 ? 99 : r)
    const delta = score(last) - score(first)
    const mark = delta < 0 ? `  better(${delta})` : delta > 0 ? `  WORSE(+${delta})` : ''
    console.log(
      [
        c.id.padEnd(idW),
        c.difficulty.padEnd(8),
        ...ranks.map((r) => (r === 0 ? '-' : String(r)).padStart(16)),
        mark,
      ].join(''),
    )
  }
  console.log('')
}

async function main(): Promise<void> {
  const vaultRoot = process.env['VAULT_ROOT']
  if (!vaultRoot) throw new Error('set VAULT_ROOT')
  const { data, topK } = parseArgs(process.argv.slice(2))
  if (data === '') throw new Error('pass --data <dataset.jsonl> (kept outside this repo — it is vault content)')
  if (!isRetrieveProvisioned(vaultRoot)) {
    throw new Error('retrieval index not provisioned — build it first (POST /api/v1/maintenance/retrieve-index)')
  }

  const cases = loadCases(path.resolve(data.replace(/^~/, process.env['HOME'] ?? '~')))
  console.log(`evaluating ${cases.length} case(s) against ${vaultRoot} …`)

  // BM25 first, then the production configuration, so the report reads left-to-right as
  // "what the baseline gets" → "what production gets".
  const bm25 = await runConfig(vaultRoot, cases, topK, false, 'BM25 only')
  const reranked = await runConfig(vaultRoot, cases, topK, true, 'BM25 + rerank')
  report([bm25, reranked], cases)
}

main().catch((err: unknown) => {
  console.error(`retrieval-eval failed: ${(err as Error).message}`)
  process.exit(1)
})
