/// <reference lib="dom" />
// The acceptance driver: the ir's screen invariants walked against the running
// archive in a real browser, with the cluster up. Declared in program.cue as an
// integrate check. Each case names the test pair it realizes.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "omnishell/base-url.ts";
import { query } from "./db.ts";
import { address, fixturePath } from "./addresses.ts";

const { chromium } = await import("npm:playwright@1.61.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(Deno.args[0] ?? ".");
const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });

// deno-lint-ignore no-explicit-any
type Page = any;

// Every context a case opens is closed when the case ends.
const opened: { close(): Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test(name, async () => {
    try {
      await fn();
    } finally {
      await Promise.all(opened.splice(0).map((c) => c.close()));
    }
  });

// A reader who signed in with a passkey: an account row and the token the auth
// service would issue it, signed with the dev cluster's secret. The ceremony
// itself needs the origin the cluster pins, which a stack on a random port is
// not; mecha's auth suite covers it.
const signedIn = async (handle: string) => {
  const id = crypto.randomUUID();
  await query(`INSERT INTO app_user (id, handle) VALUES ('${id}', '${handle}')`);
  const jwt = Deno.env.get("PGRST_JWT_SECRET");
  if (jwt === undefined) throw new Error("PGRST_JWT_SECRET is unset: the check runs beside the stack, which sets it");
  const secret = new TextEncoder().encode(jwt);
  const token = await new SignJWT({ role: "app_user", handle, guest: false }).setProtectedHeader({ alg: "HS256" }).setSubject(id)
    .setExpirationTime("1h").sign(secret);
  return { token, user: { id, handle } };
};

const context = async (opts: { width?: number; dark?: boolean; session?: unknown } = {}) => {
  const c = await browser.newContext({
    viewport: { width: opts.width ?? 1366, height: 900 },
    colorScheme: opts.dark ? "dark" : "light",
    // A Brazilian reader: the unprefixed addresses negotiate to the language a browser asks for.
    locale: "pt-BR",
  });
  opened.push(c);
  if (opts.session !== undefined) {
    await c.addInitScript((s: unknown) => sessionStorage.setItem("pronto-token", JSON.stringify(s)), opts.session);
  }
  return c;
};

const visit = async (page: Page, path: string, ready = '.shell-screen:not([hidden]):not([data-served]) .screen[data-state="populated"]') => {
  const logged: string[] = [];
  type Request = { url(): string; method(): string; resourceType(): string };
  const pending = new Map<Request, number>();
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error" || m.type() === "warning") logged.push(`${m.type()}: ${m.text()}`);
  };
  const onError = (e: Error) => logged.push(`pageerror: ${e.message}`);
  const onRequest = (request: Request) => pending.set(request, Date.now());
  const onFinished = (request: Request) => pending.delete(request);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFinished);
  try {
    await page.goto(`${base}${await fixturePath(path)}`);
    await page.waitForSelector(ready, { timeout: 30_000 }).catch(async (error: Error) => {
      const diagnostics = {
        url: page.url(), viewport: page.viewportSize(), ready, console: logged,
        requests: [...pending].map(([request, started]) => ({
          url: request.url(), method: request.method(), type: request.resourceType(), pendingMs: Date.now() - started,
        })),
      };
      let state;
      try {
        state = await page.evaluate(() => {
          type Collection = { status: string; size: number; subscriberCount: number; isLoadingSubset: boolean; isReady(): boolean };
          const debug = globalThis as typeof globalThis & {
            __mechaClient?: { collections: Record<string, Collection> };
            __prontoViews?: Map<string, {
              view: Collection; refs: number; attempts: number; retrying?: unknown;
              attached: Set<unknown>; waiters: Set<unknown>;
              failure?: { table: string; refused: boolean; error: Error };
            }>;
          };
          const collectionState = (collection: Collection) => ({
            status: collection.status, size: collection.size, ready: collection.isReady(),
            loadingSubset: collection.isLoadingSubset, subscribers: collection.subscriberCount,
          });
          const attributes = (element: Element, names: string[]) => Object.fromEntries(names.map(name => [name, element.getAttribute(name)]));
          return {
            shells: [...document.querySelectorAll(".shell-screen")].map(shell => ({
              ...attributes(shell, ["hidden", "data-served"]),
              screens: [...shell.querySelectorAll(".screen")].map(screen => ({
                ...attributes(screen, ["data-screen", "data-state"]),
                regions: [...screen.querySelectorAll("[data-live]")].map(region => ({
                  ...attributes(region, ["data-live", "data-filter", "data-select", "data-state", "data-loading", "aria-busy", "hidden"]),
                  children: region.childElementCount,
                })),
              })),
            })),
            views: [...(debug.__prontoViews ?? [])].map(([key, entry]) => ({
              key, ...collectionState(entry.view), refs: entry.refs, attempts: entry.attempts,
              retrying: entry.retrying !== undefined, attached: entry.attached.size, waiters: entry.waiters.size,
              failure: entry.failure && { table: entry.failure.table, refused: entry.failure.refused, message: entry.failure.error.message },
            })),
            collections: Object.fromEntries(Object.entries(debug.__mechaClient?.collections ?? {}).map(([table, collection]) => [table, collectionState(collection)])),
          };
        });
      } catch (diagnosticError) {
        throw new AggregateError([error, diagnosticError], `${path} never got ready; browser diagnostics also failed: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
      throw new Error(`${path} never got ready: ${error.message}\n${JSON.stringify({ ...diagnostics, state }, null, 2)}`, { cause: error });
    });
    return page;
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onError);
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFinished);
  }
};

const open = async (path: string, opts: { width?: number; dark?: boolean; session?: unknown } = {}) =>
  visit(await (await context(opts)).newPage(), path);

const texts = (page: Page, selector: string): Promise<string[]> =>
  page.$$eval(selector, (els: Element[]) => els.map((e) => (e.textContent ?? "").trim()));

// What a reader sees: rendered text only, hidden marks left out, runs of space as one.
const said = (page: Page, selector: string): Promise<string[]> =>
  page.$$eval(selector, (els: Element[]) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()));

// The seeded championships' ids, as tools/seed.py mints them.
const BRASILEIRO_2026 = "02000000-0000-4000-8000-000000000001";
const BRASILEIRO_1971 = "02000000-0000-4000-8000-000000000004";
const LIBERTADORES_2026 = "02000000-0000-4000-8000-000000000006";

// A played 0–0, Botafogo-RJ at home to Vitória-BA, whose result the live
// case rewrites and restores.
const DRAW = "09000000-0000-4000-8000-000000000039";
// Athletico-PR 2–1 Bahia-BA in round 28, with goals and both line-ups crawled.
const WIN = "09000000-0000-4000-8000-000000000280";
// The 2026 World Cup: Suíça 0–0 Colômbia, 0–0 after extra time, 4–3 on
// penalties; and the final, Espanha 0–0 Argentina, 1–0 after extra time.
const SHOOTOUT = "0a000000-0000-4000-8000-000000000001";
const FINAL = "0a000000-0000-4000-8000-000000000002";
// Athletico-PR, and its forward K. Viveros: eighteen goals in the 2026 Série A.
const ATHLETICO = "07000000-0000-4000-8000-000000000003";
const VIVEROS = "0c000000-0000-4000-8000-000000000126";
// The 2006 Brasileiro: Palmeiras-SP 3–1 São Paulo-SP at Pacaembu, refereed by
// Cléber Wellington Abade.
const PACAEMBU = "06000000-0000-4000-8000-000000000050";
const ABADE = "0b000000-0000-4000-8000-000000000003";
const DERBY_2006 = "0a000000-0000-4000-8000-000000001015";

const pointsOf = (page: Page, team: string): Promise<string> =>
  page.$$eval(".standings tbody tr", (rows: Element[], team: string) => {
    const row = rows.find((r) => r.querySelector(".name")?.textContent?.trim() === team);
    return row?.querySelector(".pts")?.textContent?.trim() ?? "";
  }, team);

// A stream answers a change after the recount it runs at start: on a cluster
// just brought up, every live case waits behind that first pass.
const STREAM_MS = 180_000;

const awaitPoints = (page: Page, team: string, want: number) =>
  page.waitForFunction(
    ([team, want]: [string, string]) =>
      [...document.querySelectorAll(".standings tbody tr")].some((r) =>
        r.querySelector(".name")?.textContent?.trim() === team && r.querySelector(".pts")?.textContent?.trim() === want),
    [team, String(want)],
    { timeout: STREAM_MS },
  );

// A page addressed to an id that names nothing, saying so in words.
const gone = async (route: string, words: string) => {
  const page = await (await context()).newPage();
  await page.goto(`${base}${route}/missing-address`);
  await page.waitForFunction((words: string) =>
    (document.querySelector(".shell-screen:not([hidden]):not([data-served]) .screen")?.textContent ?? "").includes(words), words);
};

const championship = async (id: string) => {
  const page = await open(`/campeonato/${id}`);
  await page.waitForSelector(".championship .phases");
  return page;
};

// Keep the probability round trip ahead of other mutating fixtures: their
// cleanup commits before downstream calculations necessarily finish.
const SERIE_A_2026 = "04000000-0000-4000-8000-000000000001";
// A chance as the page prints it, in the reader's own numerals.
const percent = (text: string) => Number(text.replace(/\./g, "").replace(",", "."));
// The first zone of the first line: the leader's title chance.
const titleOf = (page: Page) => page.$eval(".zone-odds .rows .row:first-child .pct", (e: Element) => e.textContent ?? "");

test("test-chances: the 2026 Série A's chances lead with Flamengo, near golaberto's own figure, and each team's positions sum to whole seasons", async () => {
  const page = await open(`/chances/${SERIE_A_2026}`);
  await page.waitForSelector(".zone-odds .rows .row .pct", { timeout: STREAM_MS });
  assertEquals((await said(page, ".zone-odds .rows .row:first-child .name"))[0], "Flamengo-RJ");
  const title = percent(await titleOf(page));
  // golaberto.com.br published 73.4% for this table; the ratings are refit
  // on the same 7-year archive, but from a zero prior and with their own
  // draws, so near is the claim and not equal.
  assert(title >= 60 && title <= 90, `Flamengo's title chance ${title} is far from golaberto's 73.4`);
  const positions: string[][] = await page.$$eval(".heat .rows .row", (rows: Element[]) =>
    rows.map(row => [...row.querySelectorAll(".heat-cell [data-text-format]")].map(e => e.textContent ?? "")));
  assertEquals(positions.length, 20);
  for (const cells of positions) {
    assertEquals(cells.length, 20);
    const sum = cells.map(percent).reduce((a, b) => a + b, 0);
    assert(sum >= 99 && sum <= 101, `a team's positions sum to ${sum}`);
  }
  for (const [table, selector, order] of [
    ["zone_chance", ".zone-odds", "c.first, c.last"],
    ["position_chance", ".heat", "c.position"],
  ]) {
    for (const deadline = Date.now() + STREAM_MS;;) {
      const expected = JSON.parse(await query(`SELECT json_agg(json_build_array(t.team_name, c.percent) ORDER BY t.rank, ${order})
        FROM ${table} c JOIN team_chance t USING (group_id, team_id) WHERE c.group_id = '${SERIE_A_2026}'`));
      const shown: string[][] = await page.$$eval(`${selector} .rows .row`, (rows: Element[]) =>
        rows.flatMap(row => [...row.querySelectorAll(".cells [data-text-format]")].map(cell => [
          row.querySelector(".name")?.textContent?.trim() ?? "", cell.textContent ?? "",
        ])));
      const actual = shown.map(([name, value]) => [name, percent(value)]);
      if (JSON.stringify(actual) === JSON.stringify(expected)) break;
      if (Date.now() >= deadline) assertEquals(actual, expected, `${table}: every displayed probability matches its source`);
      await page.waitForTimeout(100);
    }
  }
});

test("test-chances-reach: in the 2026 Série A every chance that shows 0 says whether it can still happen, marked * when it can and unmarked when the points rule it out", async () => {
  const page = await open(`/chances/${SERIE_A_2026}`);
  await page.waitForFunction(() => document.querySelectorAll(".heat .rows .heat-cell").length === 400, null, { timeout: STREAM_MS });
  // Each position cell: what it shows, its reach, the reach said, and the mark drawn.
  const cells: string[][] = await page.$$eval(".heat .rows .heat-cell", (els: Element[]) =>
    els.map((e) => {
      const mark = e.querySelector(".reach")!;
      return [
        e.querySelector("[data-text-format]")?.textContent ?? "",
        mark.getAttribute("data-reach") ?? "",
        mark.nextElementSibling?.textContent ?? "",
        getComputedStyle(mark).display === "none" ? "" : getComputedStyle(mark, "::after").content,
      ];
    }));
  for (const [shown, reach, words] of cells) {
    assertEquals(reach === "", percent(shown) !== 0, `a cell showing ${shown} has reach "${reach}"`);
    assertEquals(words === "", reach === "", `a cell of reach "${reach}" says "${words}"`);
  }
  const marks = Object.fromEntries(cells.map(([, reach, , mark]) => [reach, mark]));
  // Ten rounds left: some positions are out of points' reach and some are too rare to show.
  assertEquals([marks.impossible, marks.reachable], ["", '"*"']);
});

// Undo restores a rating input too. A ratings pass during the defeat leaves
// changed powers until the next ratings pass, then the downstream chances pass.
const CHANCES_SETTLE_MS = 2 * STREAM_MS;

test("test-chances-live: a result recorded for a game still to play moves the chances on a page left open, and undoing it brings them back", async () => {
  // Flamengo's next home game, lost heavily: the leader's title chance must fall.
  const game = await query(`SELECT g.id FROM game g JOIN team t ON t.id = g.home_id JOIN stage_group sg ON sg.phase_id = g.phase_id WHERE sg.id = '${SERIE_A_2026}' AND t.name = 'Flamengo-RJ' AND NOT g.played ORDER BY g.day LIMIT 1`);
  const page = await open(`/chances/${SERIE_A_2026}`);
  await page.waitForSelector(".zone-odds .rows .row .pct", { timeout: STREAM_MS });
  const before = await titleOf(page);
  try {
    await query(`UPDATE game SET played = true, home_score = 0, away_score = 5 WHERE id = '${game}'`);
    await page.waitForFunction((before: string) =>
      document.querySelector(".zone-odds .rows .row:first-child .pct")?.textContent !== before, before, { timeout: STREAM_MS });
    assert(percent(await titleOf(page)) < percent(before), "a heavy home defeat lowered the leader's title chance");
  } finally {
    await query(`UPDATE game SET played = false, home_score = NULL, away_score = NULL WHERE id = '${game}'`);
  }
  await page.waitForFunction((before: string) =>
    document.querySelector(".zone-odds .rows .row:first-child .pct")?.textContent === before, before, { timeout: CHANCES_SETTLE_MS });
});

test("test-home-featured: the front page keeps the featured season and its top six below the game feeds", async () => {
  const colors: { id: string; color: string }[] = JSON.parse(await query(`
    SELECT coalesce(json_agg(json_build_object('id', z.id, 'color', z.color)), '[]')
    FROM zone z JOIN stage_group g ON g.id=z.group_id
    JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
    WHERE c.featured`));
  try {
    for (const zone of colors) await query(`UPDATE zone SET color='#90EE90' WHERE id='${zone.id}'`);
    const page = await open("/");
    await page.waitForSelector(".feature .standings tbody tr", { timeout: 30_000 });
    const top = await said(page, ".feature .standings tbody .name");
    assertEquals(top.length, 6);
    assertEquals(top[0], "Flamengo-RJ");
    assert(await page.locator(".home-games + .feature").count(), "game feeds precede the featured table");
    // The title chance arrives once the chances computation has run over the lake.
    await page.waitForSelector(".feature .standings tbody tr:first-child .title-chance", { timeout: STREAM_MS });
    assertEquals(await page.locator('.feature .standings tbody tr:first-child .odds > [data-live]').getAttribute('data-live'), 'position_chance');
  } finally {
    for (const zone of colors) await query(`UPDATE zone SET color='${zone.color}' WHERE id='${zone.id}'`);
  }
});

test("test-home-levels: every eligible championship appears in strength order within its region", async () => {
  await query("SELECT refresh_recent_championships()");
  const expected = JSON.parse(await query(`SELECT coalesce(json_agg(rows ORDER BY region), '[]') FROM (
    SELECT region, json_agg(json_build_object('id',id,'slug',(SELECT slug FROM championship WHERE championship.id=home_championship.id),'name',full_name) ORDER BY strength DESC, full_name, id) AS items
    FROM home_championship GROUP BY region
  ) rows`));
  const page = await open("/");
  const regionOrder = ["national", "continental", "world"];
  assertEquals(await page.locator(".regions .champ-list").evaluateAll((lists: Element[]) =>
    lists.map((list) => list.getAttribute("data-filter"))), regionOrder.map((region) => `region=eq.${region}`));
  for (const region of regionOrder) {
    const rows = expected.find((row: { region: string }) => row.region === region)?.items ?? [];
    const list = `.champ-list[data-filter="region=eq.${region}"]`;
    await page.waitForFunction(({ list, count }: { list: string; count: number }) =>
      document.querySelectorAll(`${list} li:not(.empty)`).length === count, { list, count: rows.length });
    assertEquals(await texts(page, `${list} li:not(.empty)`), rows.map((row: { name: string }) => row.name));
    const ids = await page.locator(`${list} a`).evaluateAll((links: Element[]) => links.map((link) => link.getAttribute("data-param-slug")));
    assertEquals(ids, rows.map((row: { slug: string }) => row.slug));
  }
  const liveId = crypto.randomUUID();
  let link: string;
  const nationalLinks = '.champ-list[data-filter="region=eq.national"] a';
  try {
    await query(`
      INSERT INTO championship (id,name,region_name,begins,ends) VALUES
        ('${liveId}','Live tournament','ZZZ',(now() AT TIME ZONE 'America/Sao_Paulo')::date-1,(now() AT TIME ZONE 'America/Sao_Paulo')::date+1);
      INSERT INTO phase (id,championship_id,name) VALUES ('${liveId}','${liveId}','Principal');
      INSERT INTO stage_group (id,phase_id,name) VALUES ('${liveId}','${liveId}','Grupo');
      INSERT INTO team (id,name,country) VALUES ('${liveId}','Live tournament team','Brasil');
      INSERT INTO team_group (group_id,team_id) VALUES ('${liveId}','${liveId}');
      INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES
        ('${liveId}','${liveId}',(now() AT TIME ZONE 'America/Sao_Paulo')::date,1,1,0);
      SELECT refresh_recent_championships();
    `);
    const liveSlug = await address("championship", liveId);
    link = `.champ-list a[data-param-slug="${liveSlug}"]`;
    await page.waitForFunction(({ selector, id }: { selector: string; id: string }) =>
      [...document.querySelectorAll(selector)].at(-1)?.getAttribute("data-param-slug") === id,
      { selector: nationalLinks, id: liveSlug });
    await query(`UPDATE team_rating SET rating=100 WHERE id='${liveId}'; SELECT refresh_recent_championships()`);
    await page.waitForFunction(({ selector, id }: { selector: string; id: string }) =>
      document.querySelector(selector)?.getAttribute("data-param-slug") === id,
      { selector: nationalLinks, id: liveSlug });
    await query(`UPDATE championship SET name='Renamed live tournament',region='continental' WHERE id='${liveId}'; SELECT refresh_recent_championships()`);
    await page.waitForFunction((id: string) => {
      const link = document.querySelector(`.champ-list[data-filter="region=eq.continental"] a[data-param-slug="${id}"]`);
      return link?.textContent?.includes("Renamed live tournament") && !document.querySelector(`.champ-list[data-filter="region=eq.national"] a[data-param-slug="${id}"]`);
    }, liveSlug);
    await query(`UPDATE championship SET begins=(now() AT TIME ZONE 'America/Sao_Paulo')::date-60,
      ends=(now() AT TIME ZONE 'America/Sao_Paulo')::date-30 WHERE id='${liveId}'; SELECT refresh_recent_championships()`);
    await page.waitForFunction((selector: string) => !document.querySelector(selector), link);
  } finally {
    await query(`DELETE FROM championship WHERE id='${liveId}'; DELETE FROM team WHERE id='${liveId}'; SELECT refresh_recent_championships()`);
  }
});

test("test-catalog-category: every championship with its category", async () => {
  const page = await open("/campeonatos");
  const rows = await page.$$eval(".catalog-table tbody tr", (trs: Element[]) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim())));
  assertEquals(rows.length, 14);
  const category = Object.fromEntries(rows.map((r: string[]) => [r[0], r[2]]));
  assertEquals(category["Brasil - Campeonato Brasileiro Feminino 2026"], "Feminino");
  assertEquals(category["Brasil - Campeonato Brasileiro 2026"], "Profissional");
});

