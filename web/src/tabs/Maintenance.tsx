/**
 * Maintenance tab (SPEC.md §6.4): Lint (structured report) and a hot-cache refresh, plus the
 * domain registry/governance and the settings editor. Autoresearch lives in the Query/Chat
 * composer now (it deserved the prominent spot, not a maintenance corner). Runs are
 * async/job-style (TASKS-M5 §0): the POST returns a run id at once, we poll its result via
 * `GET /maintenance/runs/:id`, and the live log streams over the `maintenance:<kind>` SSE
 * channel (rendered via JobLog with seeding off).
 *
 * Layout: two columns on desktop — the agent-run tools left, settings right — instead of one
 * long single-column scroll. Every tool card shares the same anatomy: title + ⓘ tooltip,
 * a "last run" meta line (persistent facts from the vault, not this session), action top-right.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type {
  GraphNode,
  LintReport,
  MaintenanceResult,
  DomainCandidate,
  DomainReviewEntry,
  CandidatesResponse,
} from '../api/types.ts'
import { computeTagReport, conflictingTag, type TagReport } from '../lib/tagReport.ts'
import type { TagFixAction } from '../api/types.ts'

/** The tag-fix route's hard cap on actions per run — mirrored so the button says what runs. */
const MAX_TAG_ACTIONS = 20

/** Merge direction for a variant pair: fold the less common spelling into the more common one. */
const mergeDir = (v: { a: string; b: string; aCount: number; bCount: number }): [string, string] =>
  v.aCount <= v.bCount ? [v.a, v.b] : [v.b, v.a]

/** The concrete drop/merge actions for the currently-checked finding keys. */
function selectedActions(report: TagReport, selected: ReadonlySet<string>): TagFixAction[] {
  const actions: TagFixAction[] = []
  for (const v of report.variants) {
    const [from, to] = mergeDir(v)
    if (selected.has(`merge|${from}|${to}`)) actions.push({ kind: 'merge', from, to })
  }
  for (const e of report.domainEchoes) {
    if (e.domain !== 'unassigned' && selected.has(`drop|${e.tag}`)) actions.push({ kind: 'drop', tag: e.tag })
  }
  return actions
}
import { JobLog } from '../components/JobLog.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'
import { SettingsEditor } from '../components/SettingsEditor.tsx'
import { Tip } from '../components/Tip.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Icon } from '../components/Icon.tsx'
import { timeAgo } from '../lib/format.ts'
import { pageRoute, navigate } from '../lib/router.ts'

