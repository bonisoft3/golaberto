import * as path from 'node:path'

export function demandRendering(source: string): string {
  const fresh = 'if (age <= RENDER_FRESH_MS) {'
  const cacheHit = "headers.set('x-edge-cache', 'hit')"
  const render = "      const fresh = await (request.headers.has('if-none-match') ? renderFresh() : renderShared())"
  for (const fragment of [fresh, cacheHit, render]) {
    if (source.split(fragment).length !== 2) throw new Error('Cloudflare entry changed; review the Golaberto prefetch policy')
  }
  return source.replace(fresh, "if (age <= RENDER_FRESH_MS || request.headers.get('purpose') === 'prefetch') {")
    .replace(cacheHit, "if (age > RENDER_FRESH_MS) headers.delete('etag')\n            headers.set('x-edge-cache', age <= RENDER_FRESH_MS ? 'hit' : 'stale')")
    .replace(render, `      // Speculation must not queue database snapshots ahead of real navigation.
      if (request.headers.get('purpose') === 'prefetch') return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
${render}`)
}

if (import.meta.main) {
  const out = Deno.args[0]
  if (!out || Deno.args.length !== 1) throw new Error('cloudflare-policy.ts <release-directory>')
  const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
  if (config.name !== 'golaberto' || !config.routes?.some((route: { pattern: string }) => route.pattern === 'golaberto.bonisoft3.com')) {
    throw new Error('the prefetch policy is specific to the Golaberto Cloudflare deployment')
  }
  const entry = path.join(out, config.main)
  await Deno.writeTextFile(entry, demandRendering(await Deno.readTextFile(entry)))
}
