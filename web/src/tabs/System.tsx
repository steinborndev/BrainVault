/**
 * System (redesign 2026-08-25, second pass) - Health and Settings were two nearly empty
 * screens describing one thing: the machine under the vault. Merged, they fill a workspace
 * of the same shape as every other screen: sections in the control column, the selected one
 * in the content box.
 *
 * Two of the five sections are new, and neither needed a server change - the data was
 * already being collected and simply never shown:
 *
 *   Usage & cost   tokens in/out, spend today and over 7 days, the daily budget as a meter,
 *                  spend per channel and the most expensive runs (`jobs.cost_usd` and each
 *                  maintenance run's `result.usage`, which only ever appeared per row).
 *   Vault stats    growth, pages by type, orphans, stubs, gaps, unfiled pages, the retrieval
 *                  index and the domain split - scattered over Home tiles, Library filters
 *                  and Maintenance cards before.
 *
 * The other three are what was there: the maintenance status head with its tools, the
 * settings form, and the integrations (credential, Telegram, Obsidian).
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AuthMode, Stats } from '../api/types.ts'
import { Maintenance } from './Maintenance.tsx'
import { SettingsEditor } from '../components/SettingsEditor.tsx'
import { GrowthChart } from '../components/GrowthChart.tsx'
import { Cost, CostFootnote, isEstimate } from '../components/Cost.tsx'
import { Fact, Facts } from '../components/Fact.tsx'
import { Icon } from '../components/Icon.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { Tip } from '../components/Tip.tsx'
import { useMaintenanceStatus } from '../hooks/useMaintenanceStatus.ts'
import { STUB_BYTES } from '../lib/domains.ts'
import { timeAgo, tokens, usd } from '../lib/format.ts'
import { navigate } from '../lib/router.ts'
import { runTitle } from '../lib/runLabels.ts'
import { spendByChannel, spendItems, topSpend, totalSpend, withinDays } from '../lib/usage.ts'

type SectionId = 'checks' | 'usage' | 'vault' | 'service' | 'integrations'

const SECTIONS: Array<{ id: SectionId; label: string; sub: string }> = [
  { id: 'checks', label: 'Status & checks', sub: 'what the vault needs from you right now' },
  { id: 'usage', label: 'Usage & cost', sub: 'tokens, spend and the daily budget' },
  { id: 'vault', label: 'Vault stats', sub: 'size, shape and what is still unfiled' },
  { id: 'service', label: 'Service & config', sub: 'watch folder, concurrency, limits, budget' },
  { id: 'integrations', label: 'Integrations', sub: 'credential, Telegram, Obsidian' },
]

const isSection = (value: string): value is SectionId => SECTIONS.some((s) => s.id === value)

const DIR_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  references: 'References',
  comparisons: 'Comparisons',
  questions: 'Questions',
  folds: 'Folds',
  meta: 'Meta',
}

export function System({ section = '' }: { section?: string }): React.ReactElement {
  const [active, setActive] = useState<SectionId>(() => (isSection(section) ? section : 'checks'))

  // `?section=` from elsewhere (the setup banner points at integrations) - the screen stays
  // mounted, so this must react to navigation, not just the first mount.
  useEffect(() => {
    if (isSection(section)) setActive(section)
  }, [section])

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const maint = useMaintenanceStatus()
  const due = maint.data?.status.due ?? 0
  const recommended = maint.data?.status.recommended ?? 0
  const overrides = Object.keys(settings.data?.overrides ?? {}).length

  const lastRuns = useMemo(
    () =>
      [...(maint.data?.lastRuns.values() ?? [])].sort(
        (a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt),
      ),
    [maint.data],
  )

  const current = SECTIONS.find((s) => s.id === active)!

  const badgeFor = (id: SectionId): React.ReactElement | null => {
    if (id === 'checks') {
      if (due > 0) return <span className="n warn">{due} due</span>
      if (recommended > 0) return <span className="n">{recommended} soon</span>
      return <span className="n ok">ok</span>
    }
    if (id === 'vault' && stats.data !== undefined) return <span className="n">{stats.data.pages.total}</span>
    if (id === 'service' && overrides > 0) return <span className="n">{overrides}</span>
    return null
  }

  return (
    <div className="workspace">
      <aside className="gpanel" aria-label="System sections">
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">System</span>
          </div>
          <div className="domlist static">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`domrow${active === s.id ? ' active' : ''}`}
                aria-current={active === s.id ? 'true' : undefined}
                onClick={() => setActive(s.id)}
              >
                <span
                  className="dot"
                  style={{ background: active === s.id ? 'var(--accent)' : 'var(--muted)' }}
                  aria-hidden
                />
                <span className="nm">{s.label}</span>
                {badgeFor(s.id)}
              </button>
            ))}
          </div>
        </div>

        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Last runs</span>
            <span className="spacer" />
            <Tip text="The most recent settle per run kind, restart-proof (SPEC 12.7 Stufe b). Vault facts (report date, cache age) stay the primary source; this covers the areas no vault file captures." />
          </div>
          {lastRuns.length === 0 ? (
            <div className="gp-none">No maintenance runs recorded yet.</div>
          ) : (
            <div className="domlist">
              {lastRuns.map((r) => (
                <button key={r.kind} className="domrow" onClick={() => setActive('checks')}>
                  <span className={`hrow-dot ${r.ok ? 'done' : 'failed'}`} aria-hidden />
                  <span className="nm" title={runTitle(r.kind, r.ok)}>
                    {runTitle(r.kind, r.ok)}
                  </span>
                  <span className="n">{timeAgo(r.finishedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Service</span>
          </div>
          <div className="kvlist">
            <div className="kv">
              <span className="k">Vault</span>
              <span className="v">{settings.data?.readOnly['vaultRoot'] ?? '…'}</span>
            </div>
            <div className="kv">
              <span className="k">Address</span>
              <span className="v">{settings.data?.readOnly['bind'] ?? '…'}</span>
            </div>
            <div className="kv">
              <span className="k">Anthropic</span>
              <span className="v">{settings.data?.readOnly['authMode'] ?? '…'}</span>
            </div>
            <div className="kv">
              <span className="k">Concurrency</span>
              <span className="v">{stats.data?.queue.concurrency ?? '…'}</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="box">
        <div className="box-head">
          <h2 className="box-title">{current.label}</h2>
          <span className="box-sub">{current.sub}</span>
          <span className="spacer" />
          {active === 'checks' && due + recommended > 0 && (
            <span className={`badge ${due > 0 ? 'deferred' : ''}`}>
              {due > 0 ? `${due} due` : `${recommended} soon`}
            </span>
          )}
        </div>
        <div className="box-body">
          {active === 'checks' && (
            <div className="sys-pane">
              <Maintenance showRunHistory={false} />
            </div>
          )}
          {active === 'usage' && <UsageSection />}
          {active === 'vault' && <VaultStatsSection />}
          {active === 'service' && (
            <div className="sys-pane">
              <SettingsEditor section="service" />
            </div>
          )}
          {active === 'integrations' && (
            <div className="sys-pane">
              <SettingsEditor section="integrations" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** The last `days` days of the sparse per-day series as a dense array (UTC dates). */