export function Maintenance(): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'

  const lint = useMaintenanceRun(() => api.lint())
  const lintFix = useMaintenanceRun(() => api.lintFix())
  const hot = useMaintenanceRun(() => api.hotCache())
  const backfill = useMaintenanceRun(() => api.domainBackfill())
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  // How much of the vault is still unfiled — the number that says whether a backfill is due.
  const undomained = graph.data?.nodes.filter((n) => n.domain === null).length ?? 0
  const totalPages = stats.data?.pages.total ?? 0
  const lastReport = stats.data?.lintReport ?? null

  return (
    <div className="maint">
      <div className="mcol">
        {/* Lint */}
        <div className="card card-pad">
          <div className="section-head">
            <h3 className="section-title">
              Lint — wiki health
              <Tip text="Finds orphans, dead links, stale claims and missing cross-links, then writes a report page into the vault (one commit). 'Fix safe findings' fixes only the mechanical categories from the newest report (frontmatter gaps, stub pages, missing wikilinks, stale index entries) — deletions, merges and contradictions stay yours." />
            </h3>
            <span className="right">
              <button
                className="btn"
                disabled={lint.running || lintFix.running || lastReport === null}
                onClick={lintFix.start}
                title={
                  lastReport === null
                    ? 'Run a lint first — the report is what bounds the fix run'
                    : 'Fix the mechanical findings of the newest report (one git commit — revertable)'
                }
              >
                {lintFix.running ? 'Fixing…' : 'Fix safe findings'}
              </button>
              <button className="btn primary" disabled={lint.running || lintFix.running} onClick={lint.start}>
                {lint.running ? 'Running…' : 'Start lint'}
              </button>
            </span>
          </div>
          <div className="tool-meta">
            {lastReport ? (
              <>
                Last report{lastReport.date ? ` ${lastReport.date}` : ''}:{' '}
                <a
                  href={pageRoute(lastReport.path)}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(pageRoute(lastReport.path))
                  }}
                >
                  open in vault viewer
                </a>
              </>
            ) : (
              <>No lint report in the vault yet.</>
            )}
          </div>
          {lint.running && <JobLog jobId="maintenance:lint" seed={false} />}
          {lint.error && <div className="toast err">{lint.error}</div>}
          {lintFix.running && <JobLog jobId="maintenance:lint-fix" seed={false} />}
          {lintFix.error && <div className="toast err">{lintFix.error}</div>}
          {lintFix.result && <RunResult result={lintFix.result} vaultName={vaultName} label="Fixed" />}
          {lint.result?.ok && lint.result.lint && (
            <LintView report={lint.result.lint} reportPath={lint.result.reportPath} vaultName={vaultName} />
          )}
          {lint.result?.ok && !lint.result.lint && lint.result.answer && (
            <div className="md-fallback">
              <Markdown source={lint.result.answer} />
            </div>
          )}
        </div>

        {/* Hot cache */}
        <div className="card card-pad">
          <div className="section-head">
            <h3 className="section-title">
              Hot cache
              <Tip
                text={
                  <>
                    Refreshes <code>wiki/hot.md</code> — the compact context every agent run reads first. A
                    fresh cache makes ingests faster and cheaper.
                  </>
                }
              />
            </h3>
            <button className="btn" disabled={hot.running} onClick={hot.start}>
              {hot.running ? 'Running…' : 'Refresh'}
            </button>
          </div>
          <div className="tool-meta">
            {/* "Anzeige des letzten Refresh-Zeitpunkts" (SPEC.md §6.4) — the file's mtime. */}
            {stats.data?.hotCacheUpdatedAt ? (
              <span title={new Date(stats.data.hotCacheUpdatedAt).toLocaleString('en-US')}>
                Last refresh {timeAgo(stats.data.hotCacheUpdatedAt)}
              </span>
            ) : (
              <span>Never refreshed.</span>
            )}
          </div>
          {hot.running && <JobLog jobId="maintenance:hot-cache" seed={false} />}
          {hot.error && <div className="toast err">{hot.error}</div>}
          {hot.result && <RunResult result={hot.result} vaultName={vaultName} label="Refreshed" />}
        </div>

        {/* Retrieval index (SPEC §12.6 stage 1) */}
        <RetrievalIndexCard />

        {/* Domain registry + backfill (SPEC §12.4 Stufe 2) */}
        <div className="card card-pad">
          <div className="section-head">
            <h3 className="section-title">
              Domains
              <Tip text="The meta-categories pages are filed under, maintained as a vault page. Every ingest gets this list as a closed set; when nothing fits, 'unassigned' is used. New domains are only ever created by you — never by an agent." />
            </h3>
            <button
              className="btn"
              disabled={backfill.running || !domains.data?.installed}
              onClick={backfill.start}
              title={domains.data?.installed ? 'File existing pages into domains (page content untouched)' : 'No registry installed'}
            >
              {backfill.running ? 'Running…' : 'Start backfill'}
            </button>
          </div>
          {domains.data?.installed === false ? (
            <p className="tab-hint">
              No domain registry in the vault. Create it with{' '}
              <code>scripts/install-domain-registry.sh</code> — afterwards it's editable as{' '}
              <PageLink path={domains.data.path} vaultName={vaultName} />.
            </p>
          ) : (
            <>
              <div className="tool-meta">
                Registry: {domains.data && <PageLink path={domains.data.path} vaultName={vaultName} />}
              </div>
              <div className="filters" style={{ marginTop: 10 }}>
                {domains.data?.domains.map((d) => (
                  <span key={d.key} className="chip" title={d.description}>
                    {d.key}
                  </span>
                ))}
              </div>
              {/* The backfill-is-due number as a bar, not a sentence buried in prose. */}
              {totalPages > 0 && (
                <div className="progress">
                  <span>
                    {totalPages - undomained} / {totalPages} pages filed
                  </span>
                  <span className="track" aria-hidden>
                    <span
                      className="fill"
                      style={{ width: `${Math.round(((totalPages - undomained) / totalPages) * 100)}%` }}
                    />
                  </span>
                  <span>
                    {undomained > 0 ? `${undomained} without domain` : 'all filed'}
                  </span>
                </div>
              )}
            </>
          )}
          {backfill.running && <JobLog jobId="maintenance:domain-backfill" seed={false} />}
          {backfill.error && <div className="toast err">{backfill.error}</div>}
          {backfill.result && <RunResult result={backfill.result} vaultName={vaultName} label="Filed" />}
          {domains.data?.installed && <DomainCandidates vaultName={vaultName} />}
        </div>

        {/* Tag hygiene (lint equivalent for tags + the bounded repair run) */}
        <TagHygieneCard nodes={graph.data?.nodes} vaultName={vaultName} />
      </div>

      <div className="mcol">
        <div className="card card-pad">
          <div className="section-head">
            <h3 className="section-title">
              Settings
              <Tip text="Values from the environment are the baseline; values set here override them persistently. Reset restores the environment value." />
            </h3>
          </div>
          <SettingsEditor />
        </div>
      </div>
    </div>
  )
}

