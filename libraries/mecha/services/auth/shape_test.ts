// The verification endpoint needs no database. Sign its input directly so the
// authorization boundary is exercised without touching an application archive.
import assert from "node:assert/strict";
import { signJwt } from "./jwt.ts";

const secret = "shape-subset-test-secret-with-at-least-32-bytes";
Deno.env.set("DATABASE_URL", "postgres://unused:unused@127.0.0.1:1/unused");
Deno.env.set("PGRST_JWT_SECRET", secret);
Deno.env.set("WEBAUTHN_RP_ID", "localhost");
Deno.env.set("WEBAUTHN_ORIGIN", "https://localhost:8443");
const { handler, sql } = await import("./main.ts");
const where = "scope_id IN ('public:','user:subject')";
const token = await signJwt(secret, {
  typ: "shape", table: "article", where, sub: "subject", exp: Math.floor(Date.now() / 1000) + 60,
});

async function verify(extra: Record<string, string> = {}, suffix = "", method = "GET") {
  const params = new URLSearchParams({ table: "article", where, ...extra });
  return (await handler(new Request("http://auth/auth/shape/verify", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-method": method,
      "x-forwarded-uri": `/v1/shape?${params}${suffix}`,
    },
  }))).status;
}

Deno.test("pinned GET subsets and changes-only full-row streams retain the signed scope", async () => {
  assert.equal(await verify({ offset: "now", log: "changes_only", replica: "full" }), 200);
  assert.equal(await verify({
    "subset__where": '"id" = $1',
    "subset__params": JSON.stringify({ "1": "match-1" }),
    "subset__order_by": '"id" ASC', "subset__limit": "40", "subset__offset": "0",
    replica: "full",
  }), 200);
  // Electric intersects this with the signed WHERE; a client cannot replace it.
  assert.equal(await verify({ "subset__where": "true" }), 200);
  assert.equal(await verify({ "subset__where": "true", where: "true" }), 403);
  assert.equal(await verify({ "subset__where": "true", table: "other" }), 403);
  assert.equal(await verify({ "subset__where": "true" }, "&where=true"), 403);
});

Deno.test("subset transport rejects malformed values and unknown or repeated controls", async () => {
  const refused: Record<string, string>[] = [
    { replica: "default" }, { replica: "" },
    { "subset__limit": "0", "subset__order_by": '"id"' },
    { "subset__limit": "1" }, { "subset__limit": "1e2", "subset__order_by": '"id"' },
    { "subset__offset": "-1", "subset__order_by": '"id"' },
    { "subset__offset": "9007199254740992", "subset__order_by": '"id"' },
    { "subset__where": "" }, { "subset__order_by": "  " },
    { "subset__params": "{}" },
    { "subset__where": "true", "subset__params": "[1]" },
    { "subset__where": "true", "subset__params": "null" },
    { "subset__where": "true", "subset__params": "{" },
    { "subset__where": "true", "subset__params": '{"0":"value"}' },
    { "subset__where": "true", "subset__params": '{"1":{"sql":"true"}}' },
    { "subset__where_expr": "{}" }, { "subset__unknown": "true" },
    { "params[1]": "public:" }, { columns: "id" }, { secret: "guess" },
  ];
  for (const extra of refused) assert.equal(await verify(extra), 403, JSON.stringify(extra));
  for (const duplicate of ["subset__where=true", "replica=full", "subset__params=%7B%7D"]) {
    const [key, value] = duplicate.split("=");
    assert.equal(await verify({ "subset__where": "true", [key]: decodeURIComponent(value) }, `&${duplicate}`), 403);
  }
  assert.equal(await verify({ "subset__where": "true" }, "", "POST"), 403);
});

Deno.test("close the unused auth pool", async () => { await sql.end(); });