test("test-catalog-search: part of a name narrows the catalogue", async () => {
  const page = await open("/campeonatos");
  await page.fill('#catalog-q', "libertadores");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  assertEquals(await texts(page, ".catalog-table tbody tr td:first-child"), ["América do Sul - Copa Libertadores 2026"]);
  await page.fill('#catalog-q', "");
  await page.selectOption('#catalog-region', "continental");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 3);
});

test("test-catalog-no-match: a search that matches nothing says so", async () => {
  const page = await open("/campeonatos");
  await page.fill('#catalog-q', "xyzzy");
  await page.waitForFunction(() =>
    (document.querySelector(".catalog-table")?.textContent ?? "").includes("Nenhum campeonato com esse nome nesta esfera."));
});

test("test-catalog-kept: what was typed survives a trip and back", async () => {
  const page = await open("/campeonatos");
  await page.fill('#catalog-q', "brasileiro");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 5);
  await page.click(".catalog-table tbody tr:first-child a");
  await page.waitForSelector(".championship");
  await page.goBack();
  await page.waitForFunction(() => (document.querySelector('#catalog-q') as HTMLInputElement | null)?.value === "brasileiro");
});

test("test-championship-structure: phases, groups, teams, zones and points", async () => {
  const page = await championship(BRASILEIRO_2026);
  assertEquals(await texts(page, ".championship h1"), ["Brasil - Campeonato Brasileiro 2026"]);
  assertEquals(await texts(page, ".phase h2"), ["Turno e Returno"]);
  await page.waitForFunction(() => document.querySelectorAll(".standings tbody tr").length === 20);
  assertEquals((await texts(page, ".zones li")).length, 5);
  assertEquals(await texts(page, ".points b"), ["3", "1", "0"]);
});

