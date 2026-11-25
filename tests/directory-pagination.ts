/// <reference lib="dom" />
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { chromium } from "@playwright/test";

Deno.test("directory pagination derives its next page from the bounded rows on display", async () => {
  const root = new URL("../", import.meta.url);
  const html = await Deno.readTextFile(new URL("shell/screens/jogadores.html", root));
  const styles = await Promise.all(["shell/shared/chrome.css", "shell/screens/jogadores.css"].map(
    (file) => Deno.readTextFile(new URL(file, root)),
  ));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${styles.join("\n").replaceAll(/@import[^;]+;/g, "")}</style>${html}`);
    await page.locator("#players-directory-next").evaluate((button) => button.textContent = "Next page");
    const source = page.locator('tbody[data-live="player_directory"]');
    assertEquals(await page.locator('[data-live="player_directory"]').count(), 1);
    assertEquals(new URLSearchParams((await source.getAttribute("data-filter"))!).get("limit"), "41");
    const row = await source.locator("template").first().evaluate(
      (template) => (template as HTMLTemplateElement).content.firstElementChild!.outerHTML,
    );
    for (const count of [0, 1, 40, 41, 1, 41, 0]) {
      await source.evaluate((tbody, { row, count }) => {
        const template = document.createElement("template");
        template.innerHTML = row;
        const templates = [...tbody.children].filter((child) => child.tagName === "TEMPLATE");
        tbody.replaceChildren(...templates, ...Array.from({ length: count }, (_, index) => {
          const row = template.content.firstElementChild!.cloneNode(true) as Element;
          row.querySelector("td")!.textContent = `Player ${index + 1}`;
          return row;
        }));
      }, { row, count });
      assertEquals(await source.locator("tr:visible").count(), Math.min(count, 40));
      assertEquals(await page.locator("#players-directory-next").isVisible(), count === 41);
    }
  } finally {
    await browser.close();
  }
});
