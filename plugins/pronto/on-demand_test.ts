import { assertEquals } from "jsr:@std/assert@1.0.11";

async function evaluate(source: string, expression: string) {
  const child = new Deno.Command("cue", {
    args: ["export", "-", "-e", "result", "--out", "json"],
    cwd: new URL(".", import.meta.url), stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source + "\nresult: " + expression + "\n"));
  await writer.close();
  return await child.output();
}

Deno.test("shell emits only opted-in public archive tables in its read registry", async () => {
  const source = await Deno.readTextFile(new URL("testdata/emit/optional.cue", import.meta.url));
  const code = source.replace('durability: "server"', 'durability: "server"\n onDemand: true\n access: scope: "public"');
  const result = await evaluate(code, '(pronto.#shellConfig & {code: _code, migrations: []}).out.onDemand');
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), ["profile"]);
  const eager = await evaluate(source, '(pronto.#shellConfig & {code: _code, migrations: []}).out.onDemand');
  assertEquals(eager.success, false);
  assertEquals(new TextDecoder().decode(eager.stderr).includes('undefined field'), true);
});

Deno.test("on-demand delivery rejects local and private entities", async () => {
  for (const entity of [
    'durability: "tab", onDemand: true',
    'durability: "server", onDemand: true, access: scope: "private"',
  ]) {
    const result = await evaluate(`package test\nimport pronto "bonisoft.org/plugins/pronto"\nentity: pronto.#Entity & {name: "Archive", table: "archive", ${entity}, fields: [{name: "id", type: "uuid", pk: true}]}`, "entity");
    assertEquals(result.success, false, entity);
  }
});
