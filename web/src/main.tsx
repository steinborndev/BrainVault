import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App.tsx'
// Self-hosted type (no CDN - the PWA stays offline-capable): Instrument Sans carries the
// UI, Bricolage Grotesque the display landmarks, IBM Plex Mono the data/log surfaces.
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/bricolage-grotesque/400.css'
import '@fontsource/bricolage-grotesque/600.css'
import '@fontsource/bricolage-grotesque/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'

// Live invalidation comes from SSE (useEvents), so background refetch/polling is off by
// default; queries refetch on demand and when the bus says something changed.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

// Register the service worker (PWA installability, TASKS-M3 §2). Dev servers don't ship it,
// so guard on production.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW is a progressive enhancement - the app works without it */
    })
    // The SW calls skipWaiting(), so a new deploy swaps the controller under a running tab.
    // Reload once so the page and its (possibly already-deleted) old assets can't diverge
    // from the new shell. The guard stops a reload loop.
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    })
  })
}