function dense(daily: Stats['kpisDaily'], key: 'done' | 'failed', days: number): number[] {
  const map = new Map(daily.map((d) => [d.date, d[key]]))
  const out: number[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    out.push(map.get(date) ?? 0)
  }
  return out
}

/**
 * Usage & cost. Every figure here comes from data the service already stored - the point of
 * the section is that it was never added up anywhere.
 */
function UsageSection(): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  // The same window Home lists, so the two screens agree and the query is shared.
  const jobs = useQuery({ queryKey: ['jobs', 300], queryFn: () => api.jobs({ limit: 300 }) })
  // The PERSISTENT run log, not the runner's in-memory registry: the registry starts empty
  // on every service restart, so both cards below said "nothing" while the log held the runs.
  const runs = useQuery({
    queryKey: ['maintenance-history', 'all'],
    queryFn: () => api.maintenanceHistory({ limit: 200 }),
  })

  const items = useMemo(
    () => spendItems(jobs.data?.jobs ?? [], runs.data?.runs ?? []),
    [jobs.data, runs.data],
  )
  const last7d = useMemo(() => withinDays(items, 7, new Date()), [items])
  const byChannel = useMemo(() => spendByChannel(last7d), [last7d])
  const biggest = useMemo(() => topSpend(last7d, 6), [last7d])

  // Every figure here is derived from all three queries, so the section reports one state
  // for all three. It used to gate on `stats.data === undefined` alone, which rendered a
  // failed request as "Loading usage…" for as long as the screen stayed open.
  const state = queryState(merge(stats, jobs, runs), 'the usage figures')
  if (stats.data === undefined) {
    return <div className="sys-pane">{state ?? <div className="empty">No usage recorded yet.</div>}</div>
  }

  const s = stats.data
  const authMode: AuthMode = s.authMode
  const budget = s.budget
  const budgetPct =
    budget.limit !== null && budget.limit > 0 ? Math.min(100, Math.round((budget.spent / budget.limit) * 100)) : null
  const channelMax = byChannel[0]?.costUsd ?? 0
  const knownSpend = totalSpend(last7d)

  return (
    <div className="sys-pane">
      <Facts>
        <Fact k="Spend today" v={<Cost value={s.usage.today.costUsd} authMode={authMode} />} />
        <Fact k="Spend 7 days" v={<Cost value={s.usage.last7d.costUsd} authMode={authMode} />} />
        <Fact k="Tokens in · 7d" v={tokens(s.usage.last7d.tokensIn)} />
        <Fact k="Tokens out · 7d" v={tokens(s.usage.last7d.tokensOut)} />
        {/* Every settled agent run in the window - ingests and the runs from the run log
            alike, which is also the count the daily budget measures in subscription mode. */}
        <Fact k="Runs · 7d" v={String(s.usage.last7d.ingests)} />
      </Facts>

      <div className="sys-grid">
        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">
              Daily budget
              <Tip text="Configured under Service & config. When it is spent the queue pauses itself and resumes at midnight - the reason shows up next to the queue on Home." />
            </h3>
            <span className="spacer" />
            {budget.limit === null ? (
              <span className="badge">no limit</span>
            ) : (
              <span className={`badge ${budget.exceeded ? 'deferred' : 'ok'}`}>
                {budget.unit === 'usd' ? `${usd(budget.limit)} / day` : `${budget.limit} ingests / day`}
              </span>
            )}
          </div>
          <div className="sc-body">
            {budget.limit === null ? (
              <p className="tab-hint">
                No daily budget configured. Runs are only bounded by the Anthropic usage limit.{' '}
                <button className="linkish" onClick={() => navigate('/system?section=service')}>
                  Set one
                </button>
              </p>
            ) : (
              <>
                <div className="meter">
                  <i
                    className={budget.exceeded ? 'over' : ''}
                    style={{ width: `${budgetPct ?? 0}%` }}
                  />
                </div>
                <div className="sc-meta">
                  <span>
                    {budget.unit === 'usd' ? usd(budget.spent) : `${budget.spent} ingests`} spent
                  </span>
                  <span className="spacer" />
                  <span>resets {timeAgo(budget.resetsAt)}</span>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">Ingests per day · 14 d</h3>
            <span className="spacer" />
            <span className="badge">{s.kpis7d.ingests} in 7 d</span>
          </div>
          <div className="sc-body">
            <DayBars values={dense(s.kpisDaily, 'done', 14)} />
            <div className="sc-meta">
              <span>{s.kpis7d.failures} failed</span>
              <span>{s.kpis7d.duplicates} duplicates</span>
              <span>{s.kpis7d.deferred} deferred</span>
            </div>
          </div>
        </section>
      </div>

      <section className="subcard">
        <div className="sc-head">
          <h3 className="sc-title">
            Where it went · last 7 days
            <Tip text="Summed over the stored job window and the maintenance runs the service still tracks. Runs evicted from the in-memory registry are not counted here." />
          </h3>
          <span className="spacer" />
          <span className="badge">{usd(knownSpend)} attributed</span>
        </div>
        <div className="sc-body">
          {byChannel.length === 0 ? (
            <div className="empty">Nothing cost anything in this window.</div>
          ) : (
            <div className="tbars">
              {byChannel.map((c) => (
                <div key={c.channel} className="tbar">
                  <span className="tl">{c.channel}</span>
                  <span className="track">
                    <span
                      className="fill"
                      style={{ width: `${Math.max(2, Math.round((c.costUsd / (channelMax || 1)) * 100))}%` }}
                    />
                  </span>
                  <span className="tv">
                    <Cost value={c.costUsd} authMode={authMode} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="subcard">
        <div className="sc-head">
          <h3 className="sc-title">Most expensive runs · last 7 days</h3>
        </div>
        <div className="sc-body flush">
          {biggest.length === 0 ? (
            <div className="empty">No priced runs in this window.</div>
          ) : (
            <table className="dtable runtable">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Channel</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {biggest.map((i) => (
                  <tr key={i.id}>
                    <td className="rt-name" title={i.label}>
                      {i.label}
                    </td>
                    <td className="dimc">{i.channel}</td>
                    <td className="num">{tokens(i.tokensIn + i.tokensOut)}</td>
                    <td className="num">
                      <Cost value={i.costUsd} authMode={authMode} />
                    </td>
                    <td className="faintc">{timeAgo(i.whenIso)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {isEstimate(authMode) && (
        <p className="tab-hint">
          <CostFootnote authMode={authMode} /> - in subscription mode these amounts are the API-price
          equivalent, not money charged.
        </p>
      )}
    </div>
  )
}

/** Vault statistics: the shape of the wiki, in one place instead of four. */
function VaultStatsSection(): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const index = useQuery({ queryKey: ['retrieve-index-status'], queryFn: api.retrieveIndexStatus })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })

  const state = queryState(merge(stats, graph), 'the vault statistics')
  if (stats.data === undefined) {
    return <div className="sys-pane">{state ?? <div className="empty">No vault statistics yet.</div>}</div>
  }
  const s = stats.data
  const nodes = graph.data?.nodes ?? []
  const knowledge = nodes.filter((n) => (n.kind ?? 'knowledge') === 'knowledge')
  const orphans = knowledge.filter((n) => n.in === 0 && n.out === 0).length
  const stubs = knowledge.filter((n) => (n.size ?? Infinity) < STUB_BYTES).length
  const gaps = graph.data?.gaps.length ?? null
  const undomained = knowledge.filter((n) => n.domain === null).length
  const domainCounts = new Map<string, number>()
  for (const n of knowledge) if (n.domain !== null) domainCounts.set(n.domain, (domainCounts.get(n.domain) ?? 0) + 1)
  const unversioned = s.unversioned
  const growth = s.growth
  const weekAgo = growth[growth.length - 8]?.total ?? growth[0]?.total ?? s.pages.total
  const grew = s.pages.total - weekAgo

  return (
    // `fill`: the figures above stay on screen and the domain list takes the leftover
    // height and scrolls inside itself, instead of the whole pane scrolling as one.
    <div className="sys-pane fill">
      <Facts>
        <Fact k="Pages" v={String(s.pages.total)} sub={`${grew >= 0 ? '+' : ''}${grew} in 7 d`} />
        <Fact k="Links" v={graph.data !== undefined ? String(graph.data.edges.length) : '…'} />
        <Fact
          k="Orphans"
          v={graph.data !== undefined ? String(orphans) : '…'}
          tone={orphans > 0 ? 'warn' : undefined}
          onOpen={() => navigate('/library')}
        />
        <Fact
          k="Stubs"
          v={graph.data !== undefined ? String(stubs) : '…'}
          tone={stubs > 0 ? 'warn' : undefined}
          onOpen={() => navigate('/library')}
        />
        <Fact k="Gaps" v={gaps === null ? '…' : String(gaps)} onOpen={() => navigate('/graph?gaps=1')} />
        <Fact
          k="Unfiled"
          v={graph.data !== undefined ? String(undomained) : '…'}
          tone={undomained > 0 ? 'warn' : undefined}
        />
      </Facts>

      <div className="sys-grid">
        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">Growth · 30 days</h3>
          </div>
          <div className="sc-body">
            <GrowthChart points={s.growth} />
          </div>
        </section>

        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">Pages by type</h3>
          </div>
          <div className="sc-body">
            <TypeBars byDir={s.pages.byDir} />
          </div>
        </section>
      </div>

      <div className="sys-grid">
        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">
              Retrieval index
              <Tip text="Deterministic chunk + BM25 artifacts under .vault-meta - rebuildable, kept out of vault git history. Rebuild it from Status & checks." />
            </h3>
            <span className="spacer" />
            {index.data?.provisioned === true ? (
              <span className="badge ok">provisioned</span>
            ) : (
              <span className="badge">not built</span>
            )}
          </div>
          <div className="sc-body">
            <div className="kvlist">
              <div className="kv">
                <span className="k">Chunks</span>
                <span className="v">{index.data?.chunkCount ?? '…'}</span>
              </div>
              <div className="kv">
                <span className="k">Index built</span>
                <span className="v">{index.data?.indexBuiltAt != null ? timeAgo(index.data.indexBuiltAt) : 'never'}</span>
              </div>
              <div className="kv">
                <span className="k">Vault scripts</span>
                <span className="v">{index.data?.scriptsPresent === true ? 'present' : 'missing'}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">Pages outside git</h3>
            <span className="spacer" />
            {unversioned !== undefined && unversioned.untracked + unversioned.modified === 0 ? (
              <span className="badge ok">clean</span>
            ) : (
              <span className="badge deferred">
                {(unversioned?.untracked ?? 0) + (unversioned?.modified ?? 0)} open
              </span>
            )}
          </div>
          <div className="sc-body">
            {unversioned === undefined ? (
              <div className="empty">Not reported by this server.</div>
            ) : unversioned.untracked + unversioned.modified === 0 ? (
              <p className="tab-hint">
                <Icon name="check" /> Every page under <code>wiki/</code> is committed.
              </p>
            ) : (
              <div className="kvlist">
                <div className="kv">
                  <span className="k">Untracked</span>
                  <span className="v">{unversioned.untracked}</span>
                </div>
                <div className="kv">
                  <span className="k">Modified</span>
                  <span className="v">{unversioned.modified}</span>
                </div>
                <div className="kv">
                  <span className="k">Fix</span>
                  <span className="v">Status &amp; checks → commit them</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="subcard grow">
        <div className="sc-head">
          <h3 className="sc-title">Domains</h3>
          <span className="spacer" />
          <span className="badge">{domains.data?.domains.length ?? 0} registered</span>
        </div>
        <div className="sc-body">
          {domainCounts.size === 0 ? (
            <div className="empty">No page carries a domain yet.</div>
          ) : (
            <div className="kvlist">
              {[...domainCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => (
                  <div key={key} className="kv">
                    <span className="k">{key}</span>
                    <span className="v">{count} pages</span>
                  </div>
                ))}
              {undomained > 0 && (
                <div className="kv">
                  <span className="k warnish">no domain yet</span>
                  <span className="v">{undomained} pages</span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * A count per day as bars - discrete counts, not a continuous series, so the day boundaries
 * have to survive the drawing. Plain elements rather than a stretched SVG: the shared
 * Sparkline is a fixed 74x26 viewBox, and at card width its stroke scaled up with it.
 */
function DayBars({ values }: { values: number[] }): React.ReactElement {
  const max = Math.max(1, ...values)
  const today = new Date()
  const label = (i: number): string => {
    const d = new Date(today.getTime() - (values.length - 1 - i) * 24 * 60 * 60 * 1000)
    return d.toISOString().slice(5, 10)
  }
  return (
    <div className="daybars">
      <div className="db-plot" role="img" aria-label={`Ingests per day over the last ${values.length} days`}>
        {values.map((v, i) => (
          <span key={i} className="db-col" title={`${label(i)}: ${v}`}>
            <span
              className={`db-bar${v === 0 ? ' zero' : ''}${i === values.length - 1 ? ' last' : ''}`}
              style={{ height: `${Math.max(v === 0 ? 2 : 6, Math.round((v / max) * 100))}%` }}
            />
          </span>
        ))}
      </div>
      <div className="db-axis">
        <span>{label(0)}</span>
        <span className="db-max">peak {max}</span>
        <span>{label(values.length - 1)}</span>
      </div>
    </div>
  )
}

/** Page counts as horizontal bars - proportions read at a glance, direct labels right. */
function TypeBars({ byDir }: { byDir: Record<string, number> }): React.ReactElement {
  const entries = Object.entries(byDir)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const maxN = entries[0]?.[1] ?? 1
  if (entries.length === 0) return <div className="empty">No pages yet.</div>
  return (
    <div className="tbars">
      {entries.map(([dir, n]) => (
        <div key={dir} className="tbar">
          <span className="tl">{DIR_LABELS[dir] ?? dir}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(2, Math.round((n / maxN) * 100))}%` }} />
          </span>
          <span className="tv">{n}</span>
        </div>
      ))}
    </div>
  )
}
