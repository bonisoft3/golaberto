import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as path from 'node:path'
import { combineRenderer } from './cloudflare-combined.ts'
import { runtimeRoot, writeEdgeSsr } from './publish-cloudflare.ts'

Deno.test('combined Golaberto deployment retains storage identity and isolates renderer fetching', async () => {
  const out = await Deno.makeTempDir()
  const nativeFetch = globalThis.fetch
  const omnishell = await runtimeRoot('omnishell')
  const mecha = await runtimeRoot('mecha')
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/_headers'), "/\n  Content-Security-Policy: script-src 'self'\n")
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
      assets: {}, routes: [{ pattern: 'golaberto.bonisoft3.com', custom_domain: true }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
    }))
    await writeEdgeSsr(out, omnishell, mecha, 'golaberto', 'https://golaberto.bonisoft3.com', [], 'existing', 'disabled')
    const before = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    const database = await Deno.readTextFile(path.join(out, 'src/database.ts'))
    await combineRenderer(out, omnishell, mecha)
    const after = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    for (const key of ['name', 'durable_objects', 'migrations', 'routes', 'rules']) assert.deepEqual(after[key], before[key])
    assert.equal(await Deno.readTextFile(path.join(out, 'src/database.ts')), database)
    assert.match(database, /clock: "disabled"/)
    assert.ok(after.compatibility_flags.includes('nodejs_als'))
    assert.match(await Deno.readTextFile(path.join(out, 'src/index.ts')), /export \{ Cluster \} from '\.\/combined-database\.ts'/)
    for (const [key, value] of Object.entries(before.alias)) assert.equal(after.alias[key], value)

    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let owner: unknown
    const snapshot = { revision: 'public-revision', read: () => Promise.resolve([{ name: 'Public' }]) }
    class Database {
      readPublic(use: (value: typeof snapshot) => unknown) { return use(snapshot) }
    }
    class Capacity extends Error {}
    class Loading extends Error {}
    globalThis.fetch = () => Promise.resolve(new Response('native'))
    const appRenderer = () => {
      globalThis.fetch = input => {
        if (String(input) !== 'https://golaberto.bonisoft3.com/known-asset') throw new Error('unknown render asset')
        return Promise.resolve(new Response('asset'))
      }
      return async (_request: Request, reader: typeof snapshot) => {
        assert.equal(reader, snapshot)
        entered()
        await blocked
        assert.equal(await (await fetch('https://golaberto.bonisoft3.com/known-asset')).text(), 'asset')
        await assert.rejects(async () => await fetch('https://outside.example/'), /unknown render asset/)
        return { html: 'Public', status: 200 }
      }
    }
    const renderObject = (draw: ReturnType<typeof appRenderer>) => class {
      async render(request: Request, revision: string, reader: typeof snapshot) {
        owner = this
        assert.equal(revision, snapshot.revision)
        const result = await draw(request, reader)
        return new Response(result.html, { status: result.status })
      }
    }
    const source = (await Deno.readTextFile(path.join(out, 'src/combined-database.ts')))
      .replace(/^import .+\n/gm, '').replace('export class Cluster', 'class Cluster') + '\nreturn Cluster'
    const Cluster = new Function('AsyncLocalStorage', 'appRenderer', 'renderObject', 'DatabaseCluster', 'DataDirectoryLoading', 'PublicSnapshotCapacity', 'assets', source)(
      AsyncLocalStorage, appRenderer, renderObject, Database, Loading, Capacity, {},
    )
    const cluster = new Cluster()
    const pending = cluster.render(new Request('https://golaberto.bonisoft3.com/'))
    await ready
    assert.equal(await (await fetch('https://outside.example/')).text(), 'native')
    release()
    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'Public')
    assert.equal(owner, cluster)
    for (const Failure of [Loading, Capacity]) {
      const failing = new Cluster()
      failing.readPublic = () => { throw new Failure('busy') }
      const head = await failing.render(new Request('https://golaberto.bonisoft3.com/', { method: 'HEAD' }))
      assert.equal(head.status, 503)
      assert.equal(head.headers.get('retry-after'), '1')
      assert.equal(await head.text(), '')
    }
    const broken = new Cluster()
    broken.readPublic = () => { throw new Error('query failed') }
    await assert.rejects(() => broken.render(new Request('https://golaberto.bonisoft3.com/')), /query failed/)
  } finally {
    globalThis.fetch = nativeFetch
    await Deno.remove(out, { recursive: true })
  }
})
