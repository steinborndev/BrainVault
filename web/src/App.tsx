import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client.ts'
import { useEvents } from './hooks/useEvents.ts'
import { useMaintenanceStatus } from './hooks/useMaintenanceStatus.ts'
import { StatusPopover } from './components/StatusPopover.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { GlobalDrop } from './components/GlobalDrop.tsx'
import { Home } from './tabs/Home.tsx'
import { Ingestion } from './tabs/Ingestion.tsx'
import { Chat } from './tabs/Chat.tsx'
import { Maintenance } from './tabs/Maintenance.tsx'
import { Library } from './tabs/Library.tsx'
import { Settings } from './tabs/Settings.tsx'
import { Icon, type IconName } from './components/Icon.tsx'
import { usePath, navigate, pageFromPath } from './lib/router.ts'

// Code-split: the vault viewer pulls in d3-force + the canvas machinery, which the other
// screens never need - keep the shell light.
const Vault = lazy(() => import('./tabs/Vault.tsx').then((m) => ({ default: m.Vault })))

/**
 * Screen ids of the sidebar shell (redesign 2026-08). Three groups replace the old five
 * flat tabs: Knowledge is what you browse, Work is what you do, System is what you tend
 * and configure. `vault` hosts both the graph and the page view (they share state).
 */
type ScreenId = 'home' | 'library' | 'vault' | 'research' | 'inbox' | 'health' | 'settings'

interface NavItem {
  id: ScreenId
  label: string
  icon: IconName
  route: string
}

const NAV_GROUPS: Array<{ label: string | null; items: NavItem[] }> = [
  { label: null, items: [{ id: 'home', label: 'Home', icon: 'home', route: '/' }] },
  {
    label: 'Knowledge',
    items: [
      { id: 'library', label: 'Library', icon: 'book', route: '/library' },
      { id: 'vault', label: 'Graph', icon: 'graph', route: '/graph' },
    ],
  },
  {
    label: 'Work',
    items: [
      { id: 'research', label: 'Research', icon: 'flask', route: '/research' },
      { id: 'inbox', label: 'Inbox', icon: 'inbox', route: '/inbox' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'health', label: 'Health', icon: 'health', route: '/health' },
      { id: 'settings', label: 'Settings', icon: 'gear', route: '/settings' },
    ],
  },
]

/** Which screen a path belongs to (the vault screen owns /graph and /page/…). */
function screenForPath(path: string): ScreenId {
  const pathname = path.split('?')[0]!
  if (pathname.startsWith('/page/') || pathname.startsWith('/graph') || pathname.startsWith('/vault')) return 'vault'
  if (pathname.startsWith('/library')) return 'library'
  // `/chat` is the pre-rename route, `/research` the current one.
  if (pathname.startsWith('/research') || pathname.startsWith('/chat')) return 'research'
  if (pathname.startsWith('/inbox') || pathname.startsWith('/ingestion')) return 'inbox'
  if (pathname.startsWith('/health') || pathname.startsWith('/maintenance') || pathname.startsWith('/wartung')) return 'health'
  if (pathname.startsWith('/settings')) return 'settings'
  return 'home'
}

/**
 * Old route prefix → its current name; normalized via replaceState so the address bar and
 * history stay clean. Suffixes (page paths, ?focus=) ride along.
 */
const LEGACY_ROUTES: Array<[string, string]> = [
  ['/vault/page/', '/page/'],
  ['/vault', '/graph'],
  ['/ingestion', '/inbox'],
  ['/wartung', '/health'],
  ['/maintenance', '/health'],
  ['/chat', '/research'],
]

const SCREEN_TITLES: Record<ScreenId, string> = {
  home: 'Home',
  library: 'Library',
  vault: 'Graph',
  research: 'Research',
  inbox: 'Inbox',
  health: 'Health',
  settings: 'Settings',
}

