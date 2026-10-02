/// <reference lib="dom" />
// The acceptance driver: the ir's screen invariants walked against the running
// archive in a real browser, with the cluster up. Declared in program.cue as an
// integrate check. Each case names the test pair it realizes.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const { chromium } = await import("npm:playwright@1.59.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(Deno.args[0] ?? ".");
const browser = await chromium.launch();

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
  await psql(`INSERT INTO app_user (id, handle) VALUES ('${id}', '${handle}')`);
  const secret = new TextEncoder().encode(Deno.env.get("PGRST_JWT_SECRET") ?? "mecha-dev-secret-please-override-32ch");
  const token = await new SignJWT({ role: "app_user", handle, guest: false }).setProtectedHeader({ alg: "HS256" }).setSubject(id)
    .setExpirationTime("1h").sign(secret);
  return { token, user: { id, handle } };
};

const context = async (opts: { width?: number; dark?: boolean; session?: unknown } = {}) => {
  const c = await browser.newContext({
    ignoreHTTPSErrors: true,
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

const visit = async (page: Page, path: string, ready = '.shell-screen:not([hidden]) .screen[data-state="populated"]') => {
  await page.goto(`${base}${path}`);
  await page.waitForSelector(ready, { timeout: 30_000 });
  return page;
};

const open = async (path: string, opts: { width?: number; dark?: boolean; session?: unknown } = {}) =>
  visit(await (await context(opts)).newPage(), path);

test("homepage opens only the bounded home-card shape", async () => {
  const page = await (await context()).newPage();
  const cards = Number(await psql("SELECT count(*) FROM home_game_card"));
  const shapeTables = new Set<string>();
  page.on("request", (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/electric/v1/shape")) {
      const table = url.searchParams.get("table");
      if (table) shapeTables.add(table);
    }
  });
  const started = performance.now();
  await visit(page, "/");
  await page.waitForFunction(() => document.querySelector(".home-championships")?.getAttribute("data-live") === "home_game_card");
  await page.waitForFunction((expected: number) => document.querySelectorAll(".home-games .game-row").length === expected, cards);
  const dataMs = Math.round(performance.now() - started);
  await page.waitForFunction(() => {
    const screen = document.querySelector(".shell-screen:not([hidden])");
    return screen && !screen.hasAttribute("data-entering") && Number(getComputedStyle(screen).opacity) >= 0.99;
  });
  assert(shapeTables.has("home_game_card"), "the home-card shape must be requested");
  assert(!shapeTables.has("game_card"), "homepage must not request the archive game-card shape");
  assert(cards <= 40, "homepage sync is capped at forty cards");
  console.log(`Fresh homepage: ${cards} games ready in ${dataMs} ms, visible in ${Math.round(performance.now() - started)} ms; shapes: ${[...shapeTables].join(", ")}`);
  const capture = Deno.env.get("GOLABERTO_HOME_CAPTURE");
  if (capture) await page.screenshot({ path: capture, fullPage: true });
});

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

const psql = async (sql: string): Promise<string> => {
  const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
  const { success, stdout, stderr } = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
  }).output();
  assert(success, new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).trim();
};

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
  await page.goto(`${base}${route}/00000000-0000-4000-8000-000000000000`);
  await page.waitForFunction((words: string) =>
    (document.querySelector(".shell-screen:not([hidden]) .screen")?.textContent ?? "").includes(words), words);
};

const championship = async (id: string) => {
  const page = await open(`/campeonato/${id}`);
  await page.waitForSelector(".championship .phases");
  return page;
};

test("test-home-featured: the front page keeps the featured season and its top six below the game feeds", async () => {
  const page = await open("/");
  await page.waitForSelector(".feature .standings tbody tr", { timeout: 30_000 });
  const top = await said(page, ".feature .standings tbody .name");
  assertEquals(top.length, 6);
  assertEquals(top[0], "Flamengo-RJ");
  assert(await page.locator(".home-games + .feature").count(), "game feeds precede the featured table");
  // The title chance arrives once the chances computation has run over the lake.
  await page.waitForSelector(".feature .standings tbody tr:first-child .title-chance", { timeout: STREAM_MS });
});

