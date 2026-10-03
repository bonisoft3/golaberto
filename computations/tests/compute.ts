// A computation run as the compute service runs it: its queries over a lake,
// plan and finish in the cage, its jobs on golaberto-odds.wasm in a runner.

import { Computation, type Reader, type Row } from "@mecha/compute/main.ts";
import { Runner } from "@mecha/compute/workers.ts";

const here = new URL("../", import.meta.url);
export const WASM = new URL("golaberto-odds.wasm", here).pathname;
export const odds = await WebAssembly.compile(await Deno.readFile(WASM));

const SINKS = {
  chances: ["team_chance", "zone_chance", "position_chance", "game_importance"],
  ratings: ["team_rating", "player_rating", "rating_eval"],
};

// deno-lint-ignore no-explicit-any
export type Sink = Record<string, any>;
export type Out = Record<string, Sink[]>;

/** `name`'s output over `lake`; `as` names the run, and so its seed. */
export async function compute(name: keyof typeof SINKS, lake: Reader, as: string = name): Promise<Out> {
  const runner = new Runner({ "golaberto-odds": odds });
  try {
    const spec = { name: as, file: new URL(`${name}.js`, here).pathname, every: 1, to: SINKS[name], wasm: [WASM] };
    return await (await Computation.load(spec, runner)).run(lake) as Out;
  } finally {
    runner.close();
  }
}

/** A module's inputs over `lake`: each of its queries' rows. */
export async function inputs(queries: Record<string, string>, lake: Reader): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [name, sql] of Object.entries(queries)) out[name] = await lake.query(sql);
  return out;
}
