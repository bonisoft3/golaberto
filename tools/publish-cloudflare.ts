import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { combineRenderer } from './cloudflare-combined.ts'
import { demandRendering } from './cloudflare-policy.ts'

export async function runtimeRoot(pkg: 'mecha' | 'omnishell' | 'pronto'): Promise<string> {
  const out = await new Deno.Command('mise', { args: ['where', `github:bonisoft3/${pkg}`] }).output()
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || `mise could not locate ${pkg}`)
  return new TextDecoder().decode(out.stdout).trim()
}

export async function writeEdgeSsr(...args: [string, string, string, string, string, unknown[], ('existing' | 'separate')?, ('ticker' | 'disabled')?]): Promise<void> {
  const mod = await import(pathToFileURL(path.join(await runtimeRoot('pronto'), 'bundle/edge-ssr.ts')).href)
  await mod.writeEdgeSsr(...args)
}

const migrationHistory = [
  { tag: 'v1', new_sqlite_classes: ['Cluster'] },
  { tag: 'v2-compute-coordinator', new_sqlite_classes: ['ComputeCoordinator'] },
  { tag: 'v3-drop-compute-coordinator', deleted_classes: ['ComputeCoordinator'] },
]

export async function prepareRelease(out: string): Promise<void> {
  const configPath = path.join(out, 'wrangler.jsonc')
  const config = JSON.parse(await Deno.readTextFile(configPath))
  if (JSON.stringify(config.migrations) !== JSON.stringify(migrationHistory.slice(0, 1))) {
    throw new Error('Cloudflare migration history changed; review GolAberto production history')
  }
  const entryPath = path.join(out, config.main)
  demandRendering(await Deno.readTextFile(entryPath))
  await combineRenderer(out, await runtimeRoot('omnishell'), await runtimeRoot('mecha'))
  const combined = await Deno.readTextFile(entryPath)
  await Deno.writeTextFile(entryPath, demandRendering(combined))
  const combinedConfig = JSON.parse(await Deno.readTextFile(configPath))
  combinedConfig.migrations = migrationHistory
  await Deno.writeTextFile(configPath, JSON.stringify(combinedConfig, null, 2) + '\n')
}

export async function requireExistingSecret(out: string, env = Deno.env.toObject()): Promise<void> {
  if (env.JWT_SECRET?.trim() || env.CI) return
  let secret: string
  try { secret = await Deno.readTextFile(path.join(path.dirname(out), '.jwt-secret')) }
  catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    throw new Error('the existing production JWT secret is required for a local publish')
  }
  if (!secret.trim()) throw new Error('the existing production JWT secret is required for a local publish')
}

if (import.meta.main) {
  const [directory, ...flags] = Deno.args
  if (!directory || flags.some(flag => !['--prepare-only', '--temporary'].includes(flag)) ||
      new Set(flags).size !== flags.length || flags.includes('--prepare-only') && flags.length !== 1) {
    throw new Error('publish-cloudflare.ts <fresh-release-directory> [--prepare-only | --temporary]')
  }
  const out = path.resolve(directory)
  if (!flags.includes('--prepare-only')) await requireExistingSecret(out)
  await prepareRelease(out)
  if (!flags.includes('--prepare-only')) {
    const pronto = await runtimeRoot('pronto')
    const config = path.join(pronto, 'bundle/deno.json')
    const publisher = path.join(pronto, 'bundle/publish-edge.ts')
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', config, publisher, out, '--mecha', await runtimeRoot('mecha'), ...(flags.includes('--temporary') ? ['--temporary'] : [])],
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    }).spawn().status
    if (!result.success) throw new Error(`Cloudflare publisher exited ${result.code}`)
  }
}