test("test-standings-page: the championship page shows the recounted table", async () => {
  const page = await championship(BRASILEIRO_2026);
  await page.waitForFunction(() => document.querySelectorAll(".standings tbody tr").length === 20);
  const first = await page.$eval(".standings tbody tr", (tr: Element) =>
    [".pos", ".name", ".pts"].map((c) => tr.querySelector(c)?.textContent?.trim()).concat(tr.getAttribute("data-zone") ?? ""));
  assertEquals(first, ["1", "Flamengo-RJ", "60", "champion"]);
});

test("test-standings-live: a result recorded after the fact moves the table", async () => {
  const page = await championship(BRASILEIRO_2026);
  await page.waitForFunction(() => document.querySelectorAll(".standings tbody tr").length === 20);
  const before = Number(await pointsOf(page, "Botafogo-RJ"));
  try {
    await query(`UPDATE game SET home_score = 1 WHERE id = '${DRAW}'`);
    await awaitPoints(page, "Botafogo-RJ", before + 2);
  } finally {
    await query(`UPDATE game SET home_score = 0 WHERE id = '${DRAW}'`);
  }
  await awaitPoints(page, "Botafogo-RJ", before);
});

test("test-championship-old-points: the two-point era", async () => {
  const page = await championship(BRASILEIRO_1971);
  assertEquals(await texts(page, ".points b"), ["2", "1", "0"]);
});