export function App(): React.ReactElement {
  const path = usePath()
  const screen = screenForPath(path)
  // One SSE connection for the whole app; drives live invalidation + the connection dot.
  const { connected } = useEvents()

  // Outstanding work for the Inbox badge - running ingests are otherwise invisible
  // from every other screen. Rides the shared ['stats'] query (SSE keeps it fresh).
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const outstanding = (stats.data?.queue.active ?? 0) + (stats.data?.queue.queued ?? 0)
  const running = (stats.data?.queue.active ?? 0) > 0
  const vaultName = stats.data?.vaultName ?? 'vault'

  // Health badge: due/recommended from the deterministic status model (shared queries).
  const maint = useMaintenanceStatus()
  const healthDue = maint.data?.status.due ?? 0
  const healthRec = maint.data?.status.recommended ?? 0

  // First-run setup mode: the server runs without a credential and every agent feature is
  // off - surface that on every screen, with the path to fix it (Settings).
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

  // On a page route the vault screen is showing an article, not the canvas - the topbar
  // must say so rather than claiming "Graph".
  const openPage = pageFromPath(path.split('?')[0]!)
  const screenTitle = screen === 'vault' && openPage !== null ? 'Page' : SCREEN_TITLES[screen]

  // The topbar context line: screen name plus a short state summary where one exists.
  const crumbSub =
    openPage !== null && screen === 'vault'
      ? openPage.replace(/^wiki\//, '').replace(/\.md$/, '')
      : screen === 'inbox' && outstanding > 0
      ? `${outstanding} outstanding`
      : screen === 'health' && healthDue + healthRec > 0
        ? [healthDue > 0 ? `${healthDue} due` : '', healthRec > 0 ? `${healthRec} soon` : ''].filter(Boolean).join(' · ')
        : screen === 'library' && stats.data !== undefined
          ? `${stats.data.pages.total} pages`
          : ''

  return (
    <div className="app">
      <nav className="side" aria-label="Primary">
        <button className="side-brand" onClick={() => navigate('/')} title="BrainVault home">
          <Icon name="logo" />
          <span className="name">BrainVault</span>
        </button>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label ?? 'top'} className={`navgroup${gi === 0 ? ' first' : ''}`}>
            {group.label !== null && <div className="glabel">{group.label}</div>}
            {group.items.map((item) => (
              <button
                key={item.id}
                className="navitem"
                aria-current={screen === item.id ? 'page' : undefined}
                onClick={() => navigate(item.route)}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.id === 'inbox' && outstanding > 0 && (
                  <span className="tab-badge" aria-label={`${outstanding} jobs outstanding`}>
                    {running && <span className="pulse" aria-hidden />}
                    {outstanding}
                  </span>
                )}
                {item.id === 'health' && healthDue + healthRec > 0 && (
                  <span
                    className={`tab-badge${healthDue > 0 ? ' due' : ''}`}
                    aria-label={`${healthDue + healthRec} maintenance items open`}
                  >
                    {healthDue > 0 ? healthDue : healthRec}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        <div className="side-foot">
          <div className="row">
            <span className={`d ${stats.data?.watcher.active === true ? 'ok' : 'warn'}`} />
            Watcher {stats.data?.watcher.active === true ? 'active' : 'inactive'}
          </div>
          {stats.data !== undefined && (
            <div className="row">
              <span className="d acc" />
              {stats.data.pages.total} pages
            </div>
          )}
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1 className="whereami">
            <span className="where">{screenTitle}</span>
            {crumbSub !== '' && <span className="sub">{crumbSub}</span>}
          </h1>
          <span className="spacer" />
          <button className="searchbtn" onClick={() => setPaletteOpen(true)} aria-haspopup="dialog">
            <Icon name="search" />
            Search pages, jump anywhere…
            <kbd>Ctrl K</kbd>
          </button>
          <StatusPopover connected={connected} />
        </header>

        {setupMode && (
          <div className="setup-banner" role="status">
            <strong>Almost there:</strong>&nbsp;no Anthropic credential configured yet - ingestion,
            research and maintenance are paused.
            <button className="btn primary" onClick={() => navigate('/settings')}>
              Set up now
            </button>
          </div>
        )}

        <div className="screens">
          <section className="screen" hidden={screen !== 'home'} aria-label="Home">
            <div className="lane">
              <Home />
            </div>
          </section>
          <section className="screen" hidden={screen !== 'library'} aria-label="Library">
            <div className="lane">
              <Library vaultName={vaultName} />
            </div>
          </section>
          <section className="screen" hidden={screen !== 'vault'} aria-label="Vault">
            <div className="lane wide">
              {vaultPath !== null && (
                <Suspense fallback={<div className="empty">Loading vault view…</div>}>
                  <Vault path={vaultPath} />
                </Suspense>
              )}
            </div>
          </section>
          <section className="screen" hidden={screen !== 'research'} aria-label="Research">
            <div className="lane">
              <Chat researchPrefill={screen === 'research' ? (new URLSearchParams(path.split('?')[1] ?? '').get('prefill') ?? '') : ''} />
            </div>
          </section>
          <section className="screen" hidden={screen !== 'inbox'} aria-label="Inbox">
            <div className="lane">
              <Ingestion statusFilter={screen === 'inbox' ? (new URLSearchParams(path.split('?')[1] ?? '').get('filter') ?? '') : ''} />
            </div>
          </section>
          <section className="screen" hidden={screen !== 'health'} aria-label="Health">
            <div className="lane">
              <Maintenance />
            </div>
          </section>
          <section className="screen" hidden={screen !== 'settings'} aria-label="Settings">
            <div className="lane">
              <Settings />
            </div>
          </section>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GlobalDrop />
    </div>
  )
}
