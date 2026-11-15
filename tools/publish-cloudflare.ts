import * as path from 'node:path'
import { compressedStorage } from './cloudflare-policy.ts'

export async function runtimeRoot(pkg: 'mecha' | 'omnishell' | 'pronto'): Promise<string> {
  const out = await new Deno.Command('mise', { args: ['where', `github:bonisoft3/${pkg}`] }).output()
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || `mise could not locate ${pkg}`)
  return new TextDecoder().decode(out.stdout).trim()
}

export function publishOptions(args: string[]): { directory: string; prepareOnly: boolean; keepJwtSecret: boolean; reset: boolean } {
  const [directory, ...flags] = args
  if (!directory || directory.startsWith('--') || new Set(flags).size !== flags.length || flags.some((flag) => !['--prepare-only', '--keep-jwt-secret', '--reset'].includes(flag))) {
    throw new Error('publish-cloudflare.ts <fresh-release-directory> [--prepare-only] [--keep-jwt-secret | --reset]')
  }
  if (flags.includes('--reset') && flags.includes('--keep-jwt-secret')) throw new Error('--reset cannot be combined with --keep-jwt-secret')
  return { directory, prepareOnly: flags.includes('--prepare-only'), keepJwtSecret: flags.includes('--keep-jwt-secret'), reset: flags.includes('--reset') }
}

export async function prepareRelease(out: string): Promise<void> {
  const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
  const databasePath = path.join(out, 'src/database.ts')
  const database = compressedStorage(await Deno.readTextFile(databasePath))
  await Deno.writeTextFile(databasePath, database)
  config.limits = { ...config.limits, cpu_ms: 300_000 }
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n')
}

if (import.meta.main) {
  const { directory, prepareOnly, keepJwtSecret, reset } = publishOptions(Deno.args)
  const out = path.resolve(directory)
  await prepareRelease(out)
  if (!prepareOnly) {
    const pronto = await runtimeRoot('pronto')
    const config = path.join(pronto, 'bundle/deno.json')
    const publisher = path.join(pronto, 'bundle/publish-edge.ts')
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', config, publisher, out, '--mecha', await runtimeRoot('mecha'), ...(keepJwtSecret ? ['--keep-jwt-secret'] : []), ...(reset ? ['--reset'] : [])],
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    }).spawn().status
    if (!result.success) throw new Error(`Cloudflare publisher exited ${result.code}`)
  }
}