/**
 * Tag hygiene: the deterministic, read-only lint equivalent for tags (level 2 of the tag
 * plan) — likely spelling variants, tags implied by another tag, tags that just echo a
 * domain, and single-use tags — plus the bounded repair (level 3): actionable findings get
 * a checkbox, "Fix selected" starts an agent run over exactly those drop/merge actions
 * (hard rule 1: the agent writes, one revertable commit). Variants repair as a merge into
 * the more common spelling; domain echoes as a drop — except echoes of the `unassigned`
 * bucket, which are missing DOMAINS, not redundancy, and get no checkbox.
 */
function TagHygieneCard({
  nodes,
  vaultName,
}: {
  nodes: readonly GraphNode[] | undefined
  vaultName: string
}): React.ReactElement | null {
  const qc = useQueryClient()
  const report = useMemo(() => (nodes !== undefined ? computeTagReport(nodes) : null), [nodes])
  const [showSingletons, setShowSingletons] = useState(false)
  /** Selected repair actions, keyed "merge|from|to" / "drop|tag" (stale keys simply no-op). */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const fix = useMaintenanceRun(() =>
    api.tagFix(
      (report === null ? [] : selectedActions(report, selected)).slice(0, MAX_TAG_ACTIONS),
    ),
  )
  // A finished fix changed frontmatter → the graph (and with it this report) is stale.
  const fixedOk = fix.result?.ok === true
  useEffect(() => {
    if (fixedOk) {
      setSelected(new Set())
      void qc.invalidateQueries({ queryKey: ['graph'] })
    }
  }, [fixedOk, qc])
  if (report === null) return null
  const actions = selectedActions(report, selected)
  // Two selected repairs fighting over one tag (e.g. two merges consuming the same tag)
  // would force the agent to guess an order — block the run until one is unchecked.
  const conflict = conflictingTag(actions)
  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const findingCount = report.variants.length + report.implications.length + report.domainEchoes.length
  const CAP = 8 // evidence, not an endless list — the counts carry the "how bad is it"
  return (
    <div className="card card-pad">
      <div className="section-head">
        <h3 className="section-title">
          Tags — hygiene
          <Tip text="Deterministic tag lint, computed from the live graph — the report itself writes nothing. Variants: two tags that look like spellings of the same thing (fix = merge into the more common one). Implied: a tag whose pages (almost) always carry another tag too (informational). Domain echoes: a tag that just repeats the page's domain (fix = drop it). Single-use: tags with exactly one page. 'Fix selected' runs an agent over exactly the checked actions — frontmatter tags only, one revertable git commit." />
        </h3>
        <button
          className="btn primary"
          disabled={actions.length === 0 || conflict !== null || fix.running}
          onClick={fix.start}
          title={
            actions.length === 0
              ? 'Check findings below to build the repair plan'
              : conflict !== null
                ? `Conflicting selections: #${conflict} appears in more than one repair — uncheck one`
                : `Apply ${Math.min(actions.length, MAX_TAG_ACTIONS)} tag repair${actions.length === 1 ? '' : 's'} (one git commit — revertable)`
          }
        >
          {fix.running ? 'Fixing…' : `Fix selected${actions.length > 0 ? ` (${Math.min(actions.length, MAX_TAG_ACTIONS)})` : ''}`}
        </button>
      </div>
      {conflict !== null && (
        <div className="toast err">
          Conflicting selections: <code>#{conflict}</code> appears in more than one checked repair. Uncheck one of them.
        </div>
      )}
      <div className="tool-meta">
        {report.distinctTags} distinct tags on {report.taggedPages} of {report.knowledgePages} knowledge pages
      </div>
      {findingCount === 0 && report.singletons.length === 0 ? (
        <p className="tab-hint">No findings — the tag set looks healthy.</p>
      ) : (
        <div className="tagrep">
          {report.variants.length > 0 && (
            <section>
              <h4>
                Likely variants <span className="cnt">{report.variants.length}</span>
              </h4>
              {report.variants.slice(0, CAP).map((v) => {
                const [, to] = mergeDir(v)
                const key = `merge|${mergeDir(v).join('|')}`
                return (
                  <label key={key} className="trow selectable">
                    <span className="pair">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => toggle(key)}
                        disabled={fix.running}
                        aria-label={`Merge into #${to}`}
                      />
                      <code>#{v.a}</code> <span className="sep">≈</span> <code>#{v.b}</code>
                    </span>
                    <span className="meta">
                      {v.aCount} + {v.bCount} pages
                      {v.both > 0 ? ` · ${v.both} carry both` : ''} · merge → <code>#{to}</code>
                    </span>
                  </label>
                )
              })}
              {report.variants.length > CAP && <div className="more">+{report.variants.length - CAP} more</div>}
            </section>
          )}
          {report.implications.length > 0 && (
            <section>
              <h4>
                Implied tags <span className="cnt">{report.implications.length}</span>
              </h4>
              {report.implications.slice(0, CAP).map((v) => (
                <div key={`${v.a}|${v.b}`} className="trow">
                  <span className="pair">
                    <code>#{v.a}</code> <span className="sep">{v.mutual === true ? '↔' : '→'}</span> <code>#{v.b}</code>
                  </span>
                  <span className="meta">
                    together on {v.both} of {v.aCount} pages
                  </span>
                </div>
              ))}
              {report.implications.length > CAP && (
                <div className="more">+{report.implications.length - CAP} more</div>
              )}
            </section>
          )}
          {report.domainEchoes.length > 0 && (
            <section>
              <h4>
                Domain echoes <span className="cnt">{report.domainEchoes.length}</span>
              </h4>
              {report.domainEchoes.slice(0, CAP).map((e) => {
                const missing = e.domain === 'unassigned'
                const key = `drop|${e.tag}`
                return (
                  <label key={`${e.tag}|${e.domain}`} className={`trow${missing ? '' : ' selectable'}`}>
                    <span className="pair">
                      {/* A tag blanketing the unassigned bucket isn't redundancy — it's the
                          domain those pages are waiting for. No drop offered. */}
                      {!missing && (
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => toggle(key)}
                          disabled={fix.running}
                          aria-label={`Drop #${e.tag}`}
                        />
                      )}
                      <code>#{e.tag}</code> <span className="sep">≙</span> <span className="dom">{e.domain}</span>
                    </span>
                    <span className="meta">
                      {e.inDomain} of {e.domainSize} pages in the domain · {e.tagCount} uses overall
                      {missing ? ' · likely a missing domain' : ' · drop'}
                    </span>
                  </label>
                )
              })}
              {report.domainEchoes.length > CAP && (
                <div className="more">+{report.domainEchoes.length - CAP} more</div>
              )}
            </section>
          )}
          {report.singletons.length > 0 && (
            <section>
              <h4>
                Single-use tags <span className="cnt">{report.singletons.length}</span>
                <button className="linklike" onClick={() => setShowSingletons((v) => !v)}>
                  {showSingletons ? 'hide' : 'show'}
                </button>
              </h4>
              {showSingletons && (
                <div className="filters">
                  {report.singletons.slice(0, 60).map((t) => (
                    <span key={t} className="chip">
                      #{t}
                    </span>
                  ))}
                  {report.singletons.length > 60 && <span className="more">+{report.singletons.length - 60} more</span>}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {fix.running && <JobLog jobId="maintenance:tag-fix" seed={false} />}
      {fix.error && <div className="toast err">{fix.error}</div>}
      {fix.result && <RunResult result={fix.result} vaultName={vaultName} label="Fixed" />}
    </div>
  )
}

/**
 * Retrieval-index card (SPEC §12.6 stage 1). The chunk/BM25 index the read-only query path uses
 * once provisioned — deterministic, no agent, no credential, so the rebuild button works in
 * setup mode too. Freshness is otherwise automatic (a debounced rebuild after each ingest); this
 * surfaces the state and a manual rebuild. A pre-v1.7 vault ships no scripts → the card explains
 * that instead of offering a build that would 409.
 */
function RetrievalIndexCard(): React.ReactElement {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['retrieve-index-status'], queryFn: api.retrieveIndexStatus })
  const build = useMaintenanceRun(() => api.retrieveIndex())

  // A settled build changes chunk count / provisioned state — refetch the status when it lands.
  useEffect(() => {
    if (build.result) void qc.invalidateQueries({ queryKey: ['retrieve-index-status'] })
  }, [build.result, qc])

  const s = status.data
  const missing = s !== undefined && !s.scriptsPresent

  return (
    <div className="card card-pad">
      <div className="section-head">
        <h3 className="section-title">
          Retrieval index
          <Tip
            text={
              <>
                Chunk-level hybrid retrieval (BM25 over contextualized chunks) for the Research/chat read
                path. Once built, questions are answered from the passages <code>retrieve.py</code> ranks
                instead of a page-title scan — better at facts buried mid-page. Rebuilds automatically after
                ingests; this is the manual trigger. Derived data only (kept out of vault git).
              </>
            }
          />
        </h3>
        {!missing && (
          <button className="btn" disabled={build.running} onClick={build.start}>
            {build.running ? 'Building…' : s?.provisioned ? 'Rebuild' : 'Build index'}
          </button>
        )}
      </div>

      {missing ? (
        <p className="tab-hint">
          This vault ships no <code>wiki-retrieve</code> scripts — it predates claude-obsidian v1.7. Nothing to
          index; the query path uses the classic hot-cache → index → pages read order.
        </p>
      ) : (
        <div className="tool-meta">
          {s === undefined ? (
            <span>Checking…</span>
          ) : s.provisioned ? (
            <span title={s.indexBuiltAt ? new Date(s.indexBuiltAt).toLocaleString('en-US') : undefined}>
              {s.chunkCount.toLocaleString('en-US')} chunks
              {s.indexBuiltAt ? <> · built {timeAgo(s.indexBuiltAt)}</> : null}
            </span>
          ) : (
            <span>Not built yet — the query path falls back to the classic read order until you build it.</span>
          )}
        </div>
      )}

      {build.running && <JobLog jobId="maintenance:retrieve-index" seed={false} />}
      {build.error && <div className="toast err">{build.error}</div>}
      {build.result?.ok && <div className="toast ok">{build.result.answer ?? 'Index rebuilt.'}</div>}
    </div>
  )
}

/**
 * The governance loop's UI (SPEC §12.4 Stufe 3). The candidate list itself is deterministic and
 * free, so it simply renders — no "start analysis" needed. The agent pass is opt-in via the
 * toggle: it only JUDGES what the finder already surfaced, and costs a real agent run.
 *
 * Creating a domain is deliberately a user action here; agents may never coin a key.
 */
function DomainCandidates({ vaultName }: { vaultName: string }): React.ReactElement | null {
  const qc = useQueryClient()
  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const [withAgent, setWithAgent] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const review = useMaintenanceRun(() => api.domainReview())

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['domain-candidates'] })
    void qc.invalidateQueries({ queryKey: ['domains'] })
    void qc.invalidateQueries({ queryKey: ['graph'] })
  }

  const data: CandidatesResponse | undefined = candidates.data
  if (!data) return null

  // Verdicts from the optional agent pass, keyed by candidate.
  const verdicts = new Map<string, DomainReviewEntry>(
    (review.result?.domainReview?.entries ?? []).map((e) => [e.candidate, e]),
  )

  const start = (): void => {
    if (withAgent) review.start()
    else refresh()
  }

  return (
    <div className="domain-candidates">
      <div className="section-head">
        <h4 className="section-title">Candidates for new domains</h4>
        <div className="candidate-actions">
          <label className="toggle" title="Additionally have an agent judge the candidates (costs one run)">
            <input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} />
            With agent review
          </label>
          <button className="btn" disabled={review.running || (withAgent && data.candidates.length === 0)} onClick={start}>
            {review.running ? 'Running…' : 'Check candidates'}
          </button>
        </div>
      </div>

      <p className="tab-hint">
        Topics among the <code>unassigned</code> pages large enough for a domain of their own ({data.threshold}+
        pages). {data.unassignedCount} page{data.unassignedCount === 1 ? '' : 's'} without a fitting domain.
        {data.undomainedCount > 0 && (
          <>
            {' '}
            <strong>{data.undomainedCount}</strong> page{data.undomainedCount === 1 ? '' : 's'} carry no domain
            field at all — that's what the backfill is for; until then this analysis is incomplete.
          </>
        )}
      </p>

      {review.running && <JobLog jobId="maintenance:domain-review" seed={false} />}
      {review.error && <div className="toast err">{review.error}</div>}
      {review.result && !review.result.domainReview && review.result.answer && (
        <div className="md-fallback">
          <Markdown source={review.result.answer} />
        </div>
      )}

      {data.candidates.length === 0 ? (
        <p className="empty-inline">
          No candidates. New domains emerge once enough thematically related pages accumulate that no existing
          domain fits.
        </p>
      ) : (
        <div className="candidate-list">
          {data.candidates.map((c) => (
            <CandidateCard
              key={c.key}
              candidate={c}
              verdict={verdicts.get(c.key)}
              vaultName={vaultName}
              editing={editing === c.key}
              onEdit={() => setEditing(editing === c.key ? null : c.key)}
              onDone={() => {
                setEditing(null)
                refresh()
              }}
            />
          ))}
        </div>
      )}

      {data.dismissed.length > 0 && (
        <p className="tab-hint">
          Dismissed:{' '}
          {data.dismissed.map((d, i) => (
            <span key={d.key}>
              {i > 0 && ', '}
              <button
                className="linkish"
                title="Propose again"
                onClick={() => void api.restoreCandidate(d.key).then(refresh)}
              >
                {d.key}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

const VERDICT_LABEL: Record<string, string> = {
  'new-domain': 'Agent: own domain',
  existing: 'Agent: belongs to an existing domain',
  'not-a-domain': 'Agent: not a domain',
}

function CandidateCard({
  candidate,
  verdict,
  vaultName,
  editing,
  onEdit,
  onDone,
}: {
  candidate: DomainCandidate
  verdict: DomainReviewEntry | undefined
  vaultName: string
  editing: boolean
  onEdit: () => void
  onDone: () => void
}): React.ReactElement {
  // The agent's proposal pre-fills the form when it has one; otherwise the candidate tag does.
  const [key, setKey] = useState(verdict?.key ?? candidate.key)
  const [description, setDescription] = useState(verdict?.description ?? '')
  const [tags, setTags] = useState((verdict?.tags ?? candidate.tags).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = (): void => {
    setBusy(true)
    setError(null)
    void api
      .createDomain({
        key: key.trim().toLowerCase(),
        description: description.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        dismissCandidate: candidate.key,
      })
      .then(onDone)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <div className="candidate card card-pad">
      <div className="candidate-head">
        <strong>{candidate.key}</strong>
        <span className="candidate-meta">
          {candidate.pageCount} pages · {Math.round(candidate.cohesion * 100)}% linked
        </span>
        {verdict && <span className={`chip verdict-${verdict.verdict}`}>{VERDICT_LABEL[verdict.verdict]}</span>}
      </div>

      {candidate.tags.length > 1 && <p className="tab-hint">Tags: {candidate.tags.join(', ')}</p>}
      {verdict?.reason && <p className="tab-hint">{verdict.reason}</p>}
      {verdict?.verdict === 'existing' && verdict.existing && (
        <p className="tab-hint">
          Suggestion: file these pages under <code>{verdict.existing}</code> — edit the pages or run a
          backfill to do so.
        </p>
      )}

      <PageLinks paths={candidate.pages.map((p) => p.path)} vaultName={vaultName} />

      {editing ? (
        <div className="candidate-form">
          <label>
            Key
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. history" />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this domain cover?"
            />
          </label>
          <label>
            Tags (comma-separated)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          {error && <div className="toast err">{error}</div>}
          <div className="candidate-actions">
            <button className="btn primary" disabled={busy || !key.trim() || !description.trim()} onClick={create}>
              {busy ? 'Creating…' : 'Create domain'}
            </button>
            <button className="btn ghost" onClick={onEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="candidate-actions">
          <button className="btn" onClick={onEdit}>
            Create as domain
          </button>
          <button
            className="btn ghost"
            title="Stop proposing this"
            onClick={() => void api.dismissCandidate(candidate.key).then(onDone)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

function LintView({ report, reportPath, vaultName }: { report: LintReport; reportPath: string | undefined; vaultName: string }): React.ReactElement {
  return (
    <div>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        {Object.entries(report.summary).map(([k, v]) => (
          <div key={k} className="stat card">
            <div className="value">{v}</div>
            <div className="sub">{k}</div>
          </div>
        ))}
      </div>
      {report.totalFindings === 0 ? (
        <div className="empty">
          <Icon name="check" /> No findings — the wiki is clean.
        </div>
      ) : (
        report.sections.map((s) => (
          <div key={s.title} className="lint-section">
            <h4>
              {s.title} <span className="count">{s.findings.length}</span>
            </h4>
            <ul className="lint-findings">
              {s.findings.map((f, i) => (
                <li key={i}>
                  {f.page?.path ? <PageLink vaultName={vaultName} path={f.page.path} /> : f.page ? <strong>{f.page.label}</strong> : null}
                  <span className="lint-text">{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {reportPath && (
        <div className="job-meta" style={{ marginTop: 8 }}>
          <span>Report: <code>{reportPath}</code></span>
        </div>
      )}
    </div>
  )
}

function RunResult({ result, vaultName, label }: { result: MaintenanceResult; vaultName: string; label: string }): React.ReactElement {
  if (!result.ok) return <div className="toast err">{result.error ?? 'Failed'}</div>
  return (
    <div className="toast ok">
      {label}
      {result.pages.length > 0 ? <PageLinks vaultName={vaultName} paths={result.pages} /> : <> — no changes.</>}
    </div>
  )
}
