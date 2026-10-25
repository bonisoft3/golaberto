import * as path from 'node:path'

export async function combineRenderer(out: string, omnishell: string, mecha: string): Promise<void> {
  const configPath = path.join(out, 'wrangler.jsonc')
  const config = JSON.parse(await Deno.readTextFile(configPath))
  const cluster = config.durable_objects?.bindings.find((binding: { name: string }) => binding.name === 'CLUSTER')
  if (config.name !== 'golaberto' || !config.routes?.some((route: { pattern: string }) => route.pattern === 'golaberto.bonisoft3.com') || cluster?.class_name !== 'Cluster' || cluster.script_name) {
    throw new Error('combined Golaberto rendering requires its existing local Cluster binding')
  }
  const renderer = JSON.parse(await Deno.readTextFile(path.join(out, 'renderer.jsonc')))
  const entryPath = path.join(out, config.main)
  const entry = await Deno.readTextFile(entryPath)
  const exported = "export { Cluster } from './database.ts'"
  if (entry.split(exported).length !== 2) throw new Error('Cloudflare entry changed; review combined rendering')
  const server = path.join(omnishell, 'server')
  const specifier = (file: string) => {
    const relative = path.relative(path.join(out, 'src'), file).replaceAll('\\', '/')
    return relative.startsWith('.') ? relative : './' + relative
  }
  const source = `import '${specifier(path.join(server, 'worker-roles.ts'))}'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appRenderer } from '${specifier(path.join(server, 'worker-document.ts'))}'
import { renderObject } from '${specifier(path.join(server, 'render-object.ts'))}'
import { DataDirectoryLoading } from '${specifier(path.join(mecha, 'packages/mecha-edge/src/object.ts'))}'
import { PublicSnapshotCapacity } from '${specifier(path.join(mecha, 'packages/mecha-edge/src/public-snapshot.ts'))}'
import { Cluster as DatabaseCluster } from './database.ts'
import assets from '../renderer/assets.json'

const nativeFetch = globalThis.fetch
const draw = appRenderer(assets, 'https://golaberto.bonisoft3.com')
const assetFetch = globalThis.fetch
const renderContext = new AsyncLocalStorage()
globalThis.fetch = (...args) => (renderContext.getStore() ? assetFetch : nativeFetch)(...args)
const Renderer = renderObject((request, reader) => renderContext.run(true, () => draw(request, reader)))

export class Cluster extends DatabaseCluster {
  async render(request) {
    try {
      return await this.readPublic(async snapshot => {
        // The renderer's stateless HTTP method preserves its queue, ETag and conditional-response behavior.
        return await Renderer.prototype.render.call(this, request, snapshot.revision, snapshot)
      })
    } catch (error) {
      if (!(error instanceof PublicSnapshotCapacity) && !(error instanceof DataDirectoryLoading)) throw error
      return new Response(request.method === 'HEAD' ? null : error.message, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
    }
  }
}
`
  await Deno.writeTextFile(path.join(out, 'src/combined-database.ts'), source)
  await Deno.writeTextFile(entryPath, entry.replace(exported, "export { Cluster } from './combined-database.ts'"))
  config.alias = { ...config.alias, ...renderer.alias }
  config.compatibility_flags = [...new Set([...(config.compatibility_flags ?? []), 'nodejs_als'])]
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + '\n')
}

if (import.meta.main) {
  const [out, omnishell, mecha] = Deno.args
  if (!out || !omnishell || !mecha || Deno.args.length !== 3) throw new Error('cloudflare-combined.ts <release-directory> <omnishell-directory> <mecha-directory>')
  await combineRenderer(path.resolve(out), path.resolve(omnishell), path.resolve(mecha))
}
