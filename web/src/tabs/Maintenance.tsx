/**
 * Health screen (SPEC.md §6.4 + §12.7, redesign 2026-08): the status head is the primary
 * surface, the guided run walks the open items, the tool cards are the per-area escape
 * hatch. Settings lives on its own screen now. Runs are async/job-style (TASKS-M5 §0):
 * the POST returns a run id at once, we poll `GET /maintenance/runs/:id`, and the live log
 * streams over the `maintenance:<kind>` SSE channel (JobLog with seeding off).
 *
 * Every tool card shares the same anatomy: title + ⓘ tooltip, a "last run" meta line
 * (persistent facts from the vault, not this session), action top-right.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
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
import { computeTagReport, conflictingTag, recommendedKeys, MAX_TAG_ACTIONS, type TagReport } from '../lib/tagReport.ts'
import { draftDomainDescription } from '../lib/domainDraft.ts'
import type { TagFixAction } from '../api/types.ts'

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
import { Tip } from '../components/Tip.tsx'
import { useMaintenanceRun, type MaintenanceRunState } from '../hooks/useMaintenanceRun.ts'
import { useMaintenanceStatus, type MaintenanceStatusData } from '../hooks/useMaintenanceStatus.ts'
import { buildRunPlan, type MaintStatusItem, type RunPlanStep, type RunStepId } from '../lib/maintenanceStatus.ts'
import { Icon } from '../components/Icon.tsx'
import { timeAgo } from '../lib/format.ts'
import { runTitle } from '../lib/runLabels.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'
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
  // How much of the vault is still unfiled - the number that says whether a backfill is due.
  const undomained = graph.data?.nodes.filter((n) => n.domain === null).length ?? 0
  const totalPages = stats.data?.pages.total ?? 0
  const lastReport = stats.data?.lintReport ?? null

  // The status head is the screen's primary surface (SPEC §12.7). Below it there are four
  // views: 'overview' (head + run history), one focused card (a status item was clicked -
  // show exactly the tool that item is about), 'all' (every card), or the guided run
  // (Stufe c) replacing everything while it walks the plan.
  const [view, setView] = useState<'overview' | 'all' | string>('overview')
  const [runPlan, setRunPlan] = useState<RunPlanStep[] | null>(null)
  const maintStatus = useMaintenanceStatus()
  const statusData = maintStatus.data
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  // Setup mode only disables the run button here - the credential entry lives in Settings
  // now (its own screen), so this tab no longer has to force-open anything to reach it.
  const setupMode = health.data !== undefined && !health.data.credentialConfigured
  const showCard = (anchor: string): boolean => view === 'all' || view === anchor

  if (view === 'run' && runPlan !== null) {
    return (
      <GuidedRun
        plan={runPlan}
        vaultName={vaultName}
        onExit={() => {
          setRunPlan(null)
          setView('overview')
        }}
      />
    )
  }

  return (
    <>
      <div className={view === 'overview' ? 'health-grid' : ''}>
      <StatusHead
        data={statusData}
        failed={maintStatus.failed}
        onRetry={maintStatus.retry}
        allShown={view === 'all'}
        setupMode={setupMode}
        onToggleTools={() => setView(view === 'all' ? 'overview' : 'all')}
        onJump={(anchor) => setView(anchor)}
        onStartRun={() => {
          const plan = statusData !== null ? buildRunPlan(statusData.status) : []
          if (plan.length > 0) {
            setRunPlan(plan)
            setView('run')
          }
        }}
      />
      {view === 'overview' && <RunHistory data={statusData} />}
      </div>
      {view !== 'overview' && view !== 'all' && (
        <div className="focus-bar">
          <button className="linkish" onClick={() => setView('overview')}>
            ← Back to what&apos;s due
          </button>
          <button className="linkish" onClick={() => setView('all')}>
            All tools
          </button>
        </div>
      )}
      {view !== 'overview' && (
      <div className="maint single">
      <div className="mcol">
        {/* Lint */}
        {showCard('card-lint') && (
        <div className="card card-pad" id="card-lint">
          <div className="section-head">
            <h3 className="section-title">
              Lint - wiki health
              <Tip text="Finds orphans, dead links, stale claims and missing cross-links, then writes a report page into the vault (one commit). 'Fix safe findings' fixes only the mechanical categories from the newest report (frontmatter gaps, stub pages, missing wikilinks, stale index entries) - deletions, merges and contradictions stay yours." />
            </h3>
            <span className="right">
              <button
                className="btn"
                disabled={lint.running || lintFix.running || lastReport === null}
                onClick={lintFix.start}
                title={
                  lastReport === null
                    ? 'Run a lint first - the report is what bounds the fix run'
                    : 'Fix the mechanical findings of the newest report (one git commit - revertable)'
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
          {lastReport !== null && !lint.running && lint.result === undefined && (
            <ReportPeek path={lastReport.path} />
          )}
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
        )}

        {/* Hot cache */}
        {showCard('card-hot-cache') && (
        <div className="card card-pad" id="card-hot-cache">
          <div className="section-head">
            <h3 className="section-title">
              Hot cache
              <Tip
                text={
                  <>
                    Refreshes <code>wiki/hot.md</code> - the compact context every agent run reads first. A
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
            {/* "Anzeige des letzten Refresh-Zeitpunkts" (SPEC.md §6.4) - the file's mtime. */}
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
          {/* The cache's content, moved off Home (2026-08-25): it is a maintenance artifact,
              and it belongs next to the button that refreshes it rather than costing the
              dashboard's landing screen a collapsible panel you had to scroll past. */}
          {stats.data?.hotCache && (
            <details className="hot-cache">
              <summary>Show what the cache contains</summary>
              <Markdown source={stats.data.hotCache} />
            </details>
          )}
        </div>
        )}

        {/* Retrieval index (SPEC §12.6 stage 1) */}
        {showCard('card-index') && <RetrievalIndexCard />}

        {/* Domain registry + backfill (SPEC §12.4 Stufe 2) */}
        {showCard('card-domains') && (
        <div className="card card-pad" id="card-domains">
          <div className="section-head">
            <h3 className="section-title">
              Domains
              <Tip text="The meta-categories pages are filed under, maintained as a vault page. Every ingest gets this list as a closed set; when nothing fits, 'unassigned' is used. New domains are only ever created by you - never by an agent." />
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
              <code>scripts/install-domain-registry.sh</code> - afterwards it's editable as{' '}
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
          {domains.data?.installed && (
            <DomainCandidates
              vaultName={vaultName}
              onStartBackfill={backfill.start}
              backfillRunning={backfill.running}
            />
          )}
        </div>
        )}

        {/* Tag hygiene (lint equivalent for tags + the bounded repair run) */}
        {showCard('card-tags') && <TagHygieneCard nodes={graph.data?.nodes} vaultName={vaultName} />}
      </div>
      </div>
      )}
    </>
  )
}

