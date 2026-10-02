/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";
import type { Locator } from "npm:playwright@1.59.1";
const { chromium } = await import("npm:playwright@1.59.1");
const base = await baseUrl(".");

async function loaded(images: Locator, count: number) {
  try { await images.first().waitFor({ state: "visible", timeout: 30000 }); }
  catch (error) {
    throw new Error(String(error) + "\nRoute: " + images.page().url() + "\n" + (await images.page().locator("body").innerText()).slice(0, 1500));
  }
  assertEquals(await images.count(), count);
  for (const img of await images.all()) {
    await img.scrollIntoViewIfNeeded();
    await img.evaluate((element: HTMLImageElement) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Image timed out: " + element.src)), 15000);
      const check = () => { clearTimeout(timeout); element.naturalWidth > 0 ? resolve() : reject(new Error("Image failed: " + element.src)); };
      if (element.complete) check();
      else { element.addEventListener("load", check, { once: true }); element.addEventListener("error", check, { once: true }); }
    }));
    assertEquals(await img.getAttribute("alt"), "", "decorative images do not duplicate names");
  }
}

Deno.test("archive images load across lists, standings, directories and team headers on desktop and mobile", async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [1366, 390]) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "pt-BR", viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      console.log("image viewport", width);
      await page.goto(base);
      const first = page.locator(".home-games .game-row").first();
      await loaded(first.locator(".archive-icon img"), 2);
      for (const side of ["home", "away"]) {
        const label = first.locator(`.${side} > span[data-text]:not(.archive-icon)`);
        assert((await label.innerText()).trim().length > 0 && await label.isVisible(), "both team names stay visible");
      }
      const championshipFlag = page.locator(".home-championship h3 .archive-icon img").first();
      await loaded(championshipFlag, 1);
      const championshipUrl = await page.locator(".home-championship h3 a").first().getAttribute("href");
      assert(championshipUrl, "championship link survives");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "icons cause no horizontal overflow");
      console.log("championship images");
      await page.goto(new URL(championshipUrl, base).href);
      await loaded(page.locator("h1.band .archive-icon img"), 1);
      await loaded(page.locator("table.standings td.name .archive-icon img").first(), 1);

      console.log("directory images");
      await page.goto(new URL("/equipes", base).href);
      const row = page.locator(".catalog-table tbody tr").first();
      await loaded(row.locator("td a .archive-icon img"), 1);
      if (width > 600) await loaded(row.locator("td [data-text-format=country-flag] img"), 1);
      const teamUrl = await row.locator("td a").getAttribute("href");
      assert(teamUrl, "team link survives");
      console.log("team images", teamUrl);
      await row.locator("td a").click();
      await page.waitForURL(new URL(teamUrl, base).href);
      await loaded(page.locator("article.team .band .archive-icon img"), 1);
      await loaded(page.locator(".game-facts [data-text-format=country-flag] img"), 1);

      console.log("match list images");
      await page.goto(new URL("/jogos", base).href);
      await loaded(page.locator(".game-row").first().locator(".archive-icon img"), 2);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "match icons cause no horizontal overflow");

      // A CDN outage must leave both team names readable and the row navigable.
      console.log("CDN outage");
      let blockedImages = 0;
      await page.route("https://d24oxbyqb2c11t.cloudfront.net/**", route => { blockedImages++; return route.abort(); });
      await page.goto(base);
      const failedRow = page.locator(".home-games .game-row").first();
      await failedRow.waitFor({ state: "visible" });
      const failedImage = failedRow.locator(".archive-icon img").first();
      await failedImage.scrollIntoViewIfNeeded();
      await failedImage.evaluate((element: HTMLImageElement) => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Failed image did not settle")), 15000);
        const settled = () => { clearTimeout(timeout); resolve(); };
        if (element.complete) settled();
        else { element.addEventListener("load", settled, { once: true }); element.addEventListener("error", settled, { once: true }); }
      }));
      assert(blockedImages > 0, "the outage actually intercepts CDN requests");
      assert(await failedImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 0), "a rendered badge actually failed");
      for (const side of ["home", "away"]) {
        const label = failedRow.locator(`.${side} > span[data-text]:not(.archive-icon)`);
        const name = (await label.innerText()).trim();
        assert(name.length > 0 && await label.isVisible(), "failed images preserve each visible team name");
        assert((await failedRow.ariaSnapshot()).includes(name), "accessible match label retains the exact team name");
      }
      assert(await failedRow.getAttribute("href"), "failed images preserve match navigation");
      assertEquals(errors, []);
      await ctx.close();
    }
  } finally { await browser.close(); }
});
