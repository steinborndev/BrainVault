/**
 * Open every dashboard screen in a headless browser and report what actually rendered.
 *
 * This exists because a green `tsc` + `vite build` + unit-test run says nothing about whether
 * a screen shows anything (see TASKS-UI-SWEEP.md: a shared component that always returned an
 * element blanked all five screens while every check stayed green).
 *
 * Usage - the service must be running, and Chromium must be listening on the CDP port:
 *
 *   ~/.cache/ms-playwright/chromium-*\/chrome-linux64/chrome --headless --disable-gpu \
 *     --no-sandbox --remote-debugging-port=9333 --user-data-dir=/tmp/probe-profile about:blank &
 *   node --experimental-websocket scripts/probe-screens.mjs
 *
 * `--experimental-websocket` is needed on Node 20; Node 22 has WebSocket by default. No
 * dependencies, and nothing is installed - it reuses the Chromium the Playwright cache
 * already holds. Note that `--dump-dom` and `--virtual-time-budget` do NOT work against this
 * app: the SSE connection never closes, so virtual time never runs out.
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8420'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333'
const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/research', '/graph', '/library', '/system?section=checks', '/system?section=usage',
     '/system?section=vault', '/system?section=service', '/system?section=integrations']

const targets = await (await fetch(`${CDP}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('No page target on the CDP port - is Chromium running with --remote-debugging-port?')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

/** What counts as "this screen rendered something": read from the live DOM. */
const REPORT = `(() => {
  const screen = [...document.querySelectorAll('.screen')].find((s) => !s.hasAttribute('hidden'))
  if (!screen) return { ready: false }
  const box = screen.querySelector('.box, .graph-main, .vault-graph')
  const text = (screen.querySelector('.box-body, .graph-main')?.innerText ?? '').trim()
  return {
    ready: true,
    rows: screen.querySelectorAll('table.dtable tbody tr').length,
    panelRows: screen.querySelectorAll('.gpanel .domrow, .gpanel .chip, .gpanel .viewpill').length,
    settings: screen.querySelectorAll('.setting').length,
    subcards: screen.querySelectorAll('.subcard').length,
    figures: screen.querySelectorAll('.fact').length,
    canvas: Math.round(screen.querySelector('canvas')?.getBoundingClientRect().height ?? 0),
    boxHeight: Math.round(box?.getBoundingClientRect().height ?? 0),
    chars: text.length,
    empties: [...screen.querySelectorAll('.empty')].map((e) => e.textContent.trim().slice(0, 48)),
  }
})()`

let failures = 0
for (const route of ROUTES) {
  await send('Page.navigate', { url: BASE + route })
  let report = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true })
    report = r.result?.result?.value
    if (!report?.ready) continue
    const rendered =
      report.rows || report.canvas || report.settings || report.subcards || report.chars > 40
    if (rendered || report.empties.length) break
  }
  const blank =
    !report?.ready ||
    (!report.rows && !report.canvas && !report.settings && !report.subcards && report.chars < 40)
  if (blank) failures++
  console.log(`${blank ? 'BLANK' : 'ok   '} ${route.padEnd(30)} ${JSON.stringify(report)}`)
}

ws.close()
if (failures > 0) {
  console.error(`\n${failures} screen(s) rendered nothing.`)
  process.exit(1)
}
console.log('\nEvery screen rendered content.')
