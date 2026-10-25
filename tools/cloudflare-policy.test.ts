import assert from 'node:assert/strict'
import * as path from 'node:path'
import { demandRendering } from './cloudflare-policy.ts'
import { runtimeRoot, writeEdgeSsr } from './publish-cloudflare.ts'

Deno.test('Golaberto prefetches use cached HTML without starting or refreshing a render', async () => {
  const out = await Deno.makeTempDir()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/_headers'), "/\n  Content-Security-Policy: script-src 'self'\n")
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: {} }))
    await writeEdgeSsr(out, await runtimeRoot('omnishell'), await runtimeRoot('mecha'), 'app', 'https://app.example', [])
    const original = await Deno.readTextFile(path.join(out, 'src/index.ts'))
    const source = demandRendering(original).replace(/^import .+\n/gm, '').replace(/^export \{ Cluster \} from .+\n/m, '').replace('export default {', 'return {')
    const worker = new Function('edgeWorker', 'edgeHints', 'acceptedLanguages', 'routeAt', 'hints', source)(
      { fetch: () => new Response('api') }, () => '</boot.js>; rel=preload', () => [],
      (_hints: unknown, pathname: string) => pathname === '/api' ? null : ({ route: { ssr: 'ssr' }, locale: 'pt-BR' }), {},
    )
    const stored = new Map<string, Response>()
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
      match(request: Request) { return Promise.resolve(stored.get(request.url)?.clone()) },
      put(request: Request, response: Response) { stored.set(request.url, response.clone()); return Promise.resolve() },
    } } })
    let renders = 0
    const env = {
      CF_VERSION_METADATA: { id: 'version' },
      RENDERER: { idFromName: String, get: () => ({}) },
      CLUSTER: { idFromName: String, get: () => ({ render() {
        renders++
        return new Response('<h1>Public</h1><script type="application/json" id="pronto-reads">{}</script>', { headers: { etag: '"public"' } })
      } }) },
    }
    const background: Promise<unknown>[] = []
    const ctx = { waitUntil(promise: Promise<unknown>) { background.push(promise) } }
    const visit = (prefetch = false, pathname = '/') => worker.fetch(new Request('https://app.example' + pathname, { headers: prefetch ? { purpose: 'prefetch' } : {} }), env, ctx)
    const missing = await visit(true)
    assert.equal(missing.status, 204)
    assert.equal(await missing.text(), '')
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.equal(renders, 0)
    const demand = await visit()
    assert.equal(demand.status, 200)
    assert.equal(demand.headers.get('x-edge-cache'), 'miss')
    assert.equal(renders, 1)
    const fresh = await visit(true)
    assert.equal(fresh.headers.get('x-edge-cache'), 'hit')
    assert.match(await fresh.text(), /pronto-reads/)
    assert.equal(renders, 1)
    for (const [key, response] of stored) {
      const headers = new Headers(response.headers)
      headers.set('x-rendered-at', String(Date.now() - 61_000))
      stored.set(key, new Response(await response.text(), { headers }))
    }
    const stale = await visit(true)
    assert.equal(stale.headers.get('x-edge-cache'), 'stale')
    assert.equal(stale.headers.get('etag'), null)
    assert.match(await stale.text(), /pronto-reads/)
    assert.equal(background.length, 0)
    assert.equal(renders, 1)
    const actualVisit = await visit()
    assert.equal(actualVisit.headers.get('x-edge-cache'), 'stale')
    assert.doesNotMatch(await actualVisit.text(), /pronto-reads/)
    await Promise.all(background.splice(0))
    assert.equal(renders, 2)
    stored.set('https://edge-cache.invalid/version/0/writes/public', new Response('changed'))
    assert.equal((await visit(true)).status, 204)
    assert.equal(renders, 2)
    assert.equal((await visit()).headers.get('x-edge-cache'), 'miss')
    assert.equal(renders, 3)
    const head = await worker.fetch(new Request('https://app.example/', { method: 'HEAD' }), env, ctx)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    assert.equal(renders, 3)
    const conditional = await worker.fetch(new Request('https://app.example/', { headers: { 'if-none-match': '"public"' } }), env, ctx)
    assert.equal(conditional.headers.get('x-edge-cache'), 'miss')
    assert.equal(renders, 4)
    assert.equal(await (await visit(true, '/api')).text(), 'api')
    assert.throws(() => demandRendering('unexpected generator output'), /Cloudflare entry changed/)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'caches', previous)
    else Reflect.deleteProperty(globalThis, 'caches')
    await Deno.remove(out, { recursive: true })
  }
})
