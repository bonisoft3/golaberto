import assert from 'node:assert/strict'
import * as path from 'node:path'
import { prepareRelease, requireExistingSecret, runtimeRoot, writeEdgeSsr } from './publish-cloudflare.ts'

Deno.test('Golaberto publishing preserves its migration history and both deployment policies', async () => {
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
    const configPath = path.join(out, 'wrangler.jsonc')
    const fresh = await Deno.readTextFile(configPath)
    const changed = JSON.parse(fresh)
    changed.migrations.push({ tag: 'v2-unexpected', new_sqlite_classes: ['Another'] })
    await Deno.writeTextFile(configPath, JSON.stringify(changed))
    const original = await Deno.readTextFile(entry)
    await assert.rejects(() => prepareRelease(out), /Cloudflare migration history changed/)
    assert.equal(await Deno.readTextFile(entry), original)
    await Deno.writeTextFile(configPath, fresh)
    await assert.rejects(() => requireExistingSecret(out, {}), /existing production JWT secret/)
    await requireExistingSecret(out, { CI: 'true' })
    await requireExistingSecret(out, { JWT_SECRET: 'existing-secret' })
    const secret = path.join(root, '.jwt-secret')
    await Deno.writeTextFile(secret, '   ')
    await assert.rejects(() => requireExistingSecret(out, {}), /existing production JWT secret/)
    await Deno.writeTextFile(secret, 'existing-secret')
    await requireExistingSecret(out, {})
    await prepareRelease(out)
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.deepEqual(config.migrations, [
      { tag: 'v1', new_sqlite_classes: ['Cluster'] },
      { tag: 'v2-compute-coordinator', new_sqlite_classes: ['ComputeCoordinator'] },
      { tag: 'v3-drop-compute-coordinator', deleted_classes: ['ComputeCoordinator'] },
    ])
    const source = await Deno.readTextFile(entry)
    assert.match(source, /export \{ Cluster \} from '\.\/combined-database\.ts'/)
    assert.match(source, /purpose'\) === 'prefetch'\) return new Response\(null, \{ status: 204/)
    assert.equal(await Deno.readTextFile(secret), 'existing-secret')
    await assert.rejects(() => prepareRelease(out), /Cloudflare migration history changed/)
    assert.equal(await Deno.readTextFile(entry), source)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