test("test-championship-no-groups: a phase with no groups says so", async () => {
  const page = await championship(LIBERTADORES_2026);
  await page.waitForFunction(() => document.querySelectorAll(".phase").length === 2);
  const phases = await texts(page, ".phase");
  assert(phases.every((p) => p.includes("Esta fase ainda não tem grupos cadastrados.")), phases.join(" | "));
});

test("test-championship-gone: an unknown championship says so", () => gone("/campeonato", "Este campeonato não existe ou foi removido."));

// dd/mm/yyyy hh:mm, as the rows print it, sortable.
const sortable = (when: string) => when.replace(/^(\d\d)\/(\d\d)\/(\d{4})\s*/, "$3$2$1 ");

// A list's days, newest first.
const newestFirst = async (page: Page, selector: string) => {
  const days = (await texts(page, selector)).map(sortable);
  assert(days.length > 1 && days.every((d, i) => i === 0 || days[i - 1] >= d), days.join(" | "));
};

test("test-games-upcoming: the games page opens on the upcoming games, soonest first", async () => {
  const page = await open("/jogos");
  await page.waitForSelector(".games.upcoming .game-row");
  assertEquals(await page.$eval(".games-view", (el: Element) => el.getAttribute("data-view")), "upcoming");
  const whens = (await texts(page, ".games.upcoming .when")).map(sortable);
  assert(whens.length > 1 && whens.every((w, i) => i === 0 || whens[i - 1] <= w), whens.join(" | "));
  const first = await page.$eval(".games.upcoming .game-row", (a: Element) =>
    [".where", ".home", ".away"].map((c) => a.querySelector(c)?.textContent?.trim() ?? ""));
  assert(first.every(Boolean), first.join(" | "));
});

test("test-games-results: the results tab lists played games and is remembered", async () => {
  const page = await open("/jogos");
  await page.click("#games-tab-results");
  await page.waitForSelector('.games-view[data-view="results"] .games.results .game-row');
  assertEquals(await page.$eval("#games-tab-results", (el: Element) => el.getAttribute("aria-selected")), "true");
  const score = await page.$eval(".games.results .score", (el: Element) => [...el.querySelectorAll("b")].map((b) => b.textContent));
  assert(score.every((s: string) => /^\d+$/.test(s)), score.join("x"));
  await page.click(".masthead .wordmark");
  await page.waitForURL(await fixturePath(`${base}/`));
  await page.goBack();
  await page.waitForSelector('.shell-screen:not([hidden]):not([data-served]) .games-view[data-view="results"]');
});

test("test-game-page: a game's page shows its score, facts, goals and line-ups", async () => {
  const page = await (await context()).newPage();
  const requests: URL[] = [];
  page.on("request", (request: { url(): string }) => requests.push(new URL(request.url())));
  await visit(page, `/jogo/${WIN}`);
  await page.waitForSelector(".goals li");
  assertEquals(await texts(page, ".game h1.band"), ["Brasil - Campeonato Brasileiro 2026"]);
  assertEquals((await texts(page, ".scoreboard > *")).map((t) => t.replace(/\s+/g, "")), ["Athletico-PR", "2x1", "Bahia-BA"]);
  assertEquals((await texts(page, ".game-facts dd")).slice(0, 3), ["28", "20/09/2026", "19:30"]);
  await page.waitForFunction(() => document.querySelectorAll(".goals li").length === 3);
  assertEquals(await page.$$eval(".goals li", (els: Element[]) => els.map((e) => e.getAttribute("data-side"))), ["home", "away", "home"]);
  await page.waitForFunction(() =>
    ["home", "away"].every((s) => document.querySelectorAll(`.lineup[data-side="${s}"] tbody tr`).length >= 11));
  assert((await page.$$('.lineup tr[data-yellow="true"]')).length > 0);
  assertEquals(await texts(page, ".lineup caption"), ["Athletico-PR", "Bahia-BA"]);
  // A match's lineup must not load the archive just to notice deletions.
  const lineups = requests.filter(url => url.pathname === "/crud/player_game");
  assert(lineups.length > 0);
  assert(lineups.every(url => url.searchParams.get("game_id") === `eq.${WIN}`));
  assert(!requests.some(url => url.pathname.endsWith("/shape") && url.searchParams.get("table") === "player_game"));
  assert(requests.filter(url => url.pathname.endsWith("/shape") && url.searchParams.get("table") === "game_card")
    .every(url => url.searchParams.get("log") === "changes_only"));
  // A game with neither says nothing of either.
  assertEquals(await said(page, ".extra"), [""]);

  const final = await open(`/jogo/${FINAL}`);
  await final.waitForSelector(".goals li");
  assertEquals(await said(final, ".extra"), ["Prorrogação 1–0"]);
  assertEquals(await said(final, ".goals .minute"), ["106"]);
  assertEquals(await said(final, ".goals li a"), ["F. Torres"]);
  const shootout = await open(`/jogo/${SHOOTOUT}`);
  assertEquals(await said(shootout, ".extra"), ["Prorrogação 0–0 Pênaltis 4–3"]);
});

test("test-game-gone: an address naming no game says so", () => gone("/jogo", "Este jogo não existe ou foi removido."));

test("test-rounds: the championship page shows the current round and the next", async () => {
  const page = await championship(BRASILEIRO_2026);
  await page.waitForFunction(() => document.querySelectorAll(".round .game-row").length === 20);
  assertEquals(await said(page, ".round h3"), ["Rodada 28", "Rodada 29"]);
});

test("test-teams: part of a name narrows the teams", async () => {
  const page = await open("/equipes");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 40);
  await page.fill("#teams-q", "athletico");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  assertEquals(await said(page, ".catalog-table tbody tr td:not(:nth-child(2))"), ["Athletico-PR", "Curitiba", "Brasil"]);
  assert((await said(page, ".catalog-table tbody tr td:nth-child(2)"))[0].length > 0, "the filtered row retains its rating");
});

test("test-team-page: a team's profile shows facts, championships and deduplicated players", async () => {
  const page = await (await context()).newPage();
  const chartRequest = page.waitForRequest((request: { url(): string }) => {
    const url = new URL(request.url());
    return url.searchParams.get("table") === "team_rating_chart" && url.searchParams.has("subset__where");
  });
  await visit(page, `/equipe/${ATHLETICO}`);
  const chart = new URL((await chartRequest).url());
  const predicate = chart.searchParams.get("subset__where")!;
  assert(predicate.includes('"team_id" =') && predicate.includes('"period" ='),
    "one chart must not download the archive's complete chart collection");
  assert(Object.values(JSON.parse(chart.searchParams.get("subset__params")!)).includes(ATHLETICO));
  await page.waitForSelector(".team-current-championships a[data-route='equipe-campeonato']");
  assertEquals(await said(page, ".team h1.band"), ["Athletico-PR"]);
  assertEquals((await said(page, ".team .game-facts dd")).slice(0, 4), ["Club Athletico Paranaense", "Curitiba", "Brasil", "26/03/1924"]);
  await page.waitForFunction(() => document.querySelectorAll(".team-current-players a[data-route='jogador']").length > 11);
  const currentPlayers = await page.locator(".team-current-players a[data-route='jogador']")
    .evaluateAll((links: HTMLAnchorElement[]) => links.map((link) => link.getAttribute("data-param-slug")));
  assertEquals(new Set(currentPlayers).size, currentPlayers.length, "the profile lists each current player once across seasons");
  await page.locator(`.team-current-championships a[data-param-championship="${await address("championship", BRASILEIRO_2026)}"]`).click();
  await page.waitForURL(await fixturePath(`**/equipe-campeonato/${ATHLETICO}/${BRASILEIRO_2026}**`));
  await page.waitForFunction(() => document.querySelectorAll(".team-roster .squad-table tbody tr").length > 11);
  const viveros = await page.$$eval(".team-roster .squad-table tbody tr", (rows: Element[]) =>
    rows.map((r) => {
      const cells = [...r.querySelectorAll("td")].map((td) => td.textContent?.trim());
      return [0, 1, 2, 3, 4, 6, 7, 15, 16].map((column) => cells[column]);
    }).find((cells) => cells[0] === "K. Viveros"));
  assertEquals(viveros, ["K. Viveros", "fw", "26", "26", "0", "2.286", "18", "6", "0"]);
});

