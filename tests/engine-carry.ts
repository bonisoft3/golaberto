import assert from "node:assert/strict";
import { compileMechaReducer, type MechaReducerMachine } from "@bonisoft3/pronto/mecha-reducer.ts";
import { instrument } from "@bonisoft3/omnishell/instrument.ts";
import ses from "@bonisoft3/omnishell/interpreter/vendor/ses.umd.min.js" with { type: "text" };

const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// The actors step keeps the bytes a live database ran, which a release refuses
// to see changed, and the engines the rules compile to now reach it by the
// carry after it; so a rule edit fails here, not at the release.
Deno.test("the actors step is the released one and the engine carry holds the current engines", async () => {
  const baseline = await Deno.readTextFile(new URL("../migrations/baseline/063_mecha_actors.sql", import.meta.url));
  assert.equal(await digest(baseline), "edf632b8df2e3017d3ccdd136bd7829dc52e23895c59afa4d794a0cae59fedf1");
  const carry = await Deno.readTextFile(new URL("../migrations/20261114_rule_argument_engines.sql", import.meta.url));
  const inputs = JSON.parse(await Deno.readTextFile(new URL("../.pronto/check-inputs.json", import.meta.url)));
  for (const name of ["sofa_provider", "sofa_resource"]) {
    const spec = inputs.reducers[name] as MechaReducerMachine;
    const rules = await Deno.readTextFile(new URL(`../machines/${name}.js`, import.meta.url));
    const { sql } = await compileMechaReducer(spec, rules, { instrument, ses });
    const engine = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION hybrid_${name}\\.engine\\(input jsonb\\) RETURNS jsonb LANGUAGE plv8 AS \\$mecha\\$[\\s\\S]*?\\$mecha\\$;`))?.[0];
    assert.ok(engine, `missing compiled ${name} engine`);
    assert.ok(carry.includes(engine), `the engine carry is stale for ${name}`);
  }
});
