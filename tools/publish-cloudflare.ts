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

export async function prepareRelease(out: string): Promise<void> {
  const secret = await Deno.readTextFile(path.join(path.dirname(out), '.jwt-secret'))
  if (!secret.trim()) throw new Error('the existing production JWT secret is required')
  const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
  const entryPath = path.join(out, config.main)
  demandRendering(await Deno.readTextFile(entryPath))
  await combineRenderer(out, await runtimeRoot('omnishell'), await runtimeRoot('mecha'))
  const combined = await Deno.readTextFile(entryPath)
  await Deno.writeTextFile(entryPath, demandRendering(combined))
}

if (import.meta.main) {
  const [directory, mode] = Deno.args
  if (!directory || Deno.args.length > 2 || mode && mode !== '--prepare-only') {
    throw new Error('publish-cloudflare.ts <fresh-release-directory> [--prepare-only]')
  }
  const out = path.resolve(directory)
  await prepareRelease(out)
  if (!mode) {
    const pronto = await runtimeRoot('pronto')
    const config = path.join(pronto, 'bundle/deno.json')
    const publisher = path.join(pronto, 'bundle/publish-edge.ts')
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', config, publisher, out, '--mecha', await runtimeRoot('mecha')],
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    }).spawn().status
    if (!result.success) throw new Error(`Cloudflare publisher exited ${result.code}`)
  }
}
