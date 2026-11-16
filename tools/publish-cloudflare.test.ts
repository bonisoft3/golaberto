import assert from 'node:assert/strict'
import * as path from 'node:path'
import { writeEdgeSsr } from '@bonisoft3/pronto/bundle/edge-ssr.ts'
import { prepareRelease, publishOptions, runtimeRoot } from './publish-cloudflare.ts'

Deno.test('Golaberto publishing preserves shared rendering and hosted JWT policy', async () => {
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
    await prepareRelease(out)
    const prepared = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.equal(prepared.limits.cpu_ms, 300_000)
    assert.match(await Deno.readTextFile(path.join(out, 'src/database.ts')), /storageFormat: \{ version: 1, blockSize: 8192, codec: 'deflate' \}/)
    assert.deepEqual(prepared.routes, [{ pattern: 'golaberto.bonisoft3.com', custom_domain: true }])
    const source = await Deno.readTextFile(entry)
    assert.match(source, /export \{ Cluster \} from '\.\/database\.ts'/)
    assert.ok(prepared.durable_objects.bindings.find((binding: { name: string; script_name?: string }) => binding.name === 'RENDERER')?.script_name)
    await assert.rejects(() => Deno.stat(path.join(out, 'src/combined-database.ts')), Deno.errors.NotFound)
    assert.equal(source, original)
    await assert.rejects(() => Deno.stat(path.join(root, '.jwt-secret')), Deno.errors.NotFound)
    await assert.rejects(() => prepareRelease(out), /Cloudflare database entry changed/)
    assert.equal(await Deno.readTextFile(entry), source)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Golaberto JWT retention is an explicit independent publishing option', () => {
  assert.deepEqual(publishOptions(['release']), { directory: 'release', prepareOnly: false, keepJwtSecret: false, reset: false })
  assert.deepEqual(publishOptions(['release', '--keep-jwt-secret']), { directory: 'release', prepareOnly: false, keepJwtSecret: true, reset: false })
  assert.deepEqual(publishOptions(['release', '--prepare-only', '--keep-jwt-secret']), { directory: 'release', prepareOnly: true, keepJwtSecret: true, reset: false })
  assert.deepEqual(publishOptions(['release', '--keep-jwt-secret', '--prepare-only']), { directory: 'release', prepareOnly: true, keepJwtSecret: true, reset: false })
  for (const flags of [['--temporary'], ['--keep-jwt-secret', '--keep-jwt-secret']]) {
    assert.throws(() => publishOptions(['release', ...flags]), /publish-cloudflare.ts/)
  }
})

Deno.test('Golaberto reset explicitly replaces the database and refuses JWT retention', () => {
  assert.deepEqual(publishOptions(['release', '--reset']), { directory: 'release', prepareOnly: false, keepJwtSecret: false, reset: true })
  assert.throws(() => publishOptions(['release', '--reset', '--keep-jwt-secret']), /cannot be combined/)
})

Deno.test('generated releases omit automatic Cloudflare publication and retain container targets', async () => {
  const recipe = await Deno.readTextFile(new URL('../.say.yaml', import.meta.url))
  const release = recipe.split('\n  release:\n')[1]?.split(/\n  [\w-]+:\n/)[0]
  assert.ok(release, 'generated recipe must declare releases')
  assert.equal(release.includes('      cloudflare:\n'), false, 'Cloudflare release target must be absent while production runs on the GCP VM')
  for (const target of ['gcp', 'k8s']) {
    assert.ok(release.includes(`      ${target}:\n        platform: ${target}\n        cmds:`), `${target} release rule must be emitted`)
    assert.ok(release.includes(`($pronto | path join ${target} release.nu)`), `${target} release must retain its shared publisher`)
  }
})