test("test-home-games: fixtures and results lead the page, retain competition and open game details", async () => {
  const upcoming = await psql("SELECT id FROM game WHERE NOT played ORDER BY id LIMIT 1");
  const saved = JSON.parse(await psql(`SELECT json_agg(json_build_object('id', id, 'day', day, 'kickoff', kickoff)) FROM game WHERE id IN ('${upcoming}', '${WIN}')`));
  try {
    await psql(`UPDATE game SET kickoff = now() + interval '2 hours', day = (now() + interval '2 hours')::date WHERE id = '${upcoming}'; UPDATE game SET kickoff = now() - interval '2 hours', day = (now() - interval '2 hours')::date WHERE id = '${WIN}'`);
    // Wait for the existing card stream, then select with the server clock.
    for (let attempt = 0; ; attempt++) {
      const ready = await psql(`SELECT count(*) FROM game g JOIN game_card c USING (id) WHERE g.id IN ('${upcoming}', '${WIN}') AND g.kickoff = c.kickoff`);
      if (ready === "2") break;
      assert(attempt < 90, "the stream did not refresh the two home fixtures");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const page = await open("/", { width: 390 });
    await page.waitForSelector(`.home-upcoming a[href$="/${upcoming}"]`, { timeout: STREAM_MS });
    await page.waitForSelector(`.home-results a[href$="/${WIN}"]`, { timeout: STREAM_MS });
    const groups: Array<{ id: string | null; heading: string }> = await page.locator(".home-upcoming .home-championship").evaluateAll((groups: Element[]) => groups.map((group) => ({
      id: group.getAttribute("data-championship"), heading: group.querySelector("h3 a")?.textContent?.trim() ?? "",
    })));
    assert(groups.length > 0 && groups.every((group) => group.heading), "each championship has a named heading");
    assertEquals(new Set(groups.map((group) => group.id)).size, groups.length, "championships are not repeated");
    const grouped = await page.evaluate(() => Array.from(document.querySelectorAll(".home-games .home-championship")).every((group) => {
      const id = group.getAttribute("data-championship");
      return group.querySelector("h3 a")?.getAttribute("href")?.endsWith(`/${id}`) &&
        Array.from(group.querySelectorAll(".games li:not(.empty)")).every((row) => !row.querySelector(".where"));
    }));
    assert(grouped, "championship headings link correctly and match rows omit repeated competition labels");
    const ownership: Array<{ id: string | undefined; championship: string | null }> = await page.evaluate(() => Array.from(document.querySelectorAll(".home-games .home-championship")).flatMap((group) =>
      Array.from(group.querySelectorAll(".game-row")).map((row) => ({
        id: row.getAttribute("href")?.split("/").pop(), championship: group.getAttribute("data-championship"),
      }))));
    assert(ownership.length > 0, "grouped game rows are populated");
    const cardOwners = JSON.parse(await psql(`SELECT json_object_agg(id, championship_id) FROM game_card WHERE id IN (${ownership.map((row) => `'${row.id}'`).join(",")})`));
    assert(ownership.every((row) => cardOwners[row.id!] === row.championship), "each game belongs to its displayed championship");
    assertEquals(await page.locator(".home-games-note, .content > .lead").count(), 0);
    assert((await texts(page, ".home-results .score b")).every(Boolean), "played games show both scores");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "home fits a phone");
    await page.click(`.home-results a[href$="/${WIN}"]`);
    await page.waitForSelector(".scoreboard");
    assert((await said(page, ".scoreboard")).join(" ").includes("Athletico-PR"));
  } finally {
    for (const row of saved) {
      await psql(`UPDATE game SET day = '${row.day}', kickoff = ${row.kickoff ? `'${row.kickoff}'` : "NULL"} WHERE id = '${row.id}'`);
    }
    for (let attempt = 0; ; attempt++) {
      if (await psql(`SELECT count(*) FROM game g JOIN game_card c USING (id) WHERE g.id IN ('${upcoming}', '${WIN}') AND g.kickoff IS NOT DISTINCT FROM c.kickoff`) === "2") break;
      assert(attempt < 90, "the stream did not restore the home fixtures");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
});

// These cases deliberately leave refresh_home_games to the running clock stream.
test("test-home-games: a fixture expires without another write or a manual refresh", async () => {
  const id = await psql("SELECT id FROM game_card WHERE NOT played ORDER BY home_upcoming_rank > 0 DESC, id LIMIT 1");
  const saved = await psql(`SELECT kickoff::text FROM game_card WHERE id = '${id}'`);
  try {
    await psql(`UPDATE game_card SET kickoff = now() + interval '70 seconds' WHERE id = '${id}'`);
    const page = await open("/");
    const link = `.home-upcoming a[href$="/${id}"]`;
    await page.waitForSelector(link, { timeout: 45_000 });
    await page.waitForSelector(link, { state: "detached", timeout: 115_000 });
    assertEquals(await psql(`SELECT home_upcoming_rank FROM game_card WHERE id = '${id}'`), "0");
  } finally {
    await psql(`UPDATE game_card SET kickoff = ${saved ? `'${saved}'` : "NULL"} WHERE id = '${id}'`);
  }
});

test("test-home-games: empty windows remove stale rows and explain both feeds", async () => {
  // A disposable integration stack; preserve all times while exercising an empty archive window.
  await psql("CREATE TABLE home_games_acceptance_backup AS SELECT id, kickoff FROM game_card");
  try {
    await psql("UPDATE game_card SET kickoff = NULL WHERE kickoff IS NOT NULL");
    const page = await open("/", { width: 390 });
    await page.waitForFunction(() => {
      const upcoming = document.querySelector(".home-upcoming .home-championships");
      const recent = document.querySelector(".home-results .home-championships");
      return upcoming?.textContent?.includes("Nenhum jogo com horário marcado nos próximos sete dias.") &&
        recent?.textContent?.includes("Nenhum resultado com horário registrado nos últimos sete dias.") &&
        !document.querySelector(".home-games .games li:not(.empty)");
    }, undefined, { timeout: 45_000 });
    assertEquals(await page.locator(".home-games .games li:not(.empty)").count(), 0);
    await page.waitForSelector(".feature .standings tbody tr", { timeout: 30_000 });
    assert(await page.locator(".feature .standings tbody tr").count(), "the archive is still available");
  } finally {
    await psql("UPDATE game_card g SET kickoff = b.kickoff FROM home_games_acceptance_backup b WHERE g.id = b.id; DROP TABLE home_games_acceptance_backup");
  }
});

test("test-home-levels: each level's most recent championships first", async () => {
  const page = await open("/");
  const [world, continental, national] = await Promise.all(
    [0, 1, 2].map((i) => texts(page, `.recent:nth-of-type(${i + 1}) .champ-list li`)),
  );
  assertEquals(world[0], "Mundial - Copa do Mundo FIFA 2026");
  assertEquals(continental[0], "Europa - Champions League 2026/2027");
  assertEquals(national[0], "Alemanha - Bundesliga 2026/2027");
  assertEquals(national.length, 6);
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
    await psql(`UPDATE game SET home_score = 1 WHERE id = '${DRAW}'`);
    await awaitPoints(page, "Botafogo-RJ", before + 2);
  } finally {
    await psql(`UPDATE game SET home_score = 0 WHERE id = '${DRAW}'`);
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
  await page.waitForURL(`${base}/`);
  await page.goBack();
  await page.waitForSelector('.shell-screen:not([hidden]) .games-view[data-view="results"]');
});

test("test-game-page: a game's page shows its score, facts, goals and line-ups", async () => {
  const page = await open(`/jogo/${WIN}`);
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
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length > 40);
  await page.fill("#teams-q", "athletico");
  await page.waitForFunction(() => document.querySelectorAll(".catalog-table tbody tr").length === 1);
  assertEquals(await said(page, ".catalog-table tbody tr"), ["Athletico-PR Curitiba Brasil"]);
});

test("test-team-page: a team's page shows its facts, its games and its squad's seasons", async () => {
  const page = await open(`/equipe/${ATHLETICO}`);
  await page.waitForSelector(".squad-table tbody tr");
  assertEquals(await said(page, ".team h1.band"), ["Athletico-PR"]);
  assertEquals((await said(page, ".team .game-facts dd")).slice(0, 4), ["Club Athletico Paranaense", "Curitiba", "Brasil", "26/03/1924"]);
  await page.waitForFunction(() => document.querySelectorAll(".team-results .game-row").length === 10);
  // The latest result from Athletico's own side: at home, 2–1, a win.
  const latest = await page.$eval(".team-results .game-row", (a: Element) => [a.querySelector(".home")?.textContent?.replace(/\s+/g, " ").trim(), a.getAttribute("data-result")]);
  assertEquals(latest, ["Casa Bahia-BA", "w"]);
  await page.waitForFunction(() => document.querySelectorAll(".squad-table tbody tr").length > 11);
  const viveros = await page.$$eval(".squad-table tbody tr", (rows: Element[]) =>
    rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent?.trim()).slice(1)).find((cells) => cells[0] === "K. Viveros"));
  assertEquals(viveros, ["K. Viveros", "fw", "26", "26", "0", "2286", "18", "6", "0"]);
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
    await psql(`INSERT INTO goal (id, game_id, player_id, side, minute) VALUES ('0e000000-0000-4000-8000-0000000fffff', '${WIN}', '${VIVEROS}', 'home', 90)`);
    await season(page, GOALS, "19");
  } finally {
    await psql(`DELETE FROM goal WHERE id = '0e000000-0000-4000-8000-0000000fffff'`);
  }
  await season(page, GOALS, "18");
});

