import { pathToFileURL } from "node:url";

const [dependency, ...args] = Deno.args;
if (dependency !== "omnishell" && dependency !== "mecha") {
  throw new Error("dependency must be omnishell or mecha");
}
if (args.length === 0) throw new Error("deno test arguments are required");

const located = await new Deno.Command("mise", {
  args: ["where", `github:bonisoft3/${dependency}`],
}).output();
if (!located.success) {
  await Deno.stderr.write(located.stderr);
  throw new Error(`mise could not locate ${dependency}`);
}
const root = new TextDecoder().decode(located.stdout).trim();
if (root === "") throw new Error(`mise returned an empty ${dependency} root`);

const imports: Record<string, string> = {};
if (dependency === "mecha") {
  const config = JSON.parse(
    await Deno.readTextFile(
      `${root}/packages/mecha-browser/cluster.deno.json`,
    ),
  ) as { imports: Record<string, string> };
  for (const [specifier, target] of Object.entries(config.imports)) {
    if (!target.startsWith(".")) imports[specifier] = target;
  }
}
imports[`${dependency}/`] = pathToFileURL(`${root}/`).href;

const importMap = await Deno.makeTempFile({
  prefix: `golaberto-${dependency}-`,
  suffix: ".json",
});
let code: number;
try {
  await Deno.writeTextFile(importMap, JSON.stringify({ imports }));
  const result = await new Deno.Command("mise", {
    args: [
      "exec",
      "--",
      "deno",
      "test",
      "--import-map",
      importMap,
      ...args,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  code = result.code;
} finally {
  await Deno.remove(importMap);
}
if (code !== 0) Deno.exit(code);
