// Load on a GolAberto edge release, as guests browsing.
//
//   capture <origin> <reads.json> <path>…   a browser visits each screen and
//     records its reads: CRUD GETs and the shape requests a fresh stream makes
//   run <origin> <reads.json> --guests N --seconds S
//     N guests at once, each its own session and shape tokens, open screens at
//     random and replay their reads six at a time, as a browser does over its
//     connection, a second apart; prints one JSON line with latency
//     percentiles per kind, errors and the Worker's cache answers.
//
// Live requests are left out: each holds a connection open for 20 s and costs
// the object a timer, not a query.
const [mode, origin, file, ...rest] = Deno.args
if (!mode || !origin || !file) throw new Error('usage: edge_load.ts capture <origin> <reads.json> <path>… | run <origin> <reads.json> --guests N --seconds S')

if (mode === 'capture') {
  const { chromium } = await import('npm:playwright@1.61.1')
  const browser = await chromium.launch()
  const screens: Record<string, string[]> = {}
  for (const p of rest) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const reads: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (r.method() !== 'GET') return
      if (u.pathname.startsWith('/crud/')) reads.push(u.pathname + u.search)
      if (u.pathname === '/electric/v1/shape' && !u.searchParams.has('handle') && u.searchParams.get('live') !== 'true') reads.push(u.pathname + u.search)
    })
    await page.goto(`${origin}${p}`)
    await page.waitForTimeout(8000)
    screens[p] = reads
    await context.close()
  }
  await browser.close()
  await Deno.writeTextFile(file, JSON.stringify(screens, null, 1) + '\n')
  Deno.exit(0)
}
if (mode !== 'run') throw new Error(`unknown mode ${mode}`)

const flag = (f: string) => { const i = rest.indexOf(f); if (i < 0) throw new Error(`${f} is required`); return Number(rest[i + 1]) }
const guests = flag('--guests')
const seconds = flag('--seconds')
const screens = Object.entries(JSON.parse(await Deno.readTextFile(file)) as Record<string, string[]>)
const deadline = performance.now() + seconds * 1000
const samples: Record<string, number[]> = {}
const statuses: Record<string, number> = {}
const caches: Record<string, number> = {}
let screensOpened = 0

const json = async (res: Response) => {
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.url}: ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function guest() {
  const { token } = await json(await fetch(`${origin}/auth/guest`, { method: 'POST' }))
  const bearer = { authorization: `Bearer ${token}` }
  const shapeTokens = new Map<string, Promise<{ token: string; where: string }>>()
  const shapeToken = (table: string) => {
    let t = shapeTokens.get(table)
    if (!t) shapeTokens.set(table, t = fetch(`${origin}/auth/shape`, { method: 'POST', headers: bearer, body: JSON.stringify({ table }) }).then(json))
    return t
  }
  const read = async (path: string) => {
    const u = new URL(path, origin)
    let headers = bearer
    let kind = 'crud'
    if (u.pathname === '/electric/v1/shape') {
      kind = 'shape'
      const t = await shapeToken(u.searchParams.get('table')!)
      u.searchParams.set('where', t.where)
      headers = { authorization: `Bearer ${t.token}` }
    }
    const t0 = performance.now()
    let status = 'network'
    try {
      const res = await fetch(u, { headers })
      await res.arrayBuffer()
      status = String(res.status)
      const cache = res.headers.get('x-edge-cache') ?? 'none'
      caches[`${kind}:${cache}`] = (caches[`${kind}:${cache}`] ?? 0) + 1
    } finally {
      ;(samples[kind] ??= []).push(performance.now() - t0)
      statuses[status] = (statuses[status] ?? 0) + 1
    }
  }
  while (performance.now() < deadline) {
    const [, reads] = screens[Math.floor(Math.random() * screens.length)]
    const queue = [...reads]
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await read(p).catch(() => {})
    }))
    screensOpened++
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const t0 = performance.now()
await Promise.all(Array.from({ length: guests }, guest))
const pct = (xs: number[], q: number) => Math.round(xs[Math.min(xs.length - 1, Math.floor(q * xs.length))])
const latency = Object.fromEntries(Object.entries(samples).map(([k, xs]) => {
  xs.sort((a, b) => a - b)
  return [k, { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: Math.round(xs[xs.length - 1]) }]
}))
const total = Object.values(statuses).reduce((a, b) => a + b, 0)
const errors = Object.entries(statuses).filter(([s]) => !s.startsWith('2')).reduce((a, [, n]) => a + n, 0)
console.log(JSON.stringify({
  guests, seconds: Math.round((performance.now() - t0) / 1000), screensOpened, requests: total,
  rps: +(total / ((performance.now() - t0) / 1000)).toFixed(1), errorRate: +(errors / total).toFixed(4), statuses, caches, latency,
}))
