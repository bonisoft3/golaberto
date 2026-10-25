import { pathToFileURL } from "node:url";

// mecha's browser tier, at the release mise installs, with the bare
// specifiers its cluster config maps: its sources import them unqualified,
// so they load from its tree and not by URL.
const args = Deno.args;
if (args.length === 0) throw new Error("deno test arguments are required");

const located = await new Deno.Command("mise", {
  args: ["where", "github:bonisoft3/mecha"],
}).output();
if (!located.success) {
  await Deno.stderr.write(located.stderr);
  throw new Error("mise could not locate mecha");
}
const root = new TextDecoder().decode(located.stdout).trim();
if (root === "") throw new Error("mise returned an empty mecha root");

const config = JSON.parse(
  await Deno.readTextFile(`${root}/packages/mecha-browser/cluster.deno.json`),
) as { imports: Record<string, string> };
const imports: Record<string, string> = {};
for (const [specifier, target] of Object.entries(config.imports)) {
  if (!target.startsWith(".")) imports[specifier] = target;
}
imports["mecha/"] = pathToFileURL(`${root}/`).href;

const importMap = await Deno.makeTempFile({ prefix: "golaberto-mecha-", suffix: ".json" });
let code: number;
try {
  await Deno.writeTextFile(importMap, JSON.stringify({ imports }));
  const result = await new Deno.Command("mise", {
    args: ["exec", "--", "deno", "test", "--import-map", importMap, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  code = result.code;
} finally {
  await Deno.remove(importMap);
}
if (code !== 0) Deno.exit(code);
