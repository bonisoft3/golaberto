import assert from 'node:assert/strict'
import * as path from 'node:path'
import { prepareRelease, runtimeRoot, writeEdgeSsr } from './publish-cloudflare.ts'

Deno.test('Golaberto publishing requires its existing secret and composes both deployment policies', async () => {
  const root = await Deno.makeTempDir()
  const out = path.join(root, 'cloudflare')
  try {
    await Deno.mkdir(path.join(out, 'src'), { recursive: true })
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/_headers'), "/\n  Content-Security-Policy: script-src 'self'\n")
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
      assets: {}, routes: [{ pattern: 'golaberto.bonisoft3.com', custom_domain: true }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
    }))
    await writeEdgeSsr(out, await runtimeRoot('omnishell'), await runtimeRoot('mecha'), 'golaberto', 'https://golaberto.bonisoft3.com', [], 'existing', 'disabled')
    const entry = path.join(out, 'src/index.ts')
    const original = await Deno.readTextFile(entry)
    await assert.rejects(() => prepareRelease(out), Deno.errors.NotFound)
    assert.equal(await Deno.readTextFile(entry), original)
    const secret = path.join(root, '.jwt-secret')
    await Deno.writeTextFile(secret, '   ')
    await assert.rejects(() => prepareRelease(out), /existing production JWT secret/)
    await Deno.writeTextFile(secret, 'existing-secret')
    await prepareRelease(out)
    const source = await Deno.readTextFile(entry)
    assert.match(source, /export \{ Cluster \} from '\.\/combined-database\.ts'/)
    assert.match(source, /purpose'\) === 'prefetch'\) return new Response\(null, \{ status: 204/)
    assert.equal(await Deno.readTextFile(secret), 'existing-secret')
    await assert.rejects(() => prepareRelease(out), /Cloudflare entry changed/)
    assert.equal(await Deno.readTextFile(entry), source)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