test("test-appearance-live: an appearance removed after the fact moves the season with no reload", async () => {
  const page = await open(`/jogador/${VIVEROS}`);
  const played = (n: string) => season(page, PLAYED, n);
  await played("26");
  const cols = "id, game_id, player_id, side, on_minute, off_minute, yellow, red, bench";
  // His latest appearance, whichever game it was.
  await psql(`CREATE TABLE kept_appearance AS SELECT ${cols} FROM player_game WHERE player_id = '${VIVEROS}' ORDER BY day DESC LIMIT 1`);
  try {
    await psql(`DELETE FROM player_game WHERE id IN (SELECT id FROM kept_appearance)`);
    await played("25");
  } finally {
    await psql(`INSERT INTO player_game (${cols}) SELECT ${cols} FROM kept_appearance; DROP TABLE kept_appearance`);
  }
  await played("26");
});

test("test-team-gone: an address naming no team says so", () => gone("/equipe", "Esta equipe não existe ou foi removida."));

test("test-player-gone: an address naming no player says so", () => gone("/jogador", "Este jogador não existe ou foi removido."));

test("test-venue-home: a team's ground shows the team and the games played there", async () => {
  // São Paulo-SP's ground, which the 2006 pages call Morumbi and the archive
  // now calls Morumbis: one stadium.
  const team = await open("/equipe/07000000-0000-4000-8000-000000000011");
  await team.waitForSelector('.game-facts dd span');
  const ground = await said(team, ".game-facts dd span");
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
  await page.waitForURL(`**/arbitro/${ABADE}`);
});

