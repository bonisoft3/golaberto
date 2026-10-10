import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { evaluateRole } from "omnishell/interpreter/jessie.js";
import { adaptBlobRequest } from "../services/media/blob-route.ts";
import { built } from "./terminal-nodes.ts";

const app = new URL("../", import.meta.url);
Deno.test("uploaded image renderers preserve size and legacy badge URLs without accepting arbitrary paths", async () => {
  const imageNodes = await evaluateRole(await Deno.readTextFile(new URL("shell/renderers/media-image.js", app)), "renderer");
  const badgeNodes = await evaluateRole(await Deno.readTextFile(new URL("shell/renderers/team-badge.js", app)), "renderer");
  const render = (value: string) => built(imageNodes(value));
  const badge = (value: string) => built(badgeNodes(value));
  const key = "00000000-0000-4000-8000-000000000001.png";
  assertEquals(render("").length, 0);
  assertEquals(render(key)[0].attrs.src, `/blobs/mecha-objects/${key}/medium.png`);
  assertEquals(render(key)[0].attrs.width, 100);
  assertEquals(render(`${key}|thumb`)[0].attrs.width, 15);
  assertThrows(() => render("../auth/guest"));
  assertEquals(badge("07000000-0000-4000-8000-000000000001|name")[0].attrs.src, "https://d24oxbyqb2c11t.cloudfront.net/teams/logos/17/thumb.png");
  assertEquals(badge(`07000000-0000-4000-8000-000000000001|name|${key}`)[0].attrs.src, `/blobs/mecha-objects/${key}/thumb.png`);
  assertThrows(() => badge("team|name|https://other.invalid/logo.png"));
});
Deno.test("the existing stripped blob upstream forwards the authenticated file and public variant path", async () => {
  const key = "00000000-0000-4000-8000-000000000001.png";
  const request = new Request(`http://rclone-s3:3900/mecha-objects/${key}`, { method: "PUT", headers: { authorization: "Bearer fixture", "content-type": "image/png" }, body: new Uint8Array([1,2,3]) });
  const adapted = adaptBlobRequest(request);
  assertEquals(new URL(adapted.url).pathname, `/blobs/mecha-objects/${key}`);
  assertEquals(adapted.headers.get("authorization"), "Bearer fixture");
  assertEquals(adapted.headers.get("content-type"), "image/png");
  assertEquals(new Uint8Array(await adapted.arrayBuffer()), new Uint8Array([1,2,3]));
  assertEquals(new URL(adaptBlobRequest(new Request(`http://rclone-s3:3900/mecha-objects/${key}/thumb.png`)).url).pathname, `/media/objects/${key}/thumb.png`);
});
