import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client.ts'
import { useEvents } from './hooks/useEvents.ts'
import { StatusPopover } from './components/StatusPopover.tsx'
import { Overview } from './tabs/Overview.tsx'
import { Ingestion } from './tabs/Ingestion.tsx'
import { Chat } from './tabs/Chat.tsx'
import { Maintenance } from './tabs/Maintenance.tsx'
import { Icon, type IconName } from './components/Icon.tsx'
import { usePath, navigate } from './lib/router.ts'

// Code-split: the vault viewer pulls in d3-force + the canvas machinery, which the other
// tabs never need — keep the mobile shell light.
const Vault = lazy(() => import('./tabs/Vault.tsx').then((m) => ({ default: m.Vault })))

type TabId = 'overview' | 'ingestion' | 'chat' | 'vault' | 'maintenance'

const TABS: Array<{ id: TabId; label: string; icon: IconName; route: string }> = [
  { id: 'overview', label: 'Overview', icon: 'grid', route: '/' },
  { id: 'ingestion', label: 'Ingestion', icon: 'inbox', route: '/ingestion' },
  { id: 'chat', label: 'Research', icon: 'chat', route: '/research' },
  { id: 'vault', label: 'Vault', icon: 'graph', route: '/vault' },
  { id: 'maintenance', label: 'Maintenance', icon: 'wrench', route: '/maintenance' },
]

/** Which tab a path belongs to (the vault tab owns /vault and /vault/page/…). */
function tabForPath(path: string): TabId {
  const pathname = path.split('?')[0]!
  if (pathname.startsWith('/vault')) return 'vault'
  if (pathname.startsWith('/ingestion')) return 'ingestion'
  // `/chat` and `/wartung` are pre-rename routes — old bookmarks/PWA shortcuts carry them.
  if (pathname.startsWith('/research') || pathname.startsWith('/chat')) return 'chat'
  if (pathname.startsWith('/maintenance') || pathname.startsWith('/wartung')) return 'maintenance'
  return 'overview'
}

/** Old route → its current name; normalized via replaceState so history stays clean. */
const LEGACY_ROUTES: Array<[string, string]> = [
  ['/wartung', '/maintenance'],
  ['/chat', '/research'],
]

export function App(): React.ReactElement {
  const path = usePath()
  const tab = tabForPath(path)
  // One SSE connection for the whole app; drives live invalidation + the connection dot.
  const { connected } = useEvents()

  // Outstanding work for the Ingestion tab badge — running ingests are otherwise invisible
  // from every other tab. Rides the shared ['stats'] query (SSE keeps it fresh).
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const outstanding = (stats.data?.queue.active ?? 0) + (stats.data?.queue.queued ?? 0)
  const running = (stats.data?.queue.active ?? 0) > 0

  // First-run setup mode: the server runs without a credential and every agent feature is
  // off — surface that on every tab, with the path to fix it (Maintenance → Settings).
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const setupMode = health.data ? !health.data.credentialConfigured : false

  // Tabs stay MOUNTED and are hidden via [hidden] — unmounting threw away the graph
  // camera, the active chat session, filters and scroll positions on every switch.
  // The vault tab keeps its last inner route while other tabs own the URL; null until
  // first visited, so the lazy chunk still loads on demand.
  const [vaultPath, setVaultPath] = useState<string | null>(() => (tab === 'vault' ? path : null))
  useEffect(() => {
    if (tab === 'vault') setVaultPath(path)
  }, [tab, path])

  // Normalize legacy routes so the address bar and history show the current ones.
  useEffect(() => {
    const pathname = path.split('?')[0]!
    const legacy = LEGACY_ROUTES.find(([old]) => pathname.startsWith(old))
    if (legacy) navigate(legacy[1], { replace: true })
  }, [path])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Icon name="logo" />
          BrainVault
        </span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => navigate(t.route)}
            >
              {t.label}
              {t.id === 'ingestion' && outstanding > 0 && (
                <span className="tab-badge" aria-label={`${outstanding} jobs outstanding`}>
                  {running && <span className="pulse" aria-hidden />}
                  {outstanding}
                </span>
              )}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <StatusPopover connected={connected} />
      </header>

      {setupMode && (
        <div className="setup-banner" role="status">
          <strong>Almost there:</strong>&nbsp;no Anthropic credential configured yet — ingestion,
          research and maintenance are paused.
          <button className="btn primary" onClick={() => navigate('/maintenance')}>
            Set up now
          </button>
        </div>
      )}

      <main className="content">
        <section className="tab-panel" hidden={tab !== 'overview'}>
          <Overview onGoto={() => navigate('/ingestion')} />
        </section>
        <section className="tab-panel" hidden={tab !== 'ingestion'}>
          <Ingestion />
        </section>
        <section className="tab-panel" hidden={tab !== 'chat'}>
          <Chat researchPrefill={tab === 'chat' ? (new URLSearchParams(path.split('?')[1] ?? '').get('prefill') ?? '') : ''} />
        </section>
        <section className="tab-panel" hidden={tab !== 'vault'}>
          {vaultPath !== null && (
            <Suspense fallback={<div className="empty">Loading vault view…</div>}>
              <Vault path={vaultPath} />
            </Suspense>
          )}
        </section>
        <section className="tab-panel" hidden={tab !== 'maintenance'}>
          <Maintenance />
        </section>
      </main>

      <nav className="bottomnav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => navigate(t.route)}>
            <span className="nav-icon">
              <Icon name={t.icon} />
              {t.id === 'ingestion' && outstanding > 0 && (
                <span className="nav-badge" aria-label={`${outstanding} jobs outstanding`}>
                  {outstanding}
                </span>
              )}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
