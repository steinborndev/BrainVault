import { useState } from 'react'
import { useEvents } from './hooks/useEvents.ts'
import { Overview } from './tabs/Overview.tsx'
import { Ingestion } from './tabs/Ingestion.tsx'
import { Chat } from './tabs/Chat.tsx'
import { MaintenanceStub } from './tabs/Stubs.tsx'
import { Icon, type IconName } from './components/Icon.tsx'

type TabId = 'overview' | 'ingestion' | 'chat' | 'maintenance'

const TABS: Array<{ id: TabId; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Übersicht', icon: 'grid' },
  { id: 'ingestion', label: 'Ingestion', icon: 'inbox' },
  { id: 'chat', label: 'Query/Chat', icon: 'chat' },
  { id: 'maintenance', label: 'Wartung', icon: 'wrench' },
]

export function App(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('overview')
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
              onClick={() => setTab(t.id)}
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
        {tab === 'overview' && <Overview onGoto={() => setTab('ingestion')} />}
        {tab === 'ingestion' && <Ingestion />}
        {tab === 'chat' && <Chat />}
        {tab === 'maintenance' && <MaintenanceStub />}
      </main>

      <nav className="bottomnav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
