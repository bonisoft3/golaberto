/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { chromium } from "npm:playwright@1.59.1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const base = await baseUrl(".");

Deno.test("public favicon packaging, localized headers and Chromium decoding", async () => {
  for (const path of ["/", "/jogos", "/en/matches", "/es/partidos", "/it/partite", "/de/spiele", "/fr/matchs"]) {
    const response = await fetch(new URL(path, base));
    assertEquals(response.status, 200, path);
    const html = await response.text();
    assert(/rel="icon"[^>]*href="(\/shell\/|\.\/)favicon\.ico"/.test(html), `${path} names the icon URL`);
  }

  const icon = await fetch(new URL("/shell/favicon.ico", base));
  assertEquals(icon.status, 200, "the icon is readable without signing in");
  assert(/image\/(x-icon|vnd.microsoft.icon)/.test(icon.headers.get("content-type")!));
  const bytes = new Uint8Array(await icon.arrayBuffer());
  const header = new DataView(bytes.buffer);
  assertEquals(header.getUint16(2, true), 1, "ICO image directory");
  const count = header.getUint16(4, true);
  const sizes = Array.from({ length: count }, (_, i) => bytes[6 + 16 * i] || 256);
  for (const size of [16, 32, 48]) assert(sizes.includes(size), `a ${size}px rendition ships`);

  const vector = await fetch(new URL("/shell/favicon.svg", base));
  assertEquals(vector.status, 200);
  assert(vector.headers.get("content-type")!.startsWith("image/svg+xml"));
  await vector.body!.cancel();

  // Decode the actual public bytes independently of app startup and live data.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const decoded = await page.evaluate(async (data: number[]) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/vnd.microsoft.icon" }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
    }, Array.from(bytes));
    assert(decoded.width > 0 && decoded.width === decoded.height, "Chromium decodes the shipped icon");
  } finally {
    await browser.close();
  }
});
