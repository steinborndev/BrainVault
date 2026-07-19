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
  { id: 'overview', label: 'Übersicht', icon: 'grid', route: '/' },
  { id: 'ingestion', label: 'Ingestion', icon: 'inbox', route: '/ingestion' },
  { id: 'chat', label: 'Query/Chat', icon: 'chat', route: '/chat' },
  { id: 'vault', label: 'Vault', icon: 'graph', route: '/vault' },
  { id: 'maintenance', label: 'Wartung', icon: 'wrench', route: '/wartung' },
]

/** Which tab a path belongs to (the vault tab owns /vault and /vault/page/…). */
function tabForPath(path: string): TabId {
  const pathname = path.split('?')[0]!
  if (pathname.startsWith('/vault')) return 'vault'
  if (pathname.startsWith('/ingestion')) return 'ingestion'
  if (pathname.startsWith('/chat')) return 'chat'
  if (pathname.startsWith('/wartung')) return 'maintenance'
  return 'overview'
}

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
        <span className={`conn${connected ? ' live' : ''}`} title={connected ? 'Live (SSE verbunden)' : 'Getrennt'}>
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
            <Suspense fallback={<div className="empty">Lade Vault-Ansicht…</div>}>
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