test("test-player-page: a player's page shows their season and their games", async () => {
  const page = await open(`/jogador/${VIVEROS}`);
  await page.waitForSelector(".season-table tbody tr");
  assertEquals(await said(page, ".season-table tbody tr"), ["Brasil - Campeonato Brasileiro 2026 Athletico-PR 26 26 0 2286 18 4 6 0"]);
  await page.waitForFunction(() => document.querySelectorAll(".player-games .game-row").length === 26);
  await newestFirst(page, ".player-games .day");
});

// A column of a player's first season line reaching a value, as a stream
// recounts it.
const season = (page: Page, column: number, want: string) =>
  page.waitForFunction(
    ([column, want]: [number, string]) =>
      document.querySelector(`.season-table tbody tr td:nth-child(${column})`)?.textContent?.trim() === want,
    [column, want],
    { timeout: STREAM_MS },
  );
const GOALS = 7, PLAYED = 3;

test("test-player-stats-live: a goal recorded after the fact moves the season with no reload", async () => {
  const page = await open(`/jogador/${VIVEROS}`);
  await season(page, GOALS, "18");
  try {
    await query(`INSERT INTO goal (id, game_id, player_id, side, minute) VALUES ('0e000000-0000-4000-8000-0000000fffff', '${WIN}', '${VIVEROS}', 'home', 90)`);
    await season(page, GOALS, "19");
  } finally {
    await query(`DELETE FROM goal WHERE id = '0e000000-0000-4000-8000-0000000fffff'`);
  }
  await season(page, GOALS, "18");
});

test("test-appearance-live: an appearance removed after the fact moves the season with no reload", async () => {
  const page = await open(`/jogador/${VIVEROS}`);
  const played = (n: string) => season(page, PLAYED, n);
  await played("26");
  const cols = "id, game_id, player_id, side, on_minute, off_minute, yellow, red, bench";
  // His latest appearance, whichever game it was.
  await query(`CREATE TABLE kept_appearance AS SELECT ${cols} FROM player_game WHERE player_id = '${VIVEROS}' ORDER BY day DESC LIMIT 1`);
  try {
    await query(`DELETE FROM player_game WHERE id IN (SELECT id FROM kept_appearance)`);
    await played("25");
  } finally {
    await query(`INSERT INTO player_game (${cols}) SELECT ${cols} FROM kept_appearance; DROP TABLE kept_appearance`);
  }
  await played("26");
});

test("test-team-gone: an address naming no team says so", () => gone("/equipe", "Esta equipe não existe ou foi removida."));

test("test-player-gone: an address naming no player says so", () => gone("/jogador", "Este jogador não existe ou foi removido."));

test("test-venue-home: a team's ground shows the team and the games played there", async () => {
  // São Paulo-SP's ground, which the 2006 pages call Morumbi and the archive
  // now calls Morumbis: one stadium.
  const team = await open("/equipe/07000000-0000-4000-8000-000000000011");
  await team.waitForSelector('.game-facts dd[data-live="stadium"]');
  const ground = await said(team, '.game-facts dd[data-live="stadium"]');
  assertEquals(ground, ["Morumbis"]);
  const stadiums = await open("/estadios");
  await stadiums.fill("#stadiums-q", "morumbi");
  await stadiums.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  await stadiums.click(".catalog-table tbody a");
  await stadiums.waitForSelector(".venue-games .game-row");
  assert((await said(stadiums, ".home-teams .chip")).includes("São Paulo-SP"));
});

test("test-venues: part of a name narrows the stadiums and the referees", async () => {
  const stadiums = await open("/estadios");
  await stadiums.fill("#stadiums-q", "pacaembu");
  await stadiums.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  assertEquals(await said(stadiums, ".catalog-table tbody td:first-child"), ["Pacaembu"]);
  const referees = await open("/arbitros");
  await referees.fill("#referees-q", "abade");
  await referees.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  assertEquals(await said(referees, ".catalog-table tbody tr"), ["Cléber Wellington Abade SP"]);
});

test("test-stadium-page: a stadium's page lists the games played there, newest first", async () => {
  const page = await open(`/estadio/${PACAEMBU}`);
  await page.waitForSelector(".venue-games .game-row");
  assertEquals(await said(page, ".venue h1.band"), ["Pacaembu"]);
  await newestFirst(page, ".venue-games .day");
});

test("test-referee-page: a referee's page lists the games they refereed, newest first", async () => {
  const page = await open(`/arbitro/${ABADE}`);
  await page.waitForSelector(".venue-games .game-row");
  assertEquals(await said(page, ".venue .game-facts dd"), ["SP"]);
  await newestFirst(page, ".venue-games .day");
});

test("test-game-venue: a game's page names its stadium and its referee, each leading to their page", async () => {
  const page = await open(`/jogo/${DERBY_2006}`);
  await page.waitForSelector('.game-facts a[data-route="estadio"]');
  assertEquals(await said(page, ".game-facts dd > a:not(:empty)"), ["Pacaembu", "Cléber Wellington Abade"]);
  await page.click('.game-facts a[data-route="arbitro"]');
  await page.waitForURL(await fixturePath(`**/arbitro/${ABADE}`));
});

test("test-venue-gone: an address naming no stadium, or no referee, says so", async () => {
  await gone("/estadio", "Este estádio não existe ou foi removido.");
  await gone("/arbitro", "Este árbitro não existe ou foi removido.");
});

// An account the archive has made an editor: the grant is given out of band,
// as an operator would.
const editor = async (handle: string) => {
  const reader = await signedIn(handle);
  await query(`INSERT INTO editor (app_user_id) VALUES ('${reader.user.id}')`);
  return reader;
};
const forget = (reader: { user: { id: string } }) =>
  query(`DELETE FROM comment WHERE app_user_id = '${reader.user.id}'; DELETE FROM app_user WHERE id = '${reader.user.id}'`);

test("test-edit-link: an editor is offered the editor on a game's page, and a reader who is not is offered nothing", async () => {
  const ed = await editor(`editor-${Date.now()}`);
  const plain = await signedIn(`reader-${Date.now()}`);
  try {
    const mine = await open(`/jogo/${WIN}`, { session: ed });
    await mine.waitForSelector(".edit-link", { timeout: 30_000 });
    assertEquals(await said(mine, ".edit-link"), ["Editar jogo"]);
    for (const page of [await open(`/jogo/${WIN}`, { session: plain }), await open(`/jogo/${WIN}`)]) {
      // The grant is the one row an editor syncs; give the store time to have
      // delivered it before saying it is not there.
      await page.waitForTimeout(1500);
      assertEquals((await page.$$(".edit-link")).length, 0);
    }
  } finally {
    await forget(ed);
    await forget(plain);
  }
});

test("test-edit-game: an editor's correction of the score and the crowd reaches the game's page", async () => {
  const ed = await editor(`editor-${Date.now()}`);
  const before = await query(`SELECT home_score || ',' || coalesce(attendance::text, 'NULL') FROM game WHERE id = '${WIN}'`);
  const [score, crowd] = before.split(",");
  try {
    const page = await open(`/editar/${WIN}`, { session: ed });
    const reader = await open(`/jogo/${WIN}`);
    await page.waitForSelector('.edit[data-state="editing"]');
    assertEquals(await page.inputValue("#edit-home"), score);
    await page.fill("#edit-home", "3");
    await page.fill("#edit-attendance", "38000");
    // A select's value is a uuid like a goal's: clicking one fired the remove
    // arrow, and the editor was refused before it had saved anything.
    await page.click("#edit-stadium");
    await page.keyboard.press("Escape");
    assertEquals(await page.getAttribute(".edit", "data-state"), "editing");
    await page.click("#edit-save");
    await reader.waitForFunction(() =>
      document.querySelector(".scoreboard .home + .score b")?.textContent === "3", null, { timeout: 30_000 });
    await reader.waitForFunction(() =>
      [...document.querySelectorAll(".game-facts dd")].some((d) => d.textContent?.replace(/\D/g, "") === "38000"), null, { timeout: 30_000 });
    await page.waitForSelector('.edit[data-state="editing"]');
  } finally {
    await query(`UPDATE game SET home_score = ${score}, attendance = ${crowd} WHERE id = '${WIN}'`);
    await forget(ed);
  }
});