/**
 * The "what's due" head (SPEC §12.7 Stufe b): the deterministic status model rendered as a
 * prioritized list - severity chip, WHAT, WHY NOW, COST - as the tab's PRIMARY surface.
 * Clicking an item focuses exactly the tool it is about (one concern per screen); the
 * Expert-tools toggle shows every card. Healthy areas collapse into one line so an
 * all-green tab reads as exactly that.
 */
function StatusHead({
  data,
  failed,
  onRetry,
  allShown,
  setupMode,
  onToggleTools,
  onJump,
  onStartRun,
}: {
  data: MaintenanceStatusData | null
  failed: boolean
  onRetry: () => void
  allShown: boolean
  setupMode: boolean
  onToggleTools: () => void
  onJump: (anchor: string) => void
  onStartRun: () => void
}): React.ReactElement {
  const [showHealthy, setShowHealthy] = useState(false)

  if (data === null) {
    // A failed input query must offer a way out - not spin as "Checking…" forever.
    return (
      <div className="card card-pad maint-status">
        <div className="section-head">
          <h3 className="section-title">What&apos;s due</h3>
        </div>
        {failed ? (
          <div className="tool-meta">
            Could not derive the vault status.{' '}
            <button className="btn" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : (
          <div className="tool-meta">Checking vault status…</div>
        )}
      </div>
    )
  }

  const { status, lastRuns } = data
  const open = status.items.filter((i) => i.severity !== 'healthy')
  const healthy = status.items.filter((i) => i.severity === 'healthy')
  const allHealthy = open.length === 0
  // The button renders only when the plan builder would actually produce steps - an item
  // set of registry/index-only work used to leave an enabled button that did nothing.
  const planSize = buildRunPlan(status).length

  return (
    <div className="card card-pad maint-status">
      <div className="section-head">
        <h3 className="section-title">
          What&apos;s due
          <Tip text="Deterministic check over data the dashboard already has (graph, candidates, tag report, report/cache/index age) - computing it costs nothing. 'Due' blocks other maintenance or degrades quality; 'soon' is worth doing soon; everything else is explicitly healthy. Click an item to focus exactly that tool; 'All tools' shows every card." />
        </h3>
        <span className="right ms-actions">
          <span className="ms-counts">
            {status.due > 0 && <span className="sev due">{status.due} due</span>}
            {status.recommended > 0 && <span className="sev rec">{status.recommended} soon</span>}
            <span className="sev ok">{status.healthy} healthy</span>
          </span>
          <button className="btn" onClick={onToggleTools}>
            {allShown ? 'Hide all tools' : 'All tools'}
          </button>
          {planSize > 0 && (
            <button
              className="btn primary"
              disabled={setupMode}
              onClick={onStartRun}
              title={
                setupMode
                  ? 'Configure a credential first (Settings)'
                  : 'Work through the open items in order - automatic steps run on their own, the run stops only where your judgement is needed'
              }
            >
              Start guided run
            </button>
          )}
        </span>
      </div>

      {allHealthy ? (
        <div className="empty">
          <Icon name="check" /> Everything healthy - nothing is due right now.
        </div>
      ) : (
        <div className="ms-items">
          {open.map((item) => (
            <StatusItem key={item.id} item={item} lastRun={lastRunLabel(item, lastRuns)} onJump={onJump} />
          ))}
        </div>
      )}

      {!allHealthy && healthy.length > 0 && (
        <button className="linkish ms-healthy-toggle" onClick={() => setShowHealthy((v) => !v)}>
          {showHealthy ? 'hide' : 'show'} {healthy.length} healthy area{healthy.length === 1 ? '' : 's'}
        </button>
      )}
      {showHealthy && !allHealthy && (
        <div className="ms-items ms-items-healthy">
          {healthy.map((item) => (
            <StatusItem key={item.id} item={item} lastRun={lastRunLabel(item, lastRuns)} onJump={onJump} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Restart-proof "last run" line for areas whose outcome no vault file captures. */
function lastRunLabel(
  item: MaintStatusItem,
  lastRuns: ReadonlyMap<string, { ok: boolean; finishedAt: string }>,
): string | null {
  const kind = item.id === 'backfill' ? 'domain-backfill' : item.id === 'tags' ? 'tag-fix' : null
  if (kind === null) return null
  const last = lastRuns.get(kind)
  if (last === undefined) return null
  return `last run ${timeAgo(last.finishedAt)}${last.ok ? '' : ' (failed)'}`
}

function StatusItem({
  item,
  lastRun,
  onJump,
}: {
  item: MaintStatusItem
  lastRun: string | null
  onJump: (anchor: string) => void
}): React.ReactElement {
  return (
    <button className="ms-item" onClick={() => onJump(item.anchor)} title="Open the tool for this">
      <span className={`sev ${item.severity === 'due' ? 'due' : item.severity === 'recommended' ? 'rec' : 'ok'}`}>
        {item.severity === 'recommended' ? 'soon' : item.severity}
      </span>
      <span className="ms-main">
        <span className="ms-title">{item.title}</span>
        <span className="ms-why">
          {item.why}
          {lastRun !== null && <span className="ms-last"> · {lastRun}</span>}
        </span>
      </span>
      <span className="ms-cost">{item.cost}</span>
    </button>
  )
}

/**
 * The persisted lint report, collapsed under the lint card (redesign 2026-08): "Fix safe
 * findings" is bounded by exactly this report, so its evidence must be visible where the
 * consent happens - not one navigation away. Loaded lazily on first expand.
 */
function ReportPeek({ path }: { path: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const page = useQuery({
    queryKey: ['page-preview', path],
    queryFn: () => api.page(path),
    enabled: open,
    staleTime: 60_000,
  })
  return (
    <details
      className="report-peek"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>Show the report this fix run is bounded by</summary>
      {page.isLoading && <div className="empty">Loading report…</div>}
      {page.isError && <div className="toast err">Could not load the report: {(page.error as Error).message}</div>}
      {page.data !== undefined && (
        <div className="report-body md-fallback">
          <Markdown source={page.data.markdown} />
          {page.data.truncated && <p className="tab-hint">Truncated - open the full page in the vault viewer.</p>}
        </div>
      )}
    </details>
  )
}

/**
 * Run history (redesign 2026-08): the restart-proof last settle per run kind, with outcome
 * and page count - receipts for what maintenance actually did. One row per kind (the runner
 * keeps no deeper history yet; a persistent run log is a server extension).
 */
function RunHistory({ data }: { data: MaintenanceStatusData | null }): React.ReactElement {
  const runs = [...(data?.lastRuns.values() ?? [])].sort(
    (a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt),
  )
  return (
    <div className="card card-pad run-history">
      <div className="section-head">
        <h3 className="section-title">
          Last runs
          <Tip text="The most recent settle per run kind, restart-proof (SPEC 12.7 Stufe b). Vault facts (report date, cache age) stay the primary source; this covers the areas no vault file captures." />
        </h3>
      </div>
      {runs.length === 0 ? (
        <div className="empty">No maintenance runs recorded yet.</div>
      ) : (
        <div className="run-rows">
          {runs.map((r) => (
            <div key={r.kind} className="run-row">
              <span className={`sev ${r.ok ? 'ok' : 'due'}`}>{r.ok ? 'ok' : 'failed'}</span>
              <span className="rr-main">
                <span className="rr-title">{runTitle(r.kind, r.ok)}</span>
                {r.error !== null && <span className="rr-err">{r.error}</span>}
              </span>
              <span className="rr-meta">
                {r.pages > 0 ? `${r.pages} page${r.pages > 1 ? 's' : ''} · ` : ''}
                {timeAgo(r.finishedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Tag hygiene: the deterministic, read-only lint equivalent for tags (level 2 of the tag
 * plan) - likely spelling variants, tags implied by another tag, tags that just echo a
 * domain, and single-use tags - plus the bounded repair (level 3): actionable findings get
 * a checkbox, "Fix selected" starts an agent run over exactly those drop/merge actions
 * (hard rule 1: the agent writes, one revertable commit). Variants repair as a merge into
 * the more common spelling; domain echoes as a drop - except echoes of the `unassigned`
 * bucket, which are missing DOMAINS, not redundancy, and get no checkbox.
 *
 * SPEC §12.7 Stufe a: the conflict-free recommendation is PREselected (uncheck to
 * disagree), every row carries a plain-language reason, and the non-actionable findings
 * (implications, singletons) are collapsed under "Observations" so they stay visible
 * without inflating the decision surface.
 */
function TagHygieneCard({
  nodes,
  vaultName,
  onFixed,
}: {
  nodes: readonly GraphNode[] | undefined
  vaultName: string
  /** Guided run (SPEC §12.7 Stufe c): reports an applied fix (committed pages) to the wizard. */
  onFixed?: (pages: readonly string[]) => void
}): React.ReactElement | null {
  const qc = useQueryClient()
  const report = useMemo(() => (nodes !== undefined ? computeTagReport(nodes) : null), [nodes])
  /** Selected repair actions, keyed "merge|from|to" / "drop|tag" (stale keys simply no-op). */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // The recommendation is preselected (SPEC §12.7 Stufe a): the user unchecks instead of
  // building the plan. Re-preselect only when the set of recommendable actions actually
  // changes (fresh findings after a fix run) - a mere refetch with identical findings must
  // not undo the user's unchecking.
  const recommended = useMemo(() => (report === null ? null : recommendedKeys(report, MAX_TAG_ACTIONS)), [report])
  const preselectSig = useRef<string | null>(null)
  useEffect(() => {
    if (recommended === null) return
    const sig = [...recommended].sort().join(',')
    if (sig === preselectSig.current) return
    preselectSig.current = sig
    setSelected(new Set(recommended))
  }, [recommended])
  const fix = useMaintenanceRun(() =>
    api.tagFix(
      (report === null ? [] : selectedActions(report, selected)).slice(0, MAX_TAG_ACTIONS),
    ),
  )
  // A finished fix changed frontmatter → the graph (and with it this report) is stale.
  const fixedOk = fix.result?.ok === true
  const notifiedRef = useRef(false)
  useEffect(() => {
    if (fixedOk) {
      setSelected(new Set())
      void qc.invalidateQueries({ queryKey: ['graph'] })
      if (!notifiedRef.current) {
        notifiedRef.current = true
        onFixed?.(fix.result?.pages ?? [])
      }
    }
    // fix.result is settled once per run; onFixed identity changes must not re-fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedOk, qc])
  if (report === null) return null
  const actions = selectedActions(report, selected)
  // Two selected repairs fighting over one tag (e.g. two merges consuming the same tag)
  // would force the agent to guess an order - block the run until one is unchecked.
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
  const CAP = 8 // evidence, not an endless list - the counts carry the "how bad is it"
  return (
    <div className="card card-pad" id="card-tags">
      <div className="section-head">
        <h3 className="section-title">
          Tags - hygiene
          <Tip text="Deterministic tag lint, computed from the live graph - the report itself writes nothing. Repairs with an unambiguous direction come preselected: uncheck what you disagree with, then 'Fix selected' runs an agent over exactly the checked actions - frontmatter tags only, one revertable git commit. Non-actionable findings (implied tags, single-use tags) are collapsed under Observations." />
        </h3>
        <button
          className="btn primary"
          disabled={actions.length === 0 || conflict !== null || fix.running}
          onClick={fix.start}
          title={
            actions.length === 0
              ? 'Check findings below to build the repair plan'
              : conflict !== null
                ? `Conflicting selections: #${conflict} appears in more than one repair - uncheck one`
                : `Apply ${Math.min(actions.length, MAX_TAG_ACTIONS)} tag repair${actions.length === 1 ? '' : 's'} (one git commit - revertable)`
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
        <p className="tab-hint">No findings - the tag set looks healthy.</p>
      ) : (
        <div className="tagrep">
          {(report.variants.length > 0 || report.domainEchoes.length > 0) && (
            <p className="tab-hint">
              Repairs with an unambiguous direction are preselected - uncheck anything you disagree with.
              {recommended !== null && recommended.size >= MAX_TAG_ACTIONS && (
                <> A run applies at most {MAX_TAG_ACTIONS} actions - the rest returns with the next report.</>
              )}
            </p>
          )}
          {report.variants.length > 0 && (
            <section>
              <h4>
                Likely variants <span className="cnt">{report.variants.length}</span>
              </h4>
              {report.variants.slice(0, CAP).map((v) => {
                const [from, to] = mergeDir(v)
                const key = `merge|${from}|${to}`
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
                    <span className="why">
                      Two spellings of one concept - <code>#{from}</code> folds into the more common{' '}
                      <code>#{to}</code>.
                    </span>
                  </label>
                )
              })}
              {report.variants.length > CAP && <div className="more">+{report.variants.length - CAP} more</div>}
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
                      {/* A tag blanketing the unassigned bucket isn't redundancy - it's the
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
                    <span className="why">
                      {missing ? (
                        <>
                          Not redundancy: these unassigned pages likely wait for a domain like this - see
                          &quot;Candidates for new domains&quot; in the Domains card.
                        </>
                      ) : (
                        <>
                          Adds nothing beyond the page&apos;s domain field - nearly every use sits inside{' '}
                          <span className="dom">{e.domain}</span>.
                        </>
                      )}
                    </span>
                  </label>
                )
              })}
              {report.domainEchoes.length > CAP && (
                <div className="more">+{report.domainEchoes.length - CAP} more</div>
              )}
            </section>
          )}
          {(report.implications.length > 0 || report.singletons.length > 0) && (
            <details className="tag-obs">
              <summary>
                Observations - nothing to fix{' '}
                <span className="cnt">
                  {report.implications.length} implied · {report.singletons.length} single-use
                </span>
              </summary>
              <p className="tab-hint">
                Implied tags show how your tags nest (pages with the first almost always carry the second) -
                useful context, not a defect. Single-use tags usually resolve themselves as the vault grows.
              </p>
              {report.implications.length > 0 && (
                <section>
                  <h4>
                    Implied tags <span className="cnt">{report.implications.length}</span>
                  </h4>
                  {report.implications.slice(0, CAP).map((v) => (
                    <div key={`${v.a}|${v.b}`} className="trow">
                      <span className="pair">
                        <code>#{v.a}</code> <span className="sep">{v.mutual === true ? '↔' : '→'}</span>{' '}
                        <code>#{v.b}</code>
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
              {report.singletons.length > 0 && (
                <section>
                  <h4>
                    Single-use tags <span className="cnt">{report.singletons.length}</span>
                  </h4>
                  <div className="filters">
                    {report.singletons.slice(0, 60).map((t) => (
                      <span key={t} className="chip">
                        #{t}
                      </span>
                    ))}
                    {report.singletons.length > 60 && (
                      <span className="more">+{report.singletons.length - 60} more</span>
                    )}
                  </div>
                </section>
              )}
            </details>
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
 * once provisioned - deterministic, no agent, no credential, so the rebuild button works in
 * setup mode too. Freshness is otherwise automatic (a debounced rebuild after each ingest); this
 * surfaces the state and a manual rebuild. A pre-v1.7 vault ships no scripts → the card explains
 * that instead of offering a build that would 409.
 */
function RetrievalIndexCard(): React.ReactElement {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['retrieve-index-status'], queryFn: api.retrieveIndexStatus })
  const build = useMaintenanceRun(() => api.retrieveIndex())

  // A settled build changes chunk count / provisioned state - refetch the status when it lands.
  useEffect(() => {
    if (build.result) void qc.invalidateQueries({ queryKey: ['retrieve-index-status'] })
  }, [build.result, qc])

  const s = status.data
  const missing = s !== undefined && !s.scriptsPresent

  return (
    <div className="card card-pad" id="card-index">
      <div className="section-head">
        <h3 className="section-title">
          Retrieval index
          <Tip
            text={
              <>
                Chunk-level hybrid retrieval (BM25 over contextualized chunks) for the Research/chat read
                path. Once built, questions are answered from the passages <code>retrieve.py</code> ranks
                instead of a page-title scan - better at facts buried mid-page. Rebuilds automatically after
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
          This vault ships no <code>wiki-retrieve</code> scripts - it predates claude-obsidian v1.7. Nothing to
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
            <span>Not built yet - the query path falls back to the classic read order until you build it.</span>
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
 * free, so it simply renders - no "start analysis" needed. The agent pass only JUDGES what the
 * finder already surfaced, and costs a real agent run; it is ON by default (SPEC §12.7 Stufe a)
 * because its verdicts are what turn a bare key into a complete proposal (key + description +
 * tags) - the toggle remains as the opt-out for cost-conscious refreshes.
 *
 * Creating a domain is deliberately a user action here; agents may never coin a key. A created
 * domain gets its pages only through a backfill - the explicit prompt after each create closes
 * what used to be a silent gap.
 */
function DomainCandidates({
  vaultName,
  onStartBackfill,
  backfillRunning,
  autoReview = false,
  suppressBackfillPrompt = false,
  onDomainCreated,
}: {
  vaultName: string
  onStartBackfill: () => void
  backfillRunning: boolean
  /** Guided run (SPEC §12.7 Stufe c): start the read-only review by itself when candidates exist. */
  autoReview?: boolean
  /** Guided run: the follow-up backfill is queued as a step - no inline prompt needed. */
  suppressBackfillPrompt?: boolean
  /** Guided run: lets the wizard track what was created (drives the follow-up backfill). */
  onDomainCreated?: (key: string) => void
}): React.ReactElement | null {
  const qc = useQueryClient()
  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const [withAgent, setWithAgent] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  /** Key of the most recently created domain - drives the "run the backfill now" prompt. */
  const [created, setCreated] = useState<string | null>(null)
  const review = useMaintenanceRun(() => api.domainReview())

  // The wizard's domain step runs the review as a fixed part of the flow (one run, all
  // candidates) - its verdicts are what make every proposal complete. Once per mount.
  const autoStarted = useRef(false)
  const candidateCount = candidates.data?.candidates.length ?? 0
  useEffect(() => {
    if (!autoReview || autoStarted.current) return
    if (candidateCount === 0) return
    autoStarted.current = true
    review.start()
    // review is stable per mount (useMaintenanceRun returns fresh closures, but start is safe
    // to call once); candidateCount gates until the list is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReview, candidateCount])

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
          <label
            className="toggle"
            title="An agent judges each candidate and drafts key, description and tags (costs one run). Uncheck for a free refresh of the deterministic list only."
          >
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
            field at all - that's what the backfill is for; until then this analysis is incomplete.
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

      {/* A created domain owns no pages until a backfill re-files its `unassigned` backlog
          (SPEC §12.4 Stufe 3 "Selbstheilung") - prompt for it instead of leaving the gap silent.
          The guided run queues the backfill as its own step, so it suppresses this. */}
      {created !== null && !suppressBackfillPrompt && (
        <div className="toast ok toast-action">
          <span>
            Domain <code>{created}</code> created. Its pages still say <code>unassigned</code> until a
            backfill files them.
          </span>
          <button
            className="btn"
            disabled={backfillRunning}
            onClick={() => {
              setCreated(null)
              onStartBackfill()
            }}
          >
            {backfillRunning ? 'Backfill running…' : 'Start backfill now'}
          </button>
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
              onCreated={(key) => {
                setCreated(key)
                onDomainCreated?.(key)
              }}
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
  onCreated,
  onDone,
}: {
  candidate: DomainCandidate
  verdict: DomainReviewEntry | undefined
  vaultName: string
  editing: boolean
  onEdit: () => void
  onCreated: (key: string) => void
  onDone: () => void
}): React.ReactElement {
  // The proposal is always complete (SPEC §12.7 Stufe a): the agent's verdict pre-fills key,
  // description and tags when it exists; the deterministic draft is the floor so the
  // description never starts empty.
  const fallbackDescription = useMemo(() => draftDomainDescription(candidate), [candidate])
  const [key, setKey] = useState(verdict?.key ?? candidate.key)
  const [description, setDescription] = useState(verdict?.description ?? fallbackDescription)
  const [tags, setTags] = useState((verdict?.tags ?? candidate.tags).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The review lands AFTER this card mounted (it is a run, the list is not) - without this
  // sync the verdict's proposal would never reach the already-initialized fields. Only while
  // the form is closed: an open form is the user's text, never to be clobbered.
  useEffect(() => {
    if (editing) return
    setKey(verdict?.key ?? candidate.key)
    setDescription(verdict?.description ?? fallbackDescription)
    setTags((verdict?.tags ?? candidate.tags).join(', '))
  }, [verdict, candidate, fallbackDescription, editing])

  const create = (): void => {
    const finalKey = key.trim().toLowerCase()
    setBusy(true)
    setError(null)
    void api
      .createDomain({
        key: finalKey,
        description: description.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        dismissCandidate: candidate.key,
      })
      .then(() => {
        onCreated(finalKey)
        onDone()
      })
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
          Suggestion: file these pages under <code>{verdict.existing}</code> - edit the pages or run a
          backfill to do so.
        </p>
      )}

      {/* The member pages, collapsed: a 30-page candidate must not cost 30 chip rows of
          screen before the user even decides - the count in the head already says the size. */}
      <details className="cand-pages">
        <summary>Show {candidate.pageCount} page{candidate.pageCount === 1 ? '' : 's'}</summary>
        <PageLinks paths={candidate.pages.map((p) => p.path)} vaultName={vaultName} />
      </details>

      {editing ? (
        <div className="candidate-form">
          <label>
            Key
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. history" />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What does this domain cover?"
            />
            <span className="field-hint">
              Prefilled draft{verdict?.description ? ' (agent proposal)' : ''} - edit freely; broad wording
              keeps the domain extensible.
            </span>
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
          <Icon name="check" /> No findings - the wiki is clean.
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
  // The run's cost was collected all along (result.usage) but never rendered - receipts.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const authMode = stats.data?.authMode ?? 'oauth'
  if (!result.ok) return <div className="toast err">{result.error ?? 'Failed'}</div>
  return (
    <div className="toast ok">
      {label}
      {result.usage.costUsd > 0 && (
        <span className="run-cost">
          {' '}· <Cost value={result.usage.costUsd} authMode={authMode} />
        </span>
      )}
      {result.pages.length > 0 ? <PageLinks vaultName={vaultName} paths={result.pages} /> : <> - no changes.</>}
    </div>
  )
}

/* ── Guided run (SPEC §12.7 Stufe c) ─────────────────────────────────────────────────── */

type StepOutcome = { state: 'done' | 'skipped' | 'failed'; note: string }

/**
 * The guided maintenance run: walks the plan `buildRunPlan` derived from the status model.
 * Automatic steps start themselves, stream their live log and advance on settle; decision
 * steps embed the SAME components the expert cards use (one implementation per decision
 * surface) and wait for the user. Sequencing is client-driven over the existing endpoints -
 * the server's run mutex serializes the actual vault writes, and every step stays its own
 * revertable commit, so closing the tab mid-run loses only the wizard position, never work.
 */
function GuidedRun({
  plan,
  vaultName,
  onExit,
}: {
  plan: RunPlanStep[]
  vaultName: string
  onExit: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const authMode = stats.data?.authMode ?? 'oauth'
  // Receipts: what a step cost, appended to its outcome note (the estimate footnote sits
  // under the summary once, so the per-step suffix stays a bare number).
  const costSuffix = (usd: number): string => (usd > 0 ? ` · $${usd.toFixed(2)}${isEstimate(authMode) ? '*' : ''}` : '')
  const [idx, setIdx] = useState(0)
  const [outcomes, setOutcomes] = useState<Record<string, StepOutcome>>({})
  /** Domains created in the decision step - what makes the follow-up backfill run vs. skip. */
  const [created, setCreated] = useState<string[]>([])

  const backfill1 = useMaintenanceRun(() => api.domainBackfill())
  const backfill2 = useMaintenanceRun(() => api.domainBackfill())
  const lint = useMaintenanceRun(() => api.lint())
  const lintFix = useMaintenanceRun(() => api.lintFix())
  const hot = useMaintenanceRun(() => api.hotCache())
  const autoRuns: Partial<Record<RunStepId, MaintenanceRunState>> = {
    backfill: backfill1,
    backfill2,
    'hot-cache': hot,
  }

  const step: RunPlanStep | undefined = plan[idx]
  const finished = idx >= plan.length

  const finish = (id: RunStepId, state: StepOutcome['state'], note: string): void => {
    setOutcomes((prev) => ({ ...prev, [id]: { state, note } }))
    setIdx((i) => i + 1)
  }

  // Automatic steps start themselves on entry, exactly once. The follow-up backfill skips
  // itself when the domain step created nothing - there is nothing to re-file then.
  const startedRef = useRef(new Set<string>())
  useEffect(() => {
    if (step === undefined || step.kind !== 'auto') return
    if (startedRef.current.has(step.id)) return
    startedRef.current.add(step.id)
    if (step.id === 'backfill2' && created.length === 0) {
      finish('backfill2', 'skipped', 'No domain created - nothing to re-file.')
      return
    }
    if (step.id === 'lint') lint.start()
    else autoRuns[step.id]?.start()
    // start() closures are stable enough for a once-per-step fire; the ref is the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, created])

  // Plain automatic steps advance when their run settles ok (errors render Retry/Skip below).
  useEffect(() => {
    if (step === undefined || step.kind !== 'auto' || step.id === 'lint') return
    const r = autoRuns[step.id]
    if (r?.result?.ok === true) {
      const base = r.result.pages.length > 0 ? `${r.result.pages.length} page(s) committed` : 'No changes needed.'
      finish(step.id, 'done', base + costSuffix(r.result.usage.costUsd))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfill1.result, backfill2.result, hot.result])

  // The lint step chains its safe-fix run: report first (it BOUNDS the fix), then the fix.
  const lintFixStarted = useRef(false)
  useEffect(() => {
    if (step?.id !== 'lint') return
    if (lint.result?.ok === true && !lintFixStarted.current) {
      lintFixStarted.current = true
      lintFix.start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lint.result, step])
  useEffect(() => {
    if (step?.id !== 'lint') return
    if (lintFix.result?.ok === true) {
      const usd = (lint.result?.usage.costUsd ?? 0) + lintFix.result.usage.costUsd
      finish('lint', 'done', `Report written · ${lintFix.result.pages.length} page(s) auto-fixed.` + costSuffix(usd))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lintFix.result, step])

  const exit = (): void => {
    void qc.invalidateQueries({ queryKey: ['graph'] })
    void qc.invalidateQueries({ queryKey: ['domain-candidates'] })
    void qc.invalidateQueries({ queryKey: ['stats'] })
    onExit()
  }

  const stepError =
    step?.kind === 'auto'
      ? step.id === 'lint'
        ? lint.error ?? lintFix.error
        : autoRuns[step.id]?.error ?? null
      : null
  const retry = (): void => {
    if (step === undefined) return
    if (step.id === 'lint') {
      if (lint.error !== null) lint.start()
      else lintFix.start()
    } else {
      autoRuns[step.id]?.start()
    }
  }

  return (
    <div className="guided-run">
      <div className="card card-pad maint-status">
        <div className="section-head">
          <h3 className="section-title">
            Maintenance run
            <Tip text="Works through the open items in dependency order. Automatic steps run on their own - the run stops only where your judgement is needed. Every step is one revertable git commit." />
          </h3>
          {!finished && (
            <button className="btn ghost" onClick={exit} title="A step that is already running finishes on the server">
              Cancel run
            </button>
          )}
        </div>
        <div className="wiz-steps">
          {plan.map((s, i) => {
            const o = outcomes[s.id]
            const cls = o !== undefined ? o.state : i === idx ? 'active' : 'pending'
            return (
              <span key={s.id} className={`wiz-step ${cls}`}>
                <span className="dot">{o === undefined ? i + 1 : o.state === 'done' ? '✓' : o.state === 'skipped' ? '-' : '!'}</span>
                {s.title}
                <span className={`sev ${s.kind === 'auto' ? 'mut' : 'rec'}`}>{s.kind === 'auto' ? 'auto' : 'you decide'}</span>
              </span>
            )
          })}
        </div>
      </div>

      {finished || step === undefined ? (
        <div className="card card-pad">
          <div className="toast ok">Maintenance run finished.</div>
          <h3 className="section-title" style={{ marginBottom: 4 }}>
            What happened
          </h3>
          <p className="tab-hint">
            Every step was its own git commit - revertable independently.
            {isEstimate(authMode) && <> Costs marked * are {ESTIMATE_LABEL}.</>}
          </p>
          <div className="wiz-summary">
            {plan.map((s) => {
              const o = outcomes[s.id]
              return (
                <div key={s.id} className="wiz-summary-row">
                  <span className={`sev ${o?.state === 'done' ? 'ok' : o?.state === 'failed' ? 'due' : 'mut'}`}>
                    {o?.state ?? 'skipped'}
                  </span>
                  <span className="ms-title">{s.title}</span>
                  <span className="ms-why">{o?.note ?? ''}</span>
                </div>
              )
            })}
          </div>
          <div className="wiz-foot">
            <span className="spacer" />
            <button className="btn primary" onClick={exit}>
              Back to overview
            </button>
          </div>
        </div>
      ) : step.kind === 'decision' ? (
        <div className="card card-pad wiz-panel">
          <div className="section-head">
            <h3 className="section-title">{step.title}</h3>
            <span className="sev rec">you decide</span>
          </div>
          <p className="tab-hint">{step.why}</p>
          {step.id === 'domains' ? (
            <DomainCandidates
              vaultName={vaultName}
              onStartBackfill={() => {}}
              backfillRunning={false}
              autoReview
              suppressBackfillPrompt
              onDomainCreated={(key) => setCreated((prev) => [...prev, key])}
            />
          ) : (
            <TagHygieneCard
              nodes={graph.data?.nodes}
              vaultName={vaultName}
              onFixed={(pages) => finish('tags', 'done', `${pages.length} page(s) committed.`)}
            />
          )}
          <div className="wiz-foot">
            <button
              className="btn ghost"
              onClick={() => finish(step.id, 'skipped', 'Skipped - comes back with the next check.')}
            >
              Skip step
            </button>
            <span className="spacer" />
            {step.id === 'domains' && (
              <button
                className="btn primary"
                onClick={() =>
                  finish(
                    'domains',
                    'done',
                    created.length > 0
                      ? `${created.length} domain(s) created - backfill queued.`
                      : 'Nothing created.',
                  )
                }
              >
                Continue
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="card card-pad wiz-panel">
          <div className="section-head">
            <h3 className="section-title">{step.title}</h3>
            <span className="sev mut">automatic</span>
          </div>
          <p className="tab-hint">{step.why}</p>
          {step.id === 'lint' ? (
            <>
              <JobLog jobId="maintenance:lint" seed={false} />
              {lintFixStarted.current && <JobLog jobId="maintenance:lint-fix" seed={false} />}
            </>
          ) : (
            <JobLog
              jobId={`maintenance:${step.id === 'backfill' || step.id === 'backfill2' ? 'domain-backfill' : step.id}`}
              seed={false}
            />
          )}
          {stepError !== null ? (
            <div className="wiz-foot">
              <span className="toast err">{stepError}</span>
              <span className="spacer" />
              <button className="btn" onClick={retry}>
                Retry
              </button>
              <button className="btn ghost" onClick={() => finish(step.id, 'failed', stepError)}>
                Skip step
              </button>
            </div>
          ) : (
            <div className="wiz-foot">
              <span className="autonote">Running - continues automatically…</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
