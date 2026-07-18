import { lazy, Suspense } from 'react'
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
        {tab === 'overview' && <Overview onGoto={() => navigate('/ingestion')} />}
        {tab === 'ingestion' && <Ingestion />}
        {tab === 'chat' && <Chat />}
        {tab === 'vault' && (
          <Suspense fallback={<div className="empty">Lade Vault-Ansicht…</div>}>
            <Vault path={path} />
          </Suspense>
        )}
        {tab === 'maintenance' && <Maintenance />}
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
