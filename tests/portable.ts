/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium, type Page } from 'npm:playwright@1.61.1';
import { assert, assertEquals } from 'jsr:@std/assert@1.0.11';

if (Deno.args.length !== 2 || Deno.args[0] !== '--url') throw new Error('usage: portable.ts --url https://preview.workers.dev');
const base = Deno.args[1].replace(/\/$/, '');
const evidence = Deno.env.get('GOLABERTO_PORTABLE_EVIDENCE_DIR') ?? new URL('../docs/evidence/cloudflare/', import.meta.url).pathname;
const timeout = Number(Deno.env.get('GOLABERTO_PORTABLE_TIMEOUT_MS') ?? '240000');
assert(Number.isSafeInteger(timeout) && timeout > 0, 'invalid portable timeout');
type Row = Record<string, string | number | boolean | null>;
const expectedCounts: Record<string, number> = {
  game: 1522, team: 68, team_rating: 64, player_rating: 725,
  team_chance: 82, zone_chance: 300, position_chance: 1604, game_importance: 513,
  standing: 82, game_card: 1522,
};
async function waitFor<T>(description: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(value!)}`);
}
async function request(page: Page, path: string, patch?: Row) {
  return await page.evaluate(async ({ path, patch }) => {
    const stored = localStorage.getItem('pronto-token');
    if (!stored) throw new Error('preview has no guest session');
    const session = JSON.parse(stored);
    if (!session.user.guest) throw new Error('preview test requires a guest session');
    const response = await fetch(`/crud/${path}`, {
      method: patch ? 'PATCH' : 'GET',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Prefer: patch ? 'return=representation' : 'count=exact' },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
    });
    return { status: response.status, range: response.headers.get('content-range'), body: await response.text() };
  }, { path, patch });
}
async function read(page: Page, path: string): Promise<{ rows: Row[]; total: number }> {
  const response = await request(page, path);
  assert(response.status === 200 || response.status === 206, `GET ${path}: ${response.status} ${response.body}`);
  const rows: unknown = JSON.parse(response.body);
  assert(Array.isArray(rows), `GET ${path} returned no rows`);
  const total = Number(response.range?.split('/')[1]);
  assert(Number.isSafeInteger(total), `GET ${path} returned no exact count: ${response.range}`);
  return { rows: rows as Row[], total };
}
async function visit(page: Page, path: string) {
  const response = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout });
  assertEquals(response?.status(), 200, `navigation to ${path} failed`);
  await waitFor('guest session', () => page.evaluate(() => localStorage.getItem('pronto-token') !== null), Boolean);
}
async function photograph(page: Page, filename: string, fullPage = true) {
  await waitFor('finished UI transitions', () => page.evaluate(() =>
    document.getAnimations().filter(animation => animation.playState === 'running').length + document.querySelectorAll('[data-exit]').length,
  ), active => active === 0);
  await page.screenshot({ path: `${evidence}/${filename}.png`, fullPage });
}

await Deno.mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
const page = await context.newPage();
const active = page.locator('.shell-screen:not([hidden]):not([data-served])');
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const started = Date.now();
try {
  await visit(page, '/');
  const counts: Record<string, number> = {};
  for (const [table, expected] of Object.entries(expectedCounts)) {
    const actual = await waitFor(`${table} publication`, () => read(page, `${table}?select=id&limit=1`), result => result.total === expected);
    counts[table] = actual.total;
    console.log(`${table}: ${actual.total}`);
  }
  const chances = (await read(page, 'team_chance?order=group_id.asc,rank.asc&limit=1000')).rows;
  const groups = new Map<string, Row[]>();
  for (const row of chances) {
    const id = String(row.group_id);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const [groupId, groupChances] = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  const group = (await read(page, `stage_group?id=eq.${encodeURIComponent(groupId)}&select=id,slug,name`)).rows[0];
  assert(group && typeof group.slug === 'string', 'computed group has no readable address');
  const zones = await read(page, `zone_chance?group_id=eq.${encodeURIComponent(groupId)}&select=id,percent&limit=1000`);
  const positions = await read(page, `position_chance?group_id=eq.${encodeURIComponent(groupId)}&select=id,percent&limit=1000`);
  assert(zones.rows.some(row => Number(row.percent) > 0), 'computed zone probabilities are all zero');
  assert(positions.rows.some(row => Number(row.percent) > 0 && Number(row.percent) < 100), 'position probabilities contain no uncertainty');
  await visit(page, `/chances/${encodeURIComponent(group.slug)}`);
  await waitFor('rendered odds rows', () => active.locator('.zone-odds .rows > .row').count(), count => count === groupChances.length);
  await waitFor('rendered zone probabilities', () => active.locator('.zone-odds .pct .exact').count(), count => count === zones.total);
  await waitFor('rendered position probabilities', () => active.locator('.heat .heat-cell').count(), count => count === positions.total);
  assert((await active.locator('.zone-odds .rows').innerText()).includes(String(groupChances[0].team_name)), 'odds table omits its leading team');
  const percentages = await active.locator('.zone-odds .pct .exact').allTextContents();
  assert(percentages.some(value => Number(value.replace(',', '.')) > 0), 'visible zone probabilities are all zero');
  await photograph(page, 'odds');

  const protectedRow = groupChances[0];
  const denied = await request(page, `team_chance?id=eq.${encodeURIComponent(String(protectedRow.id))}`, { points: Number(protectedRow.points) + 1 });
  assert(denied.status === 403 || (denied.status === 200 && denied.body === '[]'), `guest derived write was not denied: ${JSON.stringify(denied)}`);
  const afterDenied = (await read(page, `team_chance?id=eq.${encodeURIComponent(String(protectedRow.id))}`)).rows[0];
  assertEquals(afterDenied, protectedRow, 'guest changed a computed standings row');

  const stat = (await read(page, 'player_stat?goals=gt.0&order=goals.desc,id.asc&limit=1')).rows[0];
  assert(stat && Number(stat.minutes) > 0, 'preview has no player statistics');
  const player = (await read(page, `player?id=eq.${encodeURIComponent(String(stat.player_id))}&select=id,slug,name`)).rows[0];
  assert(player && typeof player.slug === 'string', 'player has no readable address');
  await visit(page, `/jogador/${encodeURIComponent(player.slug)}`);
  await waitFor('rendered player statistics', () => active.locator('tbody[data-live="player_stat"] > tr').count(), count => count > 0);
  const visibleStats = await active.locator('tbody[data-live="player_stat"]').innerText();
  assert(visibleStats.includes(String(stat.team_name)), 'player statistics omit the selected team');
  const visibleGoals = await active.locator('tbody[data-live="player_stat"] [data-text="{goals}"]').allTextContents();
  assert(visibleGoals.some(value => Number(value.replaceAll('.', '').replace(',', '.')) === Number(stat.goals)), 'player goals differ from the published statistic');
  await photograph(page, 'player-statistics', false);
  assertEquals(errors, [], 'browser runtime errors');
  const report = { origin: base, counts, group: { id: groupId, slug: group.slug, teams: groupChances.length, zones: zones.total, positions: positions.total },
    player: { slug: player.slug, name: player.name, goals: stat.goals, minutes: stat.minutes }, guestDerivedWrite: denied,
    errors, elapsedMs: Date.now() - started };
  await Deno.writeTextFile(`${evidence}/portable-result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