test("test-venue-gone: an address naming no stadium, or no referee, says so", async () => {
  await gone("/estadio", "Este estádio não existe ou foi removido.");
  await gone("/arbitro", "Este árbitro não existe ou foi removido.");
});

// An account the archive has made an editor: the grant is given out of band,
// as an operator would.
const editor = async (handle: string) => {
  const reader = await signedIn(handle);
  await psql(`INSERT INTO editor (app_user_id) VALUES ('${reader.user.id}')`);
  return reader;
};
const forget = (reader: { user: { id: string } }) =>
  psql(`DELETE FROM comment WHERE app_user_id = '${reader.user.id}'; DELETE FROM app_user WHERE id = '${reader.user.id}'`);

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
  const before = await psql(`SELECT home_score || ',' || coalesce(attendance::text, 'NULL') FROM game WHERE id = '${WIN}'`);
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
    await psql(`UPDATE game SET home_score = ${score}, attendance = ${crowd} WHERE id = '${WIN}'`);
    await forget(ed);
  }
});

test("test-edit-goal: a goal an editor adds and then removes moves the game's goals and the scorer's season each time", async () => {
  const ed = await editor(`editor-${Date.now()}`);
  // A home starter of the game, whose season this championship's first row is.
  const player = await psql(`SELECT player_id FROM player_game WHERE game_id = '${WIN}' AND side = 'home' AND NOT bench ORDER BY on_minute, player_id LIMIT 1`);
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
    await psql(`DELETE FROM goal WHERE game_id = '${WIN}' AND minute = 90`);
    await forget(ed);
  }
});

