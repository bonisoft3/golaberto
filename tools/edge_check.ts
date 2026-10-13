// Checks a GolAberto edge release holding the archive, as a guest through its
// public routes: the reads the screens make answer with rows, derived tables
// included; accent search finds a team; and each read's round trip, first and
// again. With --idle <s> it first waits for the platform to evict the object
// and reports the cold answer. One JSON line per check; exits non-zero on any
// empty or failed read. docs/cloudflare-release.md runs it after a publish.
// Usage: deno run -A tools/edge_check.ts <origin> [--idle <seconds>]
const args = [...Deno.args]
const at = args.indexOf('--idle')
const idle = at < 0 ? 0 : Number(args.splice(at, 2)[1])
const [origin] = args
if (!origin) throw new Error('usage: edge_check.ts <origin> [--idle <seconds>]')

const emit = (line: Record<string, unknown>) => console.log(JSON.stringify(line))
const ms = (t: number) => Math.round(performance.now() - t)

if (idle) await new Promise((r) => setTimeout(r, idle * 1000))
let t = performance.now()
const guest = await fetch(`${origin}/auth/guest`, { method: 'POST' })
if (!guest.ok) throw new Error(`/auth/guest: ${guest.status} ${await guest.text()}`)
const { token } = await guest.json()
emit({ check: idle ? `guest after ${idle}s idle` : 'guest', clientMs: ms(t) })

const get = async (path: string) => {
  const t = performance.now()
  const res = await fetch(`${origin}/crud/${path}`, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`)
  return { rows: JSON.parse(text) as Record<string, string>[], clientMs: ms(t), cache: res.headers.get('x-edge-cache') }
}
const one = async (path: string) => {
  const { rows } = await get(path)
  if (!rows.length) throw new Error(`${path}: no row`)
  return rows[0]
}

const champ = await one('championship?select=id&slug=eq.brazil-campeonato-brasileiro-2026')
const phase = await one(`phase?select=id&championship_id=eq.${champ.id}&order=position.asc&limit=1`)
const group = await one(`stage_group?select=id&phase_id=eq.${phase.id}&order=position.asc&limit=1`)
const team = await one('team?select=id&slug=eq.flamengo-rj')
const player = await one(`player_stat?select=player_id&team_id=eq.${team.id}&minutes=not.is.null&order=minutes.desc&limit=1`)

const reads: [string, string][] = [
  ['home: recent cards', 'home_feed?played=is.true&home_recent_rank=gt.0&limit=20&order=home_recent_rank.asc'],
  ['home: upcoming cards', 'home_feed?played=is.false&home_upcoming_rank=gt.0&limit=20&order=home_upcoming_rank.asc'],
  ['home: championships', 'home_championship?limit=20'],
  ['championship: standing', `standing?group_id=eq.${group.id}&order=position.asc`],
  ['championship: games', `game_card?championship_id=eq.${champ.id}&limit=40&order=day.desc`],
  ['championship: position chances', `position_chance?group_id=eq.${group.id}&limit=100`],
  ['championship: team chances', `team_chance?group_id=eq.${group.id}&limit=40`],
  ['championship: zone chances', `zone_chance?group_id=eq.${group.id}&limit=40`],
  ['team: games', `team_game?team_id=eq.${team.id}&limit=40&order=day.desc`],
  ['team: championships', `team_championship?team_id=eq.${team.id}&limit=40`],
  ['team: rating chart', `team_rating_chart?team_id=eq.${team.id}&limit=40`],
  ['team: odds chart', `team_odds_chart?team_id=eq.${team.id}&limit=40`],
  ['team: odds history', `team_odds_history?team_id=eq.${team.id}&limit=40`],
  ['team: roster', `team_roster?team_id=eq.${team.id}&limit=40`],
  ['team: campaign points', `team_campaign_point?team_id=eq.${team.id}&limit=40`],
  ['directory: teams "sao"', 'team_directory?search_key=like.*sao*&limit=40'],
  ['player: stats', `player_stat?player_id=eq.${player.player_id}&limit=40`],
  ['player: games', `player_game?player_id=eq.${player.player_id}&limit=40`],
  ['player: appearances', `player_appearance?player_id=eq.${player.player_id}&limit=40`],
  ['matches: cards', 'matches_game_card?limit=40'],
  ['accent search: "GREMIO-rs"', 'team?select=name&search_name=eq.GREMIO-rs'],
]
let failed = 0
for (const [check, path] of reads) {
  try {
    const first = await get(path)
    const again = await get(path)
    emit({ check, rows: first.rows.length, clientMs: first.clientMs, againMs: again.clientMs, againCache: again.cache })
    if (!first.rows.length) failed++
  } catch (e) {
    emit({ check, error: (e as Error).message })
    failed++
  }
}
if (failed) throw new Error(`${failed} of ${reads.length} reads failed or were empty`)
