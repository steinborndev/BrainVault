import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev: proxy `/api` to the Fastify server on :8420 so the SPA is one origin in dev too
 * (SSE included — `changeOrigin` + no buffering). Build: emit to `web/dist`, which the
 * server serves via @fastify/static so the whole app is one origin on 127.0.0.1:8420
 * (TASKS-M3 §2, DoD "one origin").
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8420',
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity'))
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
