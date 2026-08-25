import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client.ts'
import { useEvents } from './hooks/useEvents.ts'
import { useMaintenanceStatus } from './hooks/useMaintenanceStatus.ts'
import { useActiveRuns } from './hooks/useActiveRuns.ts'
import { StatusPopover } from './components/StatusPopover.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { GlobalDrop } from './components/GlobalDrop.tsx'
import { Home } from './tabs/Home.tsx'
import { Chat } from './tabs/Chat.tsx'
import { System } from './tabs/System.tsx'
import { Library } from './tabs/Library.tsx'
import { Icon, type IconName } from './components/Icon.tsx'
import { usePath, navigate, pageFromPath } from './lib/router.ts'

// Code-split: the vault viewer pulls in d3-force + the canvas machinery, which the other
// screens never need - keep the shell light.
const Vault = lazy(() => import('./tabs/Vault.tsx').then((m) => ({ default: m.Vault })))

/**
 * Screens of the shell (redesign 2026-08-25, second pass). Five, down from seven: the Inbox
 * folded into Home (same table, plus intake and the filters that drive it), and Health +
 * Settings merged into System. `vault` hosts both the graph and the page view (shared state).
 */
type ScreenId = 'home' | 'research' | 'vault' | 'library' | 'system'

interface TabItem {
  id: ScreenId
  label: string
  icon: IconName
  route: string
}

/**
 * Navigation lives in the header row now, as browser-style tabs. It used to be a 216px
 * sidebar while the header spent a whole row naming the screen you were already on; five
 * entries fit across the top, and every workspace gets that width back.
 *
 * Order follows the day: what arrived (Home), what you go and find out (Research), then the
 * two ways of browsing what is there, then the machine room.
 */
const TABS: TabItem[] = [
  { id: 'home', label: 'Home', icon: 'home', route: '/' },
  { id: 'research', label: 'Research', icon: 'flask', route: '/research' },
  { id: 'vault', label: 'Graph', icon: 'graph', route: '/graph' },
  { id: 'library', label: 'Library', icon: 'book', route: '/library' },
  { id: 'system', label: 'System', icon: 'gear', route: '/system' },
]

/** Which screen a path belongs to (the vault screen owns /graph and /page/…). */
function screenForPath(path: string): ScreenId {
  const pathname = path.split('?')[0]!
  if (pathname.startsWith('/page/') || pathname.startsWith('/graph') || pathname.startsWith('/vault')) return 'vault'
  if (pathname.startsWith('/library')) return 'library'
  // `/chat` is the pre-rename route, `/research` the current one.
  if (pathname.startsWith('/research') || pathname.startsWith('/chat')) return 'research'
  if (
    pathname.startsWith('/system') ||
    pathname.startsWith('/health') ||
    pathname.startsWith('/maintenance') ||
    pathname.startsWith('/wartung') ||
    pathname.startsWith('/settings')
  ) {
    return 'system'
  }
  return 'home'
}

/**
 * Old route prefix → its current name; normalized via replaceState so the address bar and
 * history stay clean. Suffixes (page paths, ?filter=) ride along - `/inbox?filter=failed`
 * becomes `/?filter=failed`, which Home applies exactly as the Inbox did.
 */
const LEGACY_ROUTES: Array<[string, string]> = [
  ['/vault/page/', '/page/'],
  ['/vault', '/graph'],
  ['/ingestion', '/'],
  ['/inbox', '/'],
  ['/wartung', '/system'],
  ['/maintenance', '/system'],
  ['/health', '/system'],
  ['/settings', '/system'],
  ['/chat', '/research'],
]