test("test-edit-goal: a goal an editor adds and then removes moves the game's goals and the scorer's season each time", async () => {
  const ed = await editor(`editor-${Date.now()}`);
  // A home starter of the game, whose season this championship's first row is.
  const player = await query(`SELECT player_id FROM player_game WHERE game_id = '${WIN}' AND side = 'home' AND NOT bench ORDER BY on_minute, player_id LIMIT 1`);
  try {
    const page = await open(`/editar/${WIN}`, { session: ed });
    const reader = await open(`/jogo/${WIN}`);
    const scorer = await open(`/jogador/${player}`);
    await page.waitForSelector('.edit[data-state="editing"]');
    await scorer.waitForSelector(".season-table tbody tr");
    const before = Number(await scorer.$eval(`.season-table tbody tr td:nth-child(${GOALS})`, (e: Element) => e.textContent?.trim()));
    const goals = (await said(reader, ".goals li")).length;
    await page.waitForSelector(`#goal-player option[value="${player}"]`, { state: "attached" });
    await page.fill("#goal-minute", "90");
    await page.selectOption("#goal-player", player);
    await page.click("#goal-add-home");
    await reader.waitForFunction((n: number) => document.querySelectorAll(".goals li").length === n + 1, goals, { timeout: 30_000 });
    await season(scorer, GOALS, String(before + 1));
    const added = page.locator(".goal-side .goal-rows li", { has: page.locator('.minute:text-is("90")') });
    await added.locator(".remove").click();
    await reader.waitForFunction((n: number) => document.querySelectorAll(".goals li").length === n, goals, { timeout: 30_000 });
    await season(scorer, GOALS, String(before));
  } finally {
    await query(`DELETE FROM goal WHERE game_id = '${WIN}' AND minute = 90`);
    await forget(ed);
  }
});

const REFUSED = "Não foi possível salvar: só editores alteram jogos, um jogo realizado tem o placar dos dois lados, e um gol precisa de um jogador da escalação. O que você editou continua aqui.";

test("test-edit-refused: a non-editor's save and a goal with no scorer are refused with the reason, and the edits stay", async () => {
  const plain = await signedIn(`reader-${Date.now()}`);
  const ed = await editor(`editor-${Date.now()}`);
  const score = await query(`SELECT home_score FROM game WHERE id = '${WIN}'`);
  try {
    const page = await open(`/editar/${WIN}`, { session: plain });
    await page.waitForSelector('.edit[data-state="editing"]');
    await page.fill("#edit-home", "7");
    await page.click("#edit-save");
    await page.waitForSelector('.edit[data-state="refused"]', { timeout: 30_000 });
    assertEquals(await said(page, ".edit .refusal"), [REFUSED]);
    assertEquals(await page.inputValue("#edit-home"), "7");
    assertEquals(await query(`SELECT home_score FROM game WHERE id = '${WIN}'`), score);

    // An editor's goal with a minute and no scorer: the archive refuses a
    // goal nobody scored, and the minute stays to be given its scorer.
    const mine = await open(`/editar/${WIN}`, { session: ed });
    await mine.waitForSelector('.edit[data-state="editing"]');
    await mine.fill("#goal-minute", "77");
    await mine.click("#goal-add-away");
    await mine.waitForSelector('.edit[data-state="refused"]', { timeout: 30_000 });
    assertEquals(await said(mine, ".edit .refusal"), [REFUSED]);
    assertEquals(await mine.inputValue("#goal-minute"), "77");
  } finally {
    await forget(plain);
    await forget(ed);
  }
});

test("test-team-rating: a team's page shows its latest rating, a number from 0 to 100", async () => {
  const page = await open(`/equipe/${ATHLETICO}`);
  // Refit by the ratings computation after the archive is published to the lake.
  await page.waitForSelector(".rating abbr", { timeout: STREAM_MS });
  const rating = percent(await page.$eval(".rating abbr", (e: Element) => e.textContent ?? ""));
  assert(rating >= 0 && rating <= 100, `Athletico's rating ${rating} is outside 0..100`);
});

test("test-game-importance: a game still to play shows how much its result matters to each side", async () => {
  const game = await query(`SELECT g.id FROM game g JOIN stage_group sg ON sg.phase_id = g.phase_id WHERE sg.id = '${SERIE_A_2026}' AND NOT g.played ORDER BY g.day, g.id LIMIT 1`);
  const page = await open(`/jogo/${game}`);
  await page.waitForSelector(".importance abbr", { timeout: STREAM_MS });
  const sides = (await said(page, ".importance abbr span")).map(percent);
  assertEquals(sides.length, 2);
  assert(sides.every((v) => v >= 0), `importance ${sides} has a negative side`);
});

test("test-sign-in: a guest is offered a passkey in the strip", async () => {
  const page = await open(`/jogo/${WIN}`);
  assertEquals(await said(page, "body > nav .shell-signin"), ["Entrar"]);
});

test("test-comment: a signed-in reader's comment appears for every reader of the game", async () => {
  const author = await signedIn(`tester-${Date.now()}`);
  const body = `Que virada! ${Date.now()}`;
  // An older comment already there: with one row, the first is first in
  // either order, and "newest first" would pass oldest first.
  const earlier = `Antes do jogo ${Date.now()}`;
  await query(`INSERT INTO comment (game_id, app_user_id, body, created_at) VALUES ('${WIN}', '${author.user.id}', '${earlier}', now() - interval '1 day')`);
  try {
    const writer = await open(`/jogo/${WIN}`, { session: author });
    const reader = await open(`/jogo/${WIN}`);
    await writer.waitForSelector('.composer[data-state="writing"]');
    await writer.fill("#comment-body", body);
    await writer.click("#comment-post");
    for (const page of [writer, reader]) {
      await page.waitForFunction((body: string) =>
        [...document.querySelectorAll(".comment-list .body")].some((e) => e.textContent === body), body, { timeout: 30_000 });
    }
    assertEquals((await said(reader, ".comment-list li"))[0], `${author.user.handle} ${(await said(reader, ".comment-list time"))[0]} ${body}`);
    assertEquals((await said(reader, ".comment-list .body")).slice(0, 2), [body, earlier]);
    await writer.waitForFunction(() => (document.querySelector("#comment-body") as HTMLTextAreaElement).value === "");
  } finally {
    await query(`DELETE FROM comment WHERE app_user_id = '${author.user.id}'; DELETE FROM app_user WHERE id = '${author.user.id}'`);
  }
});

test("test-comment-refused: a guest's comment is refused and what was typed is kept", async () => {
  const page = await open(`/jogo/${WIN}`);
  await page.waitForSelector('.composer[data-state="writing"]');
  await page.fill("#comment-body", "Golaço!");
  await page.click("#comment-post");
  await page.waitForSelector('.composer[data-state="refused"] .refusal', { state: "visible" });
  assertEquals(await page.$eval("#comment-body", (e: Element) => (e as HTMLTextAreaElement).value), "Golaço!");
});

test("test-languages: three languages, each at its own address", async () => {
  // Spanish and Portuguese share this title, so the search label tells them apart.
  const es = await open("/es/campeonatos");
  assertEquals(await texts(es, "h1.band"), ["Campeonatos"]);
  assertEquals(await texts(es, "label[for=\"catalog-q\"] > span"), ["Nombre"]);
  const en = await open("/en/championships");
  assertEquals(await texts(en, "h1.band"), ["Championships"]);
  const page = await championship(BRASILEIRO_2026);
  await page.click('.masthead .langs a[data-locale="en-GB"]');
  await page.waitForURL(await fixturePath(`**/en/championship/${BRASILEIRO_2026}`));
});