const REFUSED = "Não foi possível salvar: só editores alteram jogos, um jogo realizado tem o placar dos dois lados, e um gol precisa de um jogador da escalação. O que você editou continua aqui.";

test("test-edit-refused: a non-editor's save and a goal with no scorer are refused with the reason, and the edits stay", async () => {
  const plain = await signedIn(`reader-${Date.now()}`);
  const ed = await editor(`editor-${Date.now()}`);
  const score = await psql(`SELECT home_score FROM game WHERE id = '${WIN}'`);
  try {
    const page = await open(`/editar/${WIN}`, { session: plain });
    await page.waitForSelector('.edit[data-state="editing"]');
    await page.fill("#edit-home", "7");
    await page.click("#edit-save");
    await page.waitForSelector('.edit[data-state="refused"]', { timeout: 30_000 });
    assertEquals(await said(page, ".edit .refusal"), [REFUSED]);
    assertEquals(await page.inputValue("#edit-home"), "7");
    assertEquals(await psql(`SELECT home_score FROM game WHERE id = '${WIN}'`), score);

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
  const positions: string[] = await page.$$eval(".heat .rows .row:first-child .heat-cell [data-text-format]", (els: Element[]) => els.map((e) => e.textContent ?? ""));
  const sum = positions.map(percent).reduce((a: number, b: number) => a + b, 0);
  assert(sum >= 99 && sum <= 101, `the leader's positions sum to ${sum}`);
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

test("test-chances-live: a result recorded for a game still to play moves the chances on a page left open, and undoing it brings them back", async () => {
  // Flamengo's next home game, lost heavily: the leader's title chance must fall.
  const game = await psql(`SELECT g.id FROM game g JOIN team t ON t.id = g.home_id JOIN stage_group sg ON sg.phase_id = g.phase_id WHERE sg.id = '${SERIE_A_2026}' AND t.name = 'Flamengo-RJ' AND NOT g.played ORDER BY g.day LIMIT 1`);
  const page = await open(`/chances/${SERIE_A_2026}`);
  await page.waitForSelector(".zone-odds .rows .row .pct", { timeout: STREAM_MS });
  const before = await titleOf(page);
  try {
    await psql(`UPDATE game SET played = true, home_score = 0, away_score = 5 WHERE id = '${game}'`);
    await page.waitForFunction((before: string) =>
      document.querySelector(".zone-odds .rows .row:first-child .pct")?.textContent !== before, before, { timeout: STREAM_MS });
    assert(percent(await titleOf(page)) < percent(before), "a heavy home defeat lowered the leader's title chance");
  } finally {
    await psql(`UPDATE game SET played = false, home_score = NULL, away_score = NULL WHERE id = '${game}'`);
  }
  // The same lake gives the same draw.
  await page.waitForFunction((before: string) =>
    document.querySelector(".zone-odds .rows .row:first-child .pct")?.textContent === before, before, { timeout: STREAM_MS });
});

test("test-team-rating: a team's page shows its latest rating, a number from 0 to 100", async () => {
  const page = await open(`/equipe/${ATHLETICO}`);
  // Refit by the ratings computation after the archive is published to the lake.
  await page.waitForSelector(".rating abbr", { timeout: STREAM_MS });
  const rating = percent(await page.$eval(".rating abbr", (e: Element) => e.textContent ?? ""));
  assert(rating >= 0 && rating <= 100, `Athletico's rating ${rating} is outside 0..100`);
});

test("test-game-importance: a game still to play shows how much its result matters to each side", async () => {
  const game = await psql(`SELECT g.id FROM game g JOIN stage_group sg ON sg.phase_id = g.phase_id WHERE sg.id = '${SERIE_A_2026}' AND NOT g.played ORDER BY g.day, g.id LIMIT 1`);
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
  await psql(`INSERT INTO comment (game_id, app_user_id, body, created_at) VALUES ('${WIN}', '${author.user.id}', '${earlier}', now() - interval '1 day')`);
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
    await psql(`DELETE FROM comment WHERE app_user_id = '${author.user.id}'; DELETE FROM app_user WHERE id = '${author.user.id}'`);
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
  await page.waitForURL(`**/en/championship/${BRASILEIRO_2026}`);
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
globalThis.addEventListener("unload", () => browser.close());
