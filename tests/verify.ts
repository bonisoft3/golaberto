/// <reference lib="dom" />
import { airlock } from '@bonisoft3/pronto/verify/airlock.ts'

type Row = Record<string, any>
type Fixture = { table: string; input: Row; defaults: Row; submitted?: boolean; saved?: Row }
type State = { base: string; token: string; actor: string; fixtures: Fixture[]; transactions: string[]; recovery: string; page: any; timeout: number; origin?: number; teamId: string; group: string; observed?: boolean; changed?: boolean; inverse?: boolean; deleteAttempted?: boolean; deleted?: boolean }

async function rows(state: State, query: string): Promise<Row[]> {
  const response = await fetch(`${state.base}/crud/${query}`, { signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${state.token}` } })
  if (!response.ok) throw new Error(`Verification read ${query}: HTTP ${response.status}`)
  return await response.json()
}
async function save(state: State) {
  await Deno.writeTextFile(state.recovery, JSON.stringify({ base: state.base, actor: state.actor, fixtures: state.fixtures, transactions: state.transactions }, null, 2))
}
function transactionId(value: unknown): string {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error('Invalid verification transaction receipt')
  return String(BigInt.asUintN(32, BigInt(String(value))))
}
async function recordTransaction(state: State, response: Response) {
  state.transactions.push(transactionId(response.headers.get('x-txid')))
  await save(state)
}
function sameValue(table: string, key: string, a: unknown, b: unknown): boolean {
  const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/.test(value) ? value.slice(0, 10) : value
  return (table === 'championship' && (key === 'begins' || key === 'ends')) || (table === 'game' && key === 'day') ? date(a) === date(b) : a === b
}
function fixturePlan(game: Row, category: string, ids: string[]): Fixture[] {
  const [championship, phase, group, home, away, match] = ids
  return [
    { table: 'championship', input: { id: championship, name: 'Verification', category_id: category, region_name: 'Brazil', begins: game.day, ends: game.day }, defaults: { region: 'national', point_win: 3, point_draw: 1, point_loss: 0, show_country: false, featured: false } },
    { table: 'phase', input: { id: phase, championship_id: championship, name: 'Verification' }, defaults: { position: 0, sort: 'pt,w,gd,gf,gp,g_away,name', bonus_points: 0, bonus_points_threshold: 0 } },
    { table: 'stage_group', input: { id: group, phase_id: phase, name: 'Verification' }, defaults: { position: 0 } },
    ...[game.home_id, game.away_id].map((team_id, index) => ({ table: 'team_group', input: { id: index ? away : home, group_id: group, team_id }, defaults: { add_sub: 0, bias: 0, comment: null } })),
    { table: 'game', input: { id: match, phase_id: phase, day: game.day, home_id: game.home_id, away_id: game.away_id, played: true, home_score: 1, away_score: 0 }, defaults: { round: null, kickoff: null, home_field: 'left', home_aet: null, away_aet: null, home_pen: null, away_pen: null, stadium_id: null, referee_id: null, attendance: null } },
  ]
}
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (row: Row) => Object.keys(row).sort().join(',')
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
async function recover(state: State, game: Row, gameId: string, path: string) {
  const held = JSON.parse(await Deno.readTextFile(path))
  const refuse = (reason: string): never => { throw new Error(`Verification recovery refused: ${reason}; retained ${path}`) }
  if (!object(held) || keys(held) !== 'actor,base,fixtures,transactions' || held.base !== state.base || held.actor !== state.actor) refuse('base or actor differs')
  if (!Array.isArray(held.fixtures) || held.fixtures.length !== 6 || !Array.isArray(held.transactions) || ![5, 6].includes(held.transactions.length)) refuse('not a complete owned fixture set')
  const fixtures = held.fixtures as Fixture[], transactions = held.transactions as unknown[]
  const inserted = transactions.length
  if (!transactions.every(txid => typeof txid === 'string' && /^\d+$/.test(txid) && transactionId(txid) === txid) || new Set(transactions).size !== inserted) refuse('invalid insert receipts')
  if (!fixtures.every(fixture => object(fixture) && object(fixture.input) && object(fixture.defaults) && uuid(fixture.input.id))) refuse('invalid fixture layout')
  const ids = fixtures.map(fixture => fixture.input.id)
  if (new Set(ids).size !== 6 || ids.includes(gameId) || !uuid(fixtures[0].input.category_id)) refuse('invalid fixture identities')
  const expected = fixturePlan(game, fixtures[0].input.category_id, ids)
  for (const [index, fixture] of fixtures.entries()) {
    const plan = expected[index]
    if (keys(fixture) !== (index < inserted ? 'defaults,input,saved,submitted,table' : 'defaults,input,table') || fixture.table !== plan.table ||
      keys(fixture.input) !== keys(plan.input) || keys(fixture.defaults) !== keys(plan.defaults) ||
      Object.entries(plan.input).some(([key, value]) => !sameValue(plan.table, key, fixture.input[key], value)) ||
      Object.entries(plan.defaults).some(([key, value]) => !sameValue(plan.table, key, fixture.defaults[key], value))) refuse('fixture layout or relationships differ')
    if (index < inserted) {
      const saved = fixture.saved
      if (fixture.submitted !== true || !object(saved) || saved.txid == null || transactionId(saved.txid) !== transactions[index] ||
        Object.entries({ ...plan.input, ...plan.defaults, created_by: state.actor, updated_by: state.actor }).some(([key, value]) => !sameValue(plan.table, key, saved[key], value))) refuse('fixture has no matching saved insert')
    }
  }
  const category = await rows(state, `category?select=id&id=eq.${fixtures[0].input.category_id}`)
  if (category.length !== 1 || category[0].id !== fixtures[0].input.category_id) refuse('fixture category disappeared')
  for (const fixture of fixtures.slice(0, inserted)) {
    const found = await rows(state, `${fixture.table}?select=*&id=eq.${fixture.input.id}`)
    const row = found[0], saved = fixture.saved!
    if (found.length !== 1 || !object(row) || keys(row) !== keys(saved) || row.txid == null || !transactions.includes(transactionId(row.txid)) ||
      (fixture.table === 'game' && transactionId(row.txid) !== transactionId(saved.txid)) ||
      Object.entries(saved).some(([key, value]) => key !== 'txid' && !sameValue(fixture.table, key, row[key], value))) refuse(`fixture ${fixture.table} was edited or disappeared`)
  }
  const children: [string, string[]][] = [
    [`phase?select=id&championship_id=eq.${ids[0]}&limit=2`, [ids[1]]],
    [`stage_group?select=id&phase_id=eq.${ids[1]}&limit=2`, [ids[2]]],
    [`team_group?select=id&group_id=eq.${ids[2]}&limit=3`, [ids[3], ids[4]]],
    [`zone?select=id&group_id=eq.${ids[2]}&limit=1`, []],
    [`team_player?select=id&championship_id=eq.${ids[0]}&limit=1`, []],
    [`game?select=id&phase_id=eq.${ids[1]}&limit=2`, inserted === 6 ? [ids[5]] : []],
    [`game?select=id&id=eq.${ids[5]}`, inserted === 6 ? [ids[5]] : []],
    [`game_change?select=id&game_id=eq.${ids[5]}&limit=1`, []],
    ...['goal', 'player_game', 'comment'].map(table => [`${table}?select=id&game_id=eq.${ids[5]}&limit=1`, []] as [string, string[]]),
  ]
  for (const [query, expectedIds] of children) {
    const found = await rows(state, query)
    if (found.length !== expectedIds.length || found.some(row => !expectedIds.includes(row.id)) || new Set(found.map(row => row.id)).size !== found.length) refuse('fixture children changed or game was already submitted')
  }
  state.fixtures = fixtures
  state.transactions = transactions as string[]
  state.group = ids[2]
  state.recovery = path
  state.inverse = inserted === 6
}
async function create(state: State, fixture: Fixture) {
  fixture.submitted = true
  await save(state)
  const response = await fetch(`${state.base}/crud/${fixture.table}`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(fixture.input) })
  if (!response.ok) throw new Error(`Fixture ${fixture.table}: HTTP ${response.status}: ${await response.text()}`)
  await recordTransaction(state, response)
  const result = await response.json()
  if (result.length !== 1 || result[0].id !== fixture.input.id) throw new Error(`Invalid ${fixture.table} insert response`)
  fixture.saved = result[0]
  await save(state)
}
async function remove(state: State, fixture: Fixture) {
  const found = await rows(state, `${fixture.table}?select=*&id=eq.${fixture.input.id}`)
  if (!found.length) {
    if (fixture.submitted && !fixture.saved) throw new Error(`Verification ${fixture.table} insert outcome is unknown; recover using ${state.recovery}`)
    return false
  }
  const row = found[0]
  if (!fixture.saved && (row.txid == null || !state.transactions.includes(transactionId(row.txid)))) throw new Error(`Verification ${fixture.table} insert has no matching transaction receipt; recover using ${state.recovery}`)
  const expected = fixture.saved ?? { ...fixture.input, ...fixture.defaults, created_by: state.actor, updated_by: state.actor }
  if (found.length !== 1 || Object.entries(expected).some(([key, value]) => !sameValue(fixture.table, key, row[key], value) && !(key === 'txid' && state.transactions.includes(transactionId(row.txid)))) || row.txid == null) throw new Error(`Verification ${fixture.table} was edited; recover using ${state.recovery}`)
  if (fixture.table === 'game') for (const table of ['game_change', 'goal', 'player_game', 'comment']) {
    if ((await rows(state, `${table}?select=id&game_id=eq.${fixture.input.id}&limit=1`)).length) throw new Error(`Verification game was edited; recover using ${state.recovery}`)
  }
  const filter = new URLSearchParams({ id: `eq.${fixture.input.id}`, txid: `eq.${row.txid}` })
  const response = await fetch(`${state.base}/crud/${fixture.table}?${filter}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${state.token}`, prefer: 'return=representation' } })
  if (!response.ok) throw new Error(`Fixture cleanup ${fixture.table}: HTTP ${response.status}: ${await response.text()}`)
  await recordTransaction(state, response)
  const removed = await response.json()
  if (removed.length !== 1 || removed[0].id !== fixture.input.id || (await rows(state, `${fixture.table}?select=id&id=eq.${fixture.input.id}`)).length) throw new Error(`Verification ${fixture.table} changed during cleanup; recover using ${state.recovery}`)
  return true
}
export function standingVisible({ group, teamId, goals, origin }: { group: string; teamId: string; goals: number; origin: number }) {
  if (performance.timeOrigin !== origin) throw new Error('Statistics required a document reload')
  const row = [...document.querySelectorAll('.standings tbody tr')].find(el => el.getAttribute('data-id') === `${group}:${teamId}`)
  return row?.querySelector('[data-text="{goals_for}"]')?.textContent?.trim() === String(goals)
}
async function settled(state: State, goals: number) {
  const deadline = Date.now() + state.timeout
  await state.page.waitForFunction(standingVisible, { group: state.group, teamId: state.teamId, goals, origin: state.origin }, { timeout: state.timeout })
  for (;;) {
    const published = await rows(state, `standing?select=id,goals_for&group_id=eq.${state.group}&team_id=eq.${state.teamId}`)
    if (published.length === 1 && published[0].goals_for === goals) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Browser and published standing disagree')
    await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)))
  }
}

const gameId = Deno.env.get('GOLABERTO_VERIFY_GAME_ID')
if (gameId && !/^[0-9a-f-]{36}$/.test(gameId)) throw new Error('GOLABERTO_VERIFY_GAME_ID must be a UUID')
if (!gameId) console.log('SKIPPED test-standings-live: set GOLABERTO_VERIFY_GAME_ID and an editor session to verify a mutation')

export const liveStatistics = (gameId: string) => airlock<State>({
  screen: 'campeonato', accepts: 'test-standings-live', role: 'editor',
  async execute(page, ctx) {
    const session = JSON.parse(String(ctx?.token))
    if (!session?.token || !session.user?.id || session.user.guest) throw new Error('Live statistics verification requires an editor --session')
    const base = String(ctx?.baseUrl), token = session.token, actor = session.user.id
    const state: State = { base, token, actor, page, fixtures: [], transactions: [], recovery: '', teamId: '', group: crypto.randomUUID(), timeout: Number(Deno.env.get('GOLABERTO_VERIFY_SETTLE_MS') ?? 300_000) }
    if (!Number.isSafeInteger(state.timeout) || state.timeout <= 0) throw new Error('Invalid statistics settle timeout')
    const grants = await rows(state, `editor?select=app_user_id&app_user_id=eq.${actor}`)
    if (grants.length !== 1) throw new Error('Verification session is not an editor')
    const games = await rows(state, `game?select=day,home_id,away_id&id=eq.${gameId}`)
    if (games.length !== 1 || !games[0].day || games[0].home_id === games[0].away_id) throw new Error('Choose a match with two teams and an available category')
    const game = games[0]
    state.teamId = game.home_id
    const recovery = Deno.env.get('GOLABERTO_VERIFY_RECOVERY')
    if (recovery !== undefined) {
      if (!recovery.trim()) throw new Error('GOLABERTO_VERIFY_RECOVERY must name a recovery file')
      await recover(state, game, gameId, recovery)
    } else {
      const categories = await rows(state, 'category?select=id&limit=1')
      if (categories.length !== 1) throw new Error('Choose a match with two teams and an available category')
      state.fixtures = fixturePlan(game, categories[0].id, [crypto.randomUUID(), crypto.randomUUID(), state.group, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()])
      state.recovery = await Deno.makeTempFile({ prefix: 'golaberto-verify-', suffix: '.json' })
      await save(state)
    }
    ctx?.recordState?.(state)
    console.log(`Live statistics recovery record: ${state.recovery}`)
    if (recovery === undefined) for (const fixture of state.fixtures.slice(0, -1)) await create(state, fixture)
    if (!state.fixtures[0].saved?.slug) throw new Error('Fixture championship unavailable')
    const response = await page.goto(`${base}/campeonato/${encodeURIComponent(state.fixtures[0].saved.slug)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    if (response?.status() !== 200) throw new Error(`Championship navigation: HTTP ${response?.status()}`)
    state.origin = await page.evaluate(() => performance.timeOrigin)
    await settled(state, state.inverse ? 1 : 0)
    state.observed = true
    await page.screenshot({ path: state.recovery.replace('.json', '-before.png'), fullPage: true })
    if (state.inverse) {
      state.deleteAttempted = true
      if (!await remove(state, state.fixtures.at(-1)!)) throw new Error(`Verification game disappeared before deletion; retained ${state.recovery}`)
      state.deleted = true
    } else await create(state, state.fixtures.at(-1)!)
    await settled(state, state.inverse ? 0 : 1)
    await page.screenshot({ path: state.recovery.replace('.json', '-changed.png'), fullPage: true })
    state.changed = true
    console.log(`Live statistics changed without reload: ${state.fixtures.at(-1)!.input.id}, goals ${state.inverse ? '1 → 0' : '0 → 1'}`)
    return state
  },
  async rollback(state) {
    if (!state) return
    if (state.inverse && !state.deleted) {
      if (state.deleteAttempted) throw new Error(`Verification game deletion was not confirmed; retained ${state.recovery}`)
      return
    }
    let verificationError: unknown
    if (state.inverse) {
      delete state.fixtures.at(-1)!.saved
      try {
        await create(state, state.fixtures.at(-1)!)
        await settled(state, 1)
        await state.page.screenshot({ path: state.recovery.replace('.json', '-restored.png'), fullPage: true })
      } catch (error) { verificationError = error }
    }
    await remove(state, state.fixtures.at(-1)!)
    if (state.observed && !state.inverse) {
      try {
        await settled(state, 0)
        await state.page.screenshot({ path: state.recovery.replace('.json', '-restored.png'), fullPage: true })
      } catch (error) { verificationError = error }
    }
    for (const fixture of state.fixtures.slice(0, -1).reverse()) await remove(state, fixture)
    await Deno.remove(state.recovery)
    if (verificationError) throw verificationError
    console.log(state.inverse ? state.changed ? 'Live statistics goals 1 → 0 → 1 verified without reload; disposable match and competition removed' : 'Disposable competition removed; inverse statistics transition was not verified' : state.observed ? 'Disposable competition removed and published standings restored without reload' : 'Disposable competition removed; statistics transition was not verified')
  },
})
export const journeys = gameId ? [liveStatistics(gameId)] : []