test("test-dark: the dark appearance resolves the dark tokens", async () => {
  const page = await open("/", { dark: true });
  const column = await page.$eval("main#app", (el: Element) => getComputedStyle(el).backgroundColor);
  assertEquals(column, "rgb(35, 38, 15)");
});

test("test-screen-range: no page scrolls sideways", async () => {
  for (const width of [390, 768, 1366, 1920]) {
    const page = await (await context({ width })).newPage();
    for (const path of ["/", "/campeonatos", `/campeonato/${BRASILEIRO_2026}`, "/jogos", `/jogo/${WIN}`, "/equipes", `/equipe/${ATHLETICO}`, `/jogador/${VIVEROS}`, "/estadios", `/estadio/${PACAEMBU}`, "/arbitros", `/arbitro/${ABADE}`]) {
      await visit(page, path);
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert(scroll <= client, `${path} at ${width}px scrolls sideways: ${scroll} > ${client}`);
    }
  }
});
// What the door answers before any script runs: a document for every public
// route, rendered on request with its rows, so a reader who has not booted the
// app yet, and a crawler that never will, is answered with the page.
const served = async (path: string, language = "pt-BR") => {
  const res = await fetch(`${base}${await fixturePath(path)}`, { headers: { "Accept-Language": language }, redirect: "manual" });
  return { status: res.status, cache: res.headers.get("cache-control"), html: await res.text() };
};
const h1Of = (html: string) => /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1].trim();
// The deployment's origin, which every absolute address is spelled against.
const origin = Deno.env.get("ORIGIN");
if (origin === undefined) throw new Error("ORIGIN is unset: the check runs beside the stack, which sets it");
// What the door's plain listener answers under a Host of the asker's choosing,
// which fetch will not send: the listener a deployment's balancer reaches.
const underHost = async (host: string, path: string) => {
  const conn = await Deno.connect({ hostname: new URL(base).hostname, port: 8080 });
  await conn.write(new TextEncoder().encode(`GET ${await fixturePath(path)} HTTP/1.1\r\nHost: ${host}\r\nAccept-Language: pt-BR\r\nConnection: close\r\n\r\n`));
  const raw = new TextDecoder().decode(await new Response(conn.readable).arrayBuffer());
  const [head, body] = [raw.slice(0, raw.indexOf("\r\n\r\n")), raw.slice(raw.indexOf("\r\n\r\n") + 4)];
  const status = Number(head.split(" ")[1]);
  if (!/^transfer-encoding:\s*chunked/im.test(head)) return { status, body };
  let text = "";
  for (let at = 0; ;) {
    const end = body.indexOf("\r\n", at);
    const size = parseInt(body.slice(at, end), 16);
    if (size === 0) return { status, body: text };
    text += body.slice(end + 2, end + 2 + size);
    at = end + 2 + size + 2;
  }
};

