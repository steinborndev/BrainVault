/**
 * Screenshot the dashboard screens for the README, at retina scale, from a running service.
 *
 * Pair it with `demo-vault.mjs` so the pictures show a synthetic vault instead of real
 * notes (the README's first set leaked page titles into a public repo). Full recipe:
 *
 *   node scripts/demo-vault.mjs
 *   cd server && VAULT_ROOT=~/.local/share/vault-service/demo-vault \
 *     DB_PATH=~/.local/share/vault-service/demo-jobs.db PORT=8421 \
 *     TELEGRAM_BOT_TOKEN= CLAUDE_CODE_OAUTH_TOKEN=demo node dist/main.js &
 *   ~/.cache/ms-playwright/chromium-*\/chrome-linux64/chrome --headless --disable-gpu \
 *     --no-sandbox --remote-debugging-port=9333 --user-data-dir=/tmp/shoot-profile about:blank &
 *   node --experimental-websocket scripts/shoot-screens.mjs
 *
 * `TELEGRAM_BOT_TOKEN=` is not optional: without it the demo process picks the real token
 * out of the service env file and starts a second poller, which knocks the real bot off
 * its own token (Telegram allows exactly one consumer).
 *
 * Waiting is done on the DOM, never on the network: the dashboard holds an SSE connection
 * open forever, so `networkidle` never fires and `--virtual-time-budget` never expires.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8421'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333'
const OUT = process.env.OUT_DIR ?? 'docs/img'
/** 2x of a 1440x900 window - the size the README renders at, on a retina display. */
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1440)
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900)
const SCALE = Number(process.env.SHOT_SCALE ?? 2)

/**
 * `settle` is what the screen has to reach before the shutter fires, evaluated in the page.
 * The graph is the reason this exists: its force layout animates in, and a shot taken too
 * early catches the nodes still flying apart.
 */
const SHOTS = [
  {
    file: 'home.png',
    route: '/',
    settle: `document.querySelectorAll('.fact').length > 2 && document.querySelectorAll('table.dtable tbody tr').length > 3`,
    hold: 2500,
  },
  {
    file: 'graph.png',
    route: '/graph',
    // Any canvas, not the first: the screen also mounts a zero-sized offscreen one, and
    // querySelector picks that up and never settles.
    settle: `[...document.querySelectorAll('canvas')].some((c) => c.getBoundingClientRect().height > 300)`,
    hold: 9000,
  },
  {
    file: 'research.png',
    route: '/research',
    settle: `document.querySelectorAll('table.dtable tbody tr').length > 1`,
    hold: 2000,
  },
  {
    file: 'library.png',
    route: '/library',
    settle: `document.querySelectorAll('table.dtable tbody tr').length > 8`,
    hold: 2000,
  },
  {
    file: 'system.png',
    route: '/system?section=vault',
    settle: `document.querySelectorAll('.subcard, .fact, .setting').length > 2`,
    hold: 2500,
  },
]

const targets = await (await fetch(`${CDP}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) {
  console.error('No page target on the CDP port - is Chromium running with --remote-debugging-port?')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: SCALE,
  mobile: false,
})

for (const shot of SHOTS) {
  await send('Page.navigate', { url: BASE + shot.route })
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500)
    ready = (await evaluate(shot.settle)) === true
  }
  if (!ready) {
    console.error(`${shot.file}: never settled - shooting anyway`)
  }
  // Let animations (graph layout, chart reveal, count-ups) finish before the shutter.
  await sleep(shot.hold)
  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!result?.data) {
    console.error(`${shot.file}: no image data`)
    continue
  }
  const buf = Buffer.from(result.data, 'base64')
  writeFileSync(join(OUT, shot.file), buf)
  console.log(`${shot.file.padEnd(14)} ${String(Math.round(buf.length / 1024)).padStart(5)} KB  ${shot.route}`)
}

ws.close()
console.log(`\nWrote ${SHOTS.length} screenshots to ${OUT}/ at ${WIDTH}x${HEIGHT}@${SCALE}x.`)
