/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const { chromium } = await import("npm:playwright@1.59.1");
const base = await baseUrl(Deno.args[0] ?? ".");
const ATHLETICO = "07000000-0000-4000-8000-000000000003";
const BRASILEIRO_2026 = "02000000-0000-4000-8000-000000000001";

for (const width of [390, 1366]) {
  Deno.test(`Portuguese choice survives navigation and reload at ${width}px`, async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-GB", viewport: { width, height: 900 } });
      const page = await context.newPage();
      const portuguese = '.shell-screen:not([hidden]) .langs a[data-locale="pt-BR"]';
      const ready = '.shell-screen:not([hidden]) .screen[data-state="populated"]';
      const assertPortuguese = async () => {
        await page.waitForSelector(ready);
        await page.waitForFunction(() => document.documentElement.lang === "pt-BR");
        const url = new URL(page.url());
        assertEquals(url.searchParams.get("lang"), "pt-BR");
        assert(!/^\/(en|es|it|de|fr)(\/|$)/.test(url.pathname));
        assertEquals(await page.locator(portuguese).getAttribute("aria-current"), "page");
        const canonical = new URL(await page.locator('head link[rel="canonical"]').getAttribute("href") ?? "");
        assertEquals(canonical.pathname, url.pathname);
        assertEquals(canonical.search, "");
        const alternates = await page.locator('head link[rel="alternate"][hreflang]').evaluateAll((links) =>
          links.map((link) => ({ lang: link.getAttribute("hreflang"), href: link.getAttribute("href") ?? "" })));
        assertEquals(alternates.length, 7);
        for (const alternate of alternates) {
          assertEquals(new URL(alternate.href).search, "", `${alternate.lang} must keep its query-free address`);
          if (alternate.lang === "pt-BR" || alternate.lang === "x-default") assertEquals(alternate.href, canonical.href);
        }
      };

      await page.goto(`${base}/en`);
      await page.waitForSelector(ready);
      await page.click(portuguese);
      await page.waitForURL(`${base}/?lang=pt-BR`);
      await assertPortuguese();
      await page.reload();
      await assertPortuguese();

      await page.click('nav > a[data-route="campeonatos"]:not([data-locale])');
      await page.waitForURL(`${base}/campeonatos?lang=pt-BR`);
      await assertPortuguese();
      assertEquals(await page.locator('nav > a[data-route="campeonatos"]:not([data-locale])').getAttribute("aria-current"), "page");
      assertEquals(await page.locator('label[for="catalog-q"] > span').textContent(), "Nome");
      const championship = page.locator('.shell-screen:not([hidden]) a[data-route="campeonato"]').first();
      await championship.waitFor();
      const href = await championship.getAttribute("href");
      assert(href);
      await championship.click();
      await page.waitForURL(new URL(href, base).href);
      await assertPortuguese();
      const id = new URL(page.url()).pathname.split("/").pop();
      await page.click('.shell-screen:not([hidden]) .langs a[data-locale="en-GB"]');
      await page.waitForURL(`${base}/en/championship/${id}`);
      await page.waitForSelector(ready);
      await page.click(portuguese);
      await page.waitForURL(`${base}/campeonato/${id}?lang=pt-BR`);
      await assertPortuguese();
      await page.reload();
      await assertPortuguese();

      await page.goto(`${base}/en/team-championship/${ATHLETICO}/${BRASILEIRO_2026}`);
      await page.waitForSelector(ready);
      await page.click(portuguese);
      await page.waitForURL(`${base}/equipe-campeonato/${ATHLETICO}/${BRASILEIRO_2026}?lang=pt-BR`);
      await assertPortuguese();
      assertEquals(new URL(page.url()).pathname, `/equipe-campeonato/${ATHLETICO}/${BRASILEIRO_2026}`);
      await page.reload();
      await assertPortuguese();

      for (const [locale, prefix] of [["es-AR", "es"], ["it-IT", "it"], ["de-DE", "de"], ["fr-FR", "fr"]]) {
        await page.goto(`${base}/${prefix}`);
        await page.waitForSelector(ready);
        await page.waitForFunction((tag) => document.documentElement.lang === tag, locale);
        await page.click(portuguese);
        await page.waitForURL(`${base}/?lang=pt-BR`);
        await assertPortuguese();
      }
    } finally {
      await browser.close();
    }
  });
}