test("door: every public route is answered with its document, rows and all, in its language", async () => {
  // Prerendered, a page's empty lists filled once the shell took it over and
  // pushed down everything after them: a layout shift of 0.74 on the home
  // page, and of 0.12 on the catalogue.
  for (const [path, h1] of [["/campeonatos", "Campeonatos"], ["/es/campeonatos", "Campeonatos"], ["/en/championships", "Championships"]]) {
    const page = await served(path);
    assertEquals([page.status, page.cache, h1Of(page.html)], [200, "public, no-cache", h1], path);
    // Under the search's seed, which is every tab's first: the whole
    // catalogue, its region chosen as none.
    assert((page.html.match(/<tr[^>]* data-id="/g) ?? []).length > 3, `${path} carries no rows`);
    assert(/<option[^>]*value=""[^>]*selected|<option[^>]*selected[^>]*value=""/.test(page.html), `${path} chose no region`);
    // Absolute against the deployment's origin, as the sitemap's addresses are.
    assert(page.html.includes(`<link href="${origin}${await fixturePath(path)}" rel="canonical">`), `${path} names no absolute canonical`);
    assert(page.html.includes(`<link hreflang="x-default" href="${origin}/campeonatos" rel="alternate">`), `${path} names no x-default`);
  }
  for (const path of ["/", "/en", "/en/", "/equipes", "/estadios", "/arbitros"]) {
    const page = await served(path);
    assertEquals([page.status, page.cache], [200, "public, no-cache"], path);
    assert(page.html.includes('<div data-served="" class="shell-screen">'), `${path} is not a document`);
    assert(/<(li|tr)[^>]* data-id="/.test(page.html), `${path} carries no rows`);
  }
  // A reader whose language is not the address's is answered with their own
  // document at once: a redirect is a round trip ahead of every byte.
  const english = await served("/", "en-US,en;q=0.9");
  assertEquals(english.status, 200);
  assert(english.html.includes('<html lang="en-GB"'), english.html.slice(0, 200));
  assertEquals((await served("/nowhere")).status, 404);
});

test("door: readable detail addresses render their records and missing addresses return 404", async () => {
  for (const [fixture, words] of [
    [`/equipe/${ATHLETICO}`, "Athletico-PR"],
    [`/campeonato/${BRASILEIRO_2026}`, "Campeonato Brasileiro"],
    [`/jogo/${WIN}`, "Bahia-BA"],
    [`/jogador/${VIVEROS}`, "Viveros"],
    [`/estadio/${PACAEMBU}`, "Pacaembu"],
    [`/arbitro/${ABADE}`, "Abade"],
    [`/chances/${SERIE_A_2026}`, "Flamengo-RJ"],
    [`/equipe-campeonato/${ATHLETICO}/${BRASILEIRO_2026}`, "Athletico-PR"],
  ]) {
    const path = await fixturePath(fixture);
    const page = await served(path);
    assertEquals([page.status, page.cache], [200, "public, no-cache"], path);
    assert(page.html.includes('<div data-served="" class="shell-screen">'), `${path} has no served document`);
    assert(page.html.includes(words), `${path} did not render its record`);
    assert(page.html.includes(`<link href="${origin}${path}" rel="canonical">`), `${path} lost its readable canonical`);
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path), path);
  }
  for (const path of [
    "/equipe/missing-address", "/campeonato/missing-address", "/jogo/missing-address",
    "/jogador/missing-address", "/estadio/missing-address", "/arbitro/missing-address",
    "/chances/missing-address", "/equipe-campeonato/missing-address/missing-address",
    `/equipe-campeonato/${await address("team", ATHLETICO)}/missing-address`,
    `/equipe-campeonato/missing-address/${await address("championship", BRASILEIRO_2026)}`,
  ]) {
    assertEquals((await served(path)).status, 404, path);
  }
});

test("door: team statistics and derived charts arrive before JavaScript and survive hydration", async () => {
  const team = "07000000-0000-4000-8000-000000000001";
  const path = `/en/team-championship/${team}/${BRASILEIRO_2026}`;
  const profile = await served(`/en/team/${team}`);
  assertEquals([profile.status, profile.cache], [200, "public, no-cache"]);
  assert(profile.html.includes('data-served=""'), "the team profile is not server rendered");
  assert(profile.html.includes("Flamengo-RJ"), "the team profile has no team");
  const initial = await served(path);
  assertEquals([initial.status, initial.cache], [200, "public, no-cache"]);
  const page = await (await context()).newPage();
  const statistics = (html: string | null) => {
    const doc = html === null ? document : new DOMParser().parseFromString(html, "text/html");
    const text = (selector: string) => [...doc.querySelectorAll(selector)].map((e) => e.textContent?.trim());
    return {
      positions: text('.team-odds-table tbody tr [data-text="{percent}"]'),
      zones: text('.team-zone-odds [data-text="{percent}"]'),
      positionCharts: doc.querySelectorAll('.team-chance-detail [data-text-format="team-chart"] svg').length,
      campaignCharts: doc.querySelectorAll('.team-campaign [data-text-format="team-chart"] svg').length,
    };
  };
  const before = await page.evaluate(statistics, initial.html);
  assertEquals(before.positions.length, 20);
  assertEquals(before.zones.length, 5);
  assertEquals(before.positionCharts, 1, "the server serialized before the position-chart fold finished");
  assertEquals(before.campaignCharts, 1);
  await visit(page, path);
  await page.waitForSelector('.team-chance-detail [data-text-format="team-chart"] svg');
  assertEquals(await page.evaluate(statistics, null), before, "hydration changed the served statistics");
});

test("door: every absolute address is the deployment's, whatever Host it is asked under", async () => {
  // The origin was the request's scheme and Host, and the door answers any
  // Host: a client chose the canonical, alternates, og:url, robots.txt and
  // sitemap of answers marked public, rendered and prerendered alike.
  for (const host of ["evil.example", "evil.example:8443"]) {
    const robots = await underHost(host, "/robots.txt");
    assertEquals(robots.status, 200);
    assert(robots.body.includes(`Sitemap: ${origin}/sitemap.xml`), robots.body);
    const sitemap = await underHost(host, "/sitemap.xml");
    assertEquals(sitemap.status, 200);
    assert(sitemap.body.includes(`<loc>${origin}/campeonatos</loc>`), sitemap.body.slice(0, 400));
    assert(sitemap.body.includes(`hreflang="x-default" href="${origin}/campeonatos"`), sitemap.body.slice(0, 400));
    for (const page of [robots, sitemap]) assert(!page.body.includes("evil.example"), page.body.slice(0, 400));
    for (const path of ["/campeonatos", "/en/championships", `/jogo/${WIN}`]) {
      const page = await underHost(host, path);
      assertEquals(page.status, 200, path);
      assert(page.body.includes(`<link href="${origin}${await fixturePath(path)}" rel="canonical">`), `${path} under ${host} names no canonical at ${origin}`);
      const ogUrl = /<meta (?:content="([^"]*)" property="og:url"|property="og:url" content="([^"]*)")>/.exec(page.body);
      assertEquals(ogUrl?.[1] ?? ogUrl?.[2], `${origin}${await fixturePath(path)}`, `${path} under ${host}: og:url`);
      const alternates = [...page.body.matchAll(/hreflang="([^"]*)" href="([^"]*)"/g)];
      assert(alternates.some(([, lang]) => lang === "x-default"), `${path} names no x-default`);
      for (const [, lang, href] of alternates) assert(href.startsWith(`${origin}/`), `${path} under ${host}: ${lang} at ${href}`);
      assert(!page.body.includes("evil.example"), `${path} under ${host} spells the Host`);
    }
  }
});

test("door: every file revalidates on its hash, without its body", async () => {
  // Caddy's own validator, its mtime and size, was empty in an image built at
  // mtime 0 and only the size at any other clamped mtime, so llms.txt's and the
  // manifest's differed by length alone; and its templates deleted a crawler
  // file's, so the revalidation the worker makes behind every page it paints
  // carried the whole unchanged file.
  for (const path of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/manifest.webmanifest", "/shell/screens/campeonatos.css", "/omnishell/interpreter/shell.js"]) {
    const first = await fetch(`${base}${await fixturePath(path)}`);
    await first.text();
    const etag = first.headers.get("etag") ?? "";
    assert(/^"[0-9a-f]{64}(-gzip|-zstd)?"$/.test(etag), `${path} carries the validator ${JSON.stringify(etag)}`);
    const again = await fetch(`${base}${await fixturePath(path)}`, { headers: { "If-None-Match": etag } });
    assertEquals([again.status, await again.text()], [304, ""], path);
  }
});

test("door: a game's page is answered with its rows, for no one in particular", async () => {
  const page = await served(`/jogo/${WIN}`);
  assertEquals([page.status, page.cache], [200, "public, no-cache"]);
  for (const words of ["Athletico-PR", "Bahia-BA", "Brasil - Campeonato Brasileiro 2026"]) assert(page.html.includes(words), words);
  assert(/data-text="\{home_score\}">2</.test(page.html) && /data-text="\{away_score\}">1</.test(page.html), "no score");
  assert((page.html.match(/<tr[^>]* data-id=/g) ?? []).length >= 22, "no line-ups");
  assert(page.html.includes(`property="og:title"`), "no og:title");
  assert(page.html.includes(`<link href="${origin}${await fixturePath(`/jogo/${WIN}`)}" rel="canonical">`), "no absolute canonical");
  // Rendered as a guest, who edits nothing.
  assert(!page.html.includes("edit-link\" href"), "an editor's link reached a public document");
  assertEquals((await served(`/en/match/${WIN}`)).status, 200);
  assertEquals((await served("/jogo/missing-address")).status, 404);
});

test("door: a game's document follows its result", async () => {
  const score = async () => /data-text="\{home_score\}">([^<]*)</.exec((await served(`/jogo/${DRAW}`)).html)?.[1];
  assertEquals(await score(), "0");
  await query(`UPDATE game SET home_score = 5 WHERE id = '${DRAW}'`);
  try {
    let seen: string | undefined;
    for (const until = Date.now() + STREAM_MS; Date.now() < until && seen !== "5"; await new Promise((r) => setTimeout(r, 500))) {
      seen = await score();
    }
    assertEquals(seen, "5");
  } finally {
    await query(`UPDATE game SET home_score = 0 WHERE id = '${DRAW}'`);
  }
});

test("door: the app takes over the document it was served, keeping its nodes and the reader's focus", async () => {
  const page = await (await context()).newPage();
  // The reader, between the paint and the shell: on the served heading, and
  // focused on a link of the served screen.
  await page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () => {
      const w = window as unknown as { servedHeading: Element | null };
      w.servedHeading = document.querySelector("[data-served] h1");
      document.querySelector<HTMLElement>("[data-served] .wordmark")?.focus();
    })
  );
  await visit(page, `/jogo/${WIN}`);
  assert(await page.evaluate(() => (window as unknown as { servedHeading: Element | null }).servedHeading === document.querySelector("#app h1")), "the served heading was drawn again");
  assert(await page.evaluate(() => document.activeElement?.classList.contains("wordmark")), "the reader's focus was lost");
  assertEquals(await page.$$eval("#app > .shell-screen", (els: Element[]) => els.length), 1);
  assertEquals(await page.$$eval("body > nav", (els: Element[]) => els.length), 1);
});

test("door: the reader's place in the served strip survives the app taking over", async () => {
  // The strip was drawn again over the served one, so a keyboard reader who
  // had tabbed into it while the modules loaded was dropped to the body.
  const page = await (await context()).newPage();
  await page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () => {
      const w = window as unknown as { servedLink: HTMLElement | null };
      w.servedLink = document.querySelector<HTMLElement>("body > nav a:nth-of-type(2)");
      w.servedLink?.focus();
    })
  );
  await visit(page, "/jogos");
  assert(await page.evaluate(() => {
    const link = (window as unknown as { servedLink: HTMLElement | null }).servedLink;
    return link !== null && link.isConnected && document.activeElement === link;
  }), "the reader's link in the strip was drawn again");
});

test("door: a page the worker kept stays the page in a tab opened offline", async () => {
  // A new tab holds no session, and the guest mint offline threw into the
  // boot's banner, which replaced the document the worker had painted.
  const c = await context();
  const page = await c.newPage();
  await visit(page, "/jogos");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
  await visit(page, "/jogos");
  await c.setOffline(true);
  const offline = await c.newPage();
  await offline.goto(`${base}/jogos`);
  await offline.waitForSelector("#app .shell-screen .screen", { timeout: 30_000 });
  await offline.waitForTimeout(3_000);
  assertEquals(await offline.$$eval("#app pre", (els: Element[]) => els.map((e) => e.textContent)), []);
  assert((await offline.$$eval("#app .games li[data-id]", (els: Element[]) => els.length)) > 0, "the kept rows are gone");
  await c.setOffline(false);
});

globalThis.addEventListener("unload", () => browser.close());
