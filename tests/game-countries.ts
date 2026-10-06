/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";
import type { Page } from "npm:playwright@1.59.1";
const { chromium } = await import("npm:playwright@1.59.1");
const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
if (project === "golaberto" || !/check|test|prs/.test(project)) throw new Error("Game country mutations require a disposable check/test project");
const base = await baseUrl(".");
async function sql(query: string) {
  const result = await new Deno.Command("docker", { args: ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", query] }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
async function settled(query: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await sql(query) === "t") return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Country CDC propagation timed out: " + query);
}
async function redis(...args: string[]) {
  const result = await new Deno.Command("docker", { args: ["compose", "-p", project, "exec", "-T", "golaberto-redis", "redis-cli", "--json", ...args] }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
// Wait for the real WAL event to be acknowledged, not merely for the joined
// UI to change. This prevents a late card rewrite from escaping the assertion.
async function consumed(table: string, id: string, txid: string) {
  const deadline = Date.now() + 45000;
  const group = "golaberto-game-cards";
  while (Date.now() < deadline) {
    const events = await redis("XREVRANGE", "cdc-events", "+", "-", "COUNT", "1000") as [string, string[]][];
    let eventId: string | undefined;
    for (const [key, fields] of events) {
      const body = fields[fields.indexOf("data") + 1];
      if (!body) continue;
      let row = JSON.parse(body);
      while (row?.data !== undefined && !row.__table) row = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      if (row?.__table === table && row.id === id && String(row.txid) === txid) {
        assert(JSON.parse(row.__before).name, "CDC carries the previous name for routing");
        eventId = key;
        break;
      }
    }
    if (eventId) {
      const groups = await redis("XINFO", "GROUPS", "cdc-events") as Record<string, unknown>[];
      const info = groups.find(g => g.name === group);
      const parts = (key: string) => key.split("-").map(BigInt);
      const delivered = parts(String(info?.["last-delivered-id"] ?? "0-0"));
      const expected = parts(eventId);
      const passed = delivered[0] > expected[0] || (delivered[0] === expected[0] && delivered[1] >= expected[1]);
      if (passed && (await redis("XPENDING", "cdc-events", group, eventId, eventId, "1")).length === 0) return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Game-card consumer did not acknowledge ${table}/${id}/${txid}`);
}
async function gameVersions() {
  return await sql(`SELECT jsonb_object_agg(name, versions) FROM (
    ${["game", "game_card", "team_game", "home_game_card", "matches_game_card"].map(table =>
      `SELECT '${table}' AS name, md5(string_agg(id::text || ':' || txid::text || ':' || ctid::text, ',' ORDER BY id)) AS versions FROM ${table}`
    ).join(" UNION ALL ")}) snapshots`);
}
async function alignment(page: Page) {
  const result = await page.locator(".home-games .game-row").evaluateAll(rows => {
    const rails = rows.map(row => ["home", "away"].map(side => {
      const rect = row.querySelector(`.${side} .team-badge`)!.getBoundingClientRect();
      return { x: rect.x, width: rect.width, height: rect.height };
    }));
    return { rails, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert(result.rails.length > 1, "alignment compares several team names");
  for (const side of [0, 1]) {
    const xs = result.rails.map(row => row[side].x);
    assert(Math.max(...xs) - Math.min(...xs) < 1, "badges remain in one column despite name lengths and championship flags");
    for (const row of result.rails) { assertEquals(row[side].width, 15); assertEquals(row[side].height, 15); }
  }
  assert(!result.overflow, "full names and fixed icons fit the viewport");
}
Deno.test("live country joins update open screens without rewriting games; badges align on phones", async () => {
  const fixture = JSON.parse(await sql(`SELECT row_to_json(f) FROM (
    SELECT g.id, g.championship_id, g.home_id, g.away_id, c.show_country, a.country, h.name
    FROM home_game_card g JOIN championship c ON c.id=g.championship_id
    JOIN team a ON a.id=g.away_id JOIN team h ON h.id=g.home_id
    ORDER BY g.home_upcoming_rank DESC, g.id LIMIT 1) f`));
  const { id, championship_id: championship, away_id: away } = fixture;
  const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  try {
    await sql(`UPDATE championship SET show_country=false WHERE id='${championship}'`);
    await settled("SELECT (SELECT count(*) FROM game_card)=(SELECT count(*) FROM game) AND (SELECT count(*) FROM team_game)=2*(SELECT count(*) FROM game)");
    await sql(`UPDATE game_card SET home_name='Very Long Home Team Name For Wrapped Match Lists' WHERE id='${id}'`);
    for (const width of [1366, 390]) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: "pt-BR" });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(base);
      const row = page.locator(`.home-games .game-row[href$='${id}']`);
      await row.waitFor({ state: "visible" });
      await page.locator(`.home-games .game-row[href$='${id}'][data-show-country='false']`).waitFor({ state: "visible" });
      await row.locator(".team-flag img").first().waitFor({ state: "detached" });
      assertEquals(await row.locator(".team-flag img").count(), 0);
      await alignment(page);
      const before = await gameVersions();
      const champTxid = await sql(`UPDATE championship SET show_country=true WHERE id='${championship}' RETURNING txid`);
      const teamTxid = await sql(`UPDATE team SET country='Argentina' WHERE id='${away}' RETURNING txid`);
      await consumed("championship", championship, champTxid);
      await consumed("team", away, teamTxid);
      assertEquals(await gameVersions(), before, "flag and country edits write zero games/cards/opponent lines across all feeds");
      // The open page must react through its joins, without navigation/reload.
      await row.locator(".away .team-flag img").waitFor({ state: "visible" });
      assertEquals(await row.locator(".team-flag img").count(), 2);
      assert((await row.locator(".away .team-flag img").getAttribute("src"))!.endsWith("/argentina_15.png"), "the team's country determines the flag");
      // Isolate the country notification from the championship notification.
      const countryBefore = await gameVersions();
      const countryTxid = await sql(`UPDATE team SET country='Brazil' WHERE id='${away}' RETURNING txid`);
      await consumed("team", away, countryTxid);
      await row.locator('.away .team-flag img[src$="/brazil_15.png"]').waitFor({ state: "visible" });
      assertEquals(await gameVersions(), countryBefore, "a country-only edit refreshes the open join without game writes");
      await alignment(page);
      for (const image of await row.locator(".team-icons img").all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((img: HTMLImageElement) => new Promise<void>((resolve, reject) => {
          const check = () => img.naturalWidth ? resolve() : reject(new Error("Flag/badge failed: " + img.src));
          if (img.complete) check(); else { img.addEventListener("load", check, { once: true }); img.addEventListener("error", check, { once: true }); }
        }));
      }
      await page.waitForFunction(() => { const node = document.querySelector(".shell-screen"); return node && getComputedStyle(node).opacity === "1"; });
      await page.screenshot({ path: `/private/tmp/golaberto-country-flags-${width}.png`, fullPage: true });
      await page.goto(new URL(`/jogo/${id}`, base).href);
      await page.locator(".scoreboard .team-flag img").first().waitFor({ state: "visible" });
      assertEquals(await page.locator(".scoreboard .team-flag img").count(), 2);
      const detailBefore = await gameVersions();
      const disableTxid = await sql(`UPDATE championship SET show_country=false WHERE id='${championship}' RETURNING txid`);
      await consumed("championship", championship, disableTxid);
      assertEquals(await gameVersions(), detailBefore, "disabling flags writes only the championship");
      await page.locator(".scoreboard .team-badge img").first().waitFor({ state: "visible" });
      await page.locator(".scoreboard[data-show-country='false']").waitFor({ state: "visible" });
      await page.locator(".scoreboard .team-flag img").first().waitFor({ state: "detached" });
      assertEquals(await page.locator(".scoreboard .team-flag img").count(), 0);
      assertEquals(errors, []);
      await ctx.close();
    }
  } finally {
    await browser.close();
    // Test data only; quotes are escaped because names can contain apostrophes.
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    await sql(`UPDATE championship SET show_country=${fixture.show_country} WHERE id='${championship}'; UPDATE team SET country=${literal(fixture.country)} WHERE id='${away}'; UPDATE game_card SET home_name=${literal(fixture.name)} WHERE id='${id}'`);
  }
});
