// Auth fixtures use a temporary database inside the explicitly disposable stack.
import { assert, assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("electric-cache requires an explicit disposable check/test compose project");
}
const decoder = new TextDecoder();
async function docker(args: string[], input?: string) {
  const child = new Deno.Command("docker", {
    args, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  assert(result.success, decoder.decode(result.stderr) + decoder.decode(result.stdout));
  return decoder.decode(result.stdout).trim();
}
const compose = (...args: string[]) => docker(["compose", "-p", project, ...args]);

Deno.test("retained campaign upgrade is additive and public shape auth preserves private reach", async () => {
  const container = await compose("ps", "-q", "apps_golaberto-database");
  const [info] = JSON.parse(await docker(["inspect", container]));
  const network = Object.keys(info.NetworkSettings.Networks)[0];
  const config = JSON.parse(await compose("config", "--format", "json"));
  const [image] = JSON.parse(await docker(["image", "inspect", config.services["apps_golaberto-auth"].image]));
  const psql = (db: string, query: string) => docker([
    "exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt",
  ], query);
  const fingerprint = () => psql("golaberto", `SELECT count(*),
    md5(coalesce(string_agg(concat_ws('|',id,ctid,xmin,txid,sequence,day,points,position,result),',' ORDER BY id),''))
    FROM team_campaign_point;`);
  const before = await fingerprint();
  const migration = await Deno.readTextFile("services/database/sql/033_campaign_delta.sql");
  await psql("golaberto", migration);
  assertEquals(await fingerprint(), before, "retained upgrade must preserve physical projection rows");
  await psql("golaberto", migration);
  assertEquals(await fingerprint(), before, "migration replay must preserve rows");

  const clone = `electric_auth_check_${crypto.randomUUID().replaceAll("-", "")}`;
  await psql("postgres", `CREATE DATABASE ${clone};`);
  try {
    await psql(clone, await Deno.readTextFile("../../libraries/mecha/services/database/rls/rls.sql"));
    const authFiles = await Deno.realPath("../../libraries/mecha/services/auth");
    await docker([
      "run", "--rm", "--entrypoint", "deno",
      "--mount", `type=bind,src=${authFiles},dst=/verify,readonly`,
      image.Id, "check", "--config", "/verify/deno.json", "--no-lock", "/verify/main.ts",
    ]);
    const result = await docker([
      "run", "--rm", "--network", network, "--entrypoint", "deno",
      "--mount", `type=bind,src=${authFiles},dst=/verify,readonly`,
      "-e", `DATABASE_URL=postgres://postgres:postgres@${info.Name.slice(1)}:5432/${clone}?sslmode=disable`,
      "-e", "PGRST_JWT_SECRET=cache-regression-test-secret-at-least-32-chars",
      "-e", "WEBAUTHN_RP_ID=localhost", "-e", "WEBAUTHN_ORIGIN=https://localhost:*",
      image.Id, "test", "--no-check", "--config", "/verify/deno.json", "--lock", "/verify/deno.lock", "--frozen",
      "--allow-all", "/verify/main_test.ts", "/verify/shape_test.ts",
    ]);
    console.log(result);
  } finally {
    await psql("postgres", `DROP DATABASE ${clone} WITH (FORCE);`);
  }
});
