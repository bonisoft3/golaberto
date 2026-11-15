import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import {
  parse,
  type Plan,
  type Schema,
  translate,
  translatePhysical,
} from "@bonisoft3/pronto/duckstream/translator.ts";
import { outputs, physicalCarriers } from "./carriers.ts";
import { World } from "../computations/tests/world.ts";
import { inputs } from "../computations/tests/compute.ts";
import * as ratings from "../computations/ratings.js";
import * as chances from "../computations/chances.js";

const sorted = (rows: Record<string, unknown>[]) =>
  rows.map((row) => JSON.stringify(row)).sort();

for (const name of ["ratings", "chances"] as const) {
  Deno.test({
    name:
      `${name} physical barriers preserve relational bags and numerical ordering`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const base = new URL(name + "/", import.meta.url);
      const plan = parse(
        await Deno.readTextFile(new URL("plan.json", base)),
      ) as Plan;
      const schema = parse(
        await Deno.readTextFile(new URL("schema.json", base)),
      ) as Schema;
      const physical = Object.fromEntries(outputs[name].map((output) => [
        "result_" + output,
        translatePhysical(
          plan,
          schema,
          "result_" + output,
          `__duckstream_${name}_${output}`,
        ),
      ]));
      const queries = physicalCarriers(name, physical, schema);
      const program = name === "ratings" ? ratings : chances;
      const world = new World();
      world.rows.team[0].name = "\uE000";
      world.rows.team[1].name = "😀";
      const lake = await world.lake();
      const expected = await inputs(program.queries, lake);
      const actual: typeof expected = {};
      const names = new Set<string>();
      for (const [output, query] of Object.entries(queries)) {
        assertEquals(
          translate(plan, schema, "result_" + output),
          await Deno.readTextFile(new URL(`result_${output}.sql`, base)),
        );
        for (const stage of query.stages) {
          assertEquals(names.has(stage.name), false);
          names.add(stage.name);
          await lake.query(`CREATE TABLE "${stage.name}" AS ${stage.sql}`);
        }
        actual[output] = await lake.query(query.sql);
        assertEquals(sorted(actual[output]), sorted(expected[output]));
        for (const stage of query.stages) {
          await lake.query(`DROP TABLE "${stage.name}"`);
        }
        actual[output].reverse();
      }
      assertEquals(
        program.plan(actual, 17, []),
        program.plan(expected, 17, []),
      );
      assertThrows(
        () => translatePhysical(plan, schema, "result_games", "unscoped"),
        Error,
        "physical stage namespace",
      );
    },
  });
}