export function App(): React.ReactElement {
  const path = usePath()
  const screen = screenForPath(path)
  // One SSE connection for the whole app; drives live invalidation + the connection dot.
  const { connected } = useEvents()

  // Outstanding work for the Home badge - a running ingest is otherwise invisible from
  // every other screen. Rides the shared ['stats'] query (SSE keeps it fresh).
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const outstanding = (stats.data?.queue.active ?? 0) + (stats.data?.queue.queued ?? 0)
  const running = (stats.data?.queue.active ?? 0) > 0
  const vaultName = stats.data?.vaultName ?? 'vault'

  // Agent runs in flight, server-side truth. Ingests are only half the work the service
  // does; a research run was previously invisible from every screen but the one that
  // started it, and vanished from that one on reload.
  const runs = useActiveRuns()
  const researchRunning = runs.countOf('research')

  // System badge: due/recommended from the deterministic status model (shared queries).
  const maint = useMaintenanceStatus()
  const healthDue = maint.data?.status.due ?? 0
  const healthRec = maint.data?.status.recommended ?? 0

  // First-run setup mode: the server runs without a credential and every agent feature is
  // off - surface that on every screen, with the path to fix it (System → Integrations).
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const setupMode = health.data ? !health.data.credentialConfigured : false

  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Screens stay MOUNTED and are hidden via [hidden] - unmounting threw away the graph
  // camera, the active chat session, filters and scroll positions on every switch.
  // The vault screen keeps its last inner route while other screens own the URL; null
  // until first visited, so the lazy chunk still loads on demand.
  const [vaultPath, setVaultPath] = useState<string | null>(() => (screen === 'vault' ? path : null))
  useEffect(() => {
    if (screen === 'vault') setVaultPath(path)
  }, [screen, path])

  // Normalize legacy routes so the address bar and history show the current ones.
  useEffect(() => {
    const pathname = path.split('?')[0]!
    const legacy = LEGACY_ROUTES.find(([old]) => pathname.startsWith(old))
    if (legacy) {
      const [oldPrefix, newPrefix] = legacy
      navigate(newPrefix + path.slice(oldPrefix.length), { replace: true })
    }
  }, [path])

  const openPage = pageFromPath(path.split('?')[0]!)
  const query = new URLSearchParams(path.split('?')[1] ?? '')

  const badgeFor = (id: ScreenId): React.ReactElement | null => {
    if (id === 'home' && outstanding > 0) {
      return (
        <span className="tab-badge" aria-label={`${outstanding} jobs outstanding`}>
          {running && <span className="pulse" aria-hidden />}
          {outstanding}
        </span>
      )
    }
    if (id === 'research' && researchRunning > 0) {
      return (
        <span
          className="tab-badge research"
          aria-label={`${researchRunning} research run${researchRunning > 1 ? 's' : ''} active`}
        >
          <span className="pulse" aria-hidden />
          {researchRunning}
        </span>
      )
    }
    if (id === 'system' && healthDue + healthRec > 0) {
      return (
        <span
          className={`tab-badge${healthDue > 0 ? ' due' : ''}`}
          aria-label={`${healthDue + healthRec} maintenance items open`}
        >
          {healthDue > 0 ? healthDue : healthRec}
        </span>
      )
    }
    return null
  }

  return (
    <div className="app">
      <div className="main">
        <header className="topbar">
          <button className="brand" onClick={() => navigate('/')} title="BrainVault home">
            <Icon name="logo" />
            <span className="name">BrainVault</span>
          </button>
          {/* Navigation, not a tab widget: each entry is a route, and the screens are not
              tabpanels - so `aria-current`, the same contract the sidebar had. */}
          <nav className="tabs" aria-label="Primary">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className="tab"
                aria-current={screen === tab.id ? 'page' : undefined}
                onClick={() => navigate(tab.route)}
              >
                <Icon name={tab.icon} />
                {tab.label}
                {badgeFor(tab.id)}
              </button>
            ))}
          </nav>
          <div className="topright">
            <span className="tstat" title={stats.data?.watcher.folder}>
              <span className={`d ${stats.data?.watcher.active === true ? 'ok' : 'warn'}`} />
              Watcher {stats.data?.watcher.active === true ? 'active' : 'off'}
            </span>
            {stats.data !== undefined && (
              <span className="tstat">
                <span className="d acc" />
                {stats.data.pages.total} pages
              </span>
            )}
            <StatusPopover connected={connected} />
          </div>
        </header>

        {setupMode && (
          <div className="setup-banner" role="status">
            <strong>Almost there:</strong>&nbsp;no Anthropic credential configured yet - ingestion,
            research and maintenance are paused.
            <button className="btn primary" onClick={() => navigate('/system?section=integrations')}>
              Set up now
            </button>
          </div>
        )}

        <div className="screens">
          {/* Every screen is the same workspace shape now: one control column, one content
              box, no bar spanning both - so switching screens never shifts the edges. */}
          <section className="screen flush" hidden={screen !== 'home'} aria-label="Home">
            <div className="lane wide">
              <Home statusFilter={screen === 'home' ? (query.get('filter') ?? '') : ''} />
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'research'} aria-label="Research">
            <div className="lane wide">
              <Chat researchPrefill={screen === 'research' ? (query.get('prefill') ?? '') : ''} />
            </div>
          </section>
          {/* The vault screen hosts two very different things. The graph is a workspace: it
              fills the viewport and scrolls inside its own panels, so it takes `flush`. An
              article is a document and scrolls normally, so it does not. */}
          <section
            className={`screen${screen === 'vault' && openPage === null ? ' flush' : ''}`}
            hidden={screen !== 'vault'}
            aria-label="Vault"
          >
            <div className="lane wide">
              {vaultPath !== null && (
                <Suspense fallback={<div className="empty">Loading vault view…</div>}>
                  <Vault path={vaultPath} />
                </Suspense>
              )}
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'library'} aria-label="Library">
            <div className="lane wide">
              <Library vaultName={vaultName} />
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'system'} aria-label="System">
            <div className="lane wide">
              <System section={screen === 'system' ? (query.get('section') ?? '') : ''} />
            </div>
          </section>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GlobalDrop />
    </div>
  )
}
