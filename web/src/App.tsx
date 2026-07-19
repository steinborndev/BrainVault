import { lazy, Suspense, useEffect, useState } from 'react'
import { useEvents } from './hooks/useEvents.ts'
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
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className={`conn${connected ? ' live' : ''}`} title={connected ? 'Live (SSE connected)' : 'Disconnected'}>
          <span className="dot" />
          {connected ? 'Live' : 'Offline'}
        </span>
      </header>

      <main className="content">
        <section className="tab-panel" hidden={tab !== 'overview'}>
          <Overview onGoto={() => navigate('/ingestion')} />
        </section>
        <section className="tab-panel" hidden={tab !== 'ingestion'}>
          <Ingestion />
        </section>
        <section className="tab-panel" hidden={tab !== 'chat'}>
          <Chat />
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
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
