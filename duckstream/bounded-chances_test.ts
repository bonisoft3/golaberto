import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import * as program from "../computations/chances.js";
import { step } from "./bounded-chances.ts";
import { finish } from "./chances.pure.js";
import { legacy, runBounded, sorted } from "./bounded-test.ts";
import type { Row } from "./bounded-ratings.ts";

const sinks = [
  "team_chance",
  "zone_chance",
  "position_chance",
  "game_importance",
];
const fixture = (): Record<string, Row[]> => {
  const groups = ["a", "g", "h"].map((id) => ({
    id,
    live: id !== "a",
    sort: "pt,w,gd,gf,name",
    bonus_points: 0,
    bonus_points_threshold: 0,
    win: 3,
    draw: 1,
    loss: 0,
  }));
  const members = groups.flatMap((g, i) =>
    [0, 1].map((n) => ({
      group_id: g.id,
      team_id: String(i * 2 + n + 1),
      name: n === 0 ? "\u{10000}" : "\uE000",
      add_sub: 0,
      bias: 0,
      position: n + 1,
      points: 0,
      played: 0,
    }))
  );
  const game = (
    group_id: string,
    id: string,
    home_id: string,
    away_id: string,
    day: number,
  ) => ({
    group_id,
    id,
    home_id,
    away_id,
    home_field: "left",
    played: false,
    home_score: 0,
    away_score: 0,
    home_off: 1.3,
    home_def: 1.4,
    away_off: 1.2,
    away_def: 1.1,
    __order: `2026-01-0${day} 12:00:00`,
  });
  return {
    groups: groups.reverse(),
    members: members.reverse(),
    games: [
      game("g", "cross", "3", "5", 2),
      game("h", "cross", "3", "5", 2),
      game("g", "local-g", "3", "4", 1),
      game("h", "local-h", "5", "6", 3),
    ],
    zones: groups.map((g) => ({
      id: "z-" + g.id,
      group_id: g.id,
      first: 1,
      last: 1,
      positions: "",
      color: "champion",
    })),
  };
};

Deno.test({
  name:
    "bounded chances preserve global group IDs, Unicode order and both sides of cross-group importance",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const inputs = fixture();
    const expected = sorted(await legacy(program, inputs));
    const actual = await runBounded(step, inputs, sinks);
    assertEquals(actual.out, expected);
    const cross = actual.out.game_importance.find((r) => r.id === "cross")!;
    assert(cross.home !== null && cross.away !== null);
    assertEquals(actual.jobs, 2);
  },
});

Deno.test({
  name: "bounded finished groups retain ranked outputs without invoking WASM",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const inputs = fixture();
    inputs.groups = inputs.groups.map((g) => ({ ...g, live: false }));
    inputs.games = [];
    const actual = await runBounded(step, inputs, sinks);
    assertEquals(actual.out, sorted(await legacy(program, inputs)));
    assertEquals(actual.jobs, 0);
  },
});

const encodedSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const largeGroup = (live: boolean, count = 218): Record<string, Row[]> => {
  const base = fixture();
  const group = { ...base.groups[0], id: "large", live };
  return {
    groups: [group],
    members: Array.from({ length: count }, (_, i) => ({
      ...base.members[0],
      group_id: group.id,
      team_id: String(i + 1).padStart(4, "0"),
      name: String(i + 1).padStart(4, "0"),
      position: i + 1,
    })),
    games: [],
    zones: [{ ...base.zones[0], group_id: group.id }],
  };
};

const responseFor = (inputs: Record<string, Row[]>, unused = "") => ({
  team_odds: Object.fromEntries(inputs.members.map((_, i) => [i + 1, {
    Pos: inputs.members.map((_, r) => r === i ? 100 : 0),
    unused,
  }])),
  rare_position_estimates: Object.fromEntries(inputs.members.map((_, i) => [
    i + 1,
    Object.fromEntries(inputs.members.map((_, r) => [r, {
      reachability: r === i ? "reachable" : "impossible",
      unused,
    }])),
  ])),
  game_importance: {},
});

// Every invocation reconstructs its checkpoint, as a new Compute request does.
const paged = async (
  inputs: Record<string, Row[]>,
  responses: unknown[],
) => {
  let jobs = 0;
  let checkpoint: unknown = null;
  let pages = 0;
  const output = Object.fromEntries(
    sinks.map((sink) => [sink, new Map<string, Row>()]),
  );
  const host: import("./bounded-ratings.ts").Host = {
    seed: 17,
    wasm: () => Promise.resolve(responses[jobs++]),
    wasmFromQuery: () => {
      throw new Error("unexpected WASM query");
    },
    query: (sql) => {
      const paged = (rows: Row[]) => {
        const offset = Number(sql.match(/LIMIT 4096 OFFSET (\d+)/)?.[1] ?? 0);
        return Promise.resolve(sql.includes("AS bounded_page") ? rows.slice(offset, offset + 4096) : rows);
      };
      if (sql.includes("FROM chances_groups")) {
        const eq = sql.match(/WHERE ordinal=(-?\d+)/);
        if (eq) {
          const index = Number(eq[1]);
          const group = inputs.groups[index];
          return Promise.resolve(group ? [{ ordinal: index, ...group }] : []);
        }
        const [, after, limit] = sql.match(
          /WHERE ordinal>(-?\d+) AND ordinal<=(-?\d+)/,
        )!;
        return Promise.resolve(
          inputs.groups
            .map((group, ordinal) => ({ ordinal, ...group }))
            .filter((row) =>
              row.ordinal > Number(after) && row.ordinal <= Number(limit)
            ),
        );
      }
      if (sql.includes("FROM chances_importance")) {
        return paged([...output.game_importance.values()]);
      }
      const name = sql.match(/FROM chances_(\w+)/)![1];
      const groups = new Set(
        Array.from(sql.matchAll(/'([^']+)'/g), (match) => match[1]),
      );
      return paged(inputs[name].filter((r) => groups.has(String(r.group_id))));
    },
  };
  for (let iteration = 0; iteration < 1000; iteration++) {
    const before = jobs;
    const result = await step(host, structuredClone(checkpoint));
    assert(encodedSize(result.checkpoint) <= 4 * 1024 * 1024);
    assert(encodedSize(result.writes) <= 256 * 1024);
    assert(encodedSize(result) <= 8 * 1024 * 1024);
    if (Object.values(result.writes).some((rows) => rows.length)) {
      pages++;
      assertEquals(jobs, before);
      assertEquals(await step(host, structuredClone(checkpoint)), result);
      assertEquals(jobs, before, "replaying a finish page must not rerun WASM");
    }
    for (const [sink, rows] of Object.entries(result.writes)) {
      for (const row of rows) output[sink].set(String(row.id), row);
    }
    checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    if (result.done) {
      return {
        jobs,
        pages,
        out: sorted(
          Object.fromEntries(
            sinks.map((sink) => [sink, [...output[sink].values()]]),
          ),
        ),
      };
    }
  }
  throw new Error("paged finish did not complete");
};

Deno.test("finished groups above 32768 rows page exactly without WASM", async () => {
  const inputs = largeGroup(false);
  const expected = program.finish(inputs, []);
  assert(expected.position_chance.length > 32768);
  const actual = await paged(inputs, []);
  assertEquals(actual.out, sorted(expected));
  assertEquals(actual.jobs, 0);
  assert(actual.pages > 1);

  const batches: Record<string, Row[]>[] = ["first", "second", "third"].map((
    id,
  ) => {
    const group = largeGroup(false, 25);
    return {
      groups: [{ ...group.groups[0], id }],
      members: group.members.map((m) => ({ ...m, group_id: id })),
      games: [],
      zones: group.zones.map((z) => ({ ...z, id: `z-${id}`, group_id: id })),
    };
  });
  const combined: Record<string, Row[]> = Object.fromEntries(
    Object.keys(batches[0]).map((k) => [
      k,
      batches.flatMap((b) => b[k]),
    ]),
  );
  const batched = await paged(combined, []);
  assertEquals(batched.out, sorted(program.finish(combined, [])));
  assertEquals(batched.jobs, 0);
  assertEquals(batched.pages, 2);
});

Deno.test("large WASM results retain only finish fields and resume exact bounded pages", async () => {
  const inputs = largeGroup(true);
  const response = responseFor(inputs, "x".repeat(270));
  assert(encodedSize(response) > 8 * 1024 * 1024);
  const actual = await paged(inputs, [response]);
  const expected = program.finish(inputs, [response]);
  assertEquals(finish(inputs, [response]), expected);
  assertEquals(actual.out, sorted(expected));
  assertEquals(actual.jobs, 1);
  assert(actual.pages > 1);
});

Deno.test("importance pages retain both sides across groups and restart", async () => {
  const first = largeGroup(true, 2);
  first.games = Array.from({ length: 4000 }, (_, i) => ({
    ...fixture().games[0],
    id: `game-${String(i).padStart(5, "0")}`,
    group_id: "large",
    home_id: "0001",
    away_id: "0002",
  }));
  const second = Object.fromEntries(
    Object.entries(first).map(([name, rows]) => [
      name,
      rows.map((row) =>
        name === "groups"
          ? { ...row, id: "second" }
          : { ...row, group_id: "second" }
      ),
    ]),
  );
  const inputs = Object.fromEntries(
    Object.keys(first).map((name) => [name, [...first[name], ...second[name]]]),
  );
  const responses = [first, second].map((group, side) => ({
    ...responseFor(group),
    game_importance: Object.fromEntries(
      group.games.map((
        _,
        i,
      ) => [i + 1, side === 0 ? [0.25, null] : [null, 0.75]]),
    ),
  }));
  const actual = await paged(inputs, responses);
  assertEquals(actual.out, sorted(program.finish(inputs, responses)));
  assertEquals(actual.jobs, 2);
  assert(actual.pages >= 4);
});

Deno.test("chance checkpoints and individual output rows fail before oversized commit", async () => {
  const live = largeGroup(true, 2);
  const response = responseFor(live);
  response.team_odds["1"].Pos = Array(500000).fill(123456789);
  await assertRejects(
    () => paged(live, [response]),
    Error,
    "bounded checkpoint capacity",
  );
  const finished = largeGroup(false, 2);
  finished.members[0].name = "⚽".repeat(100000);
  await assertRejects(
    () => paged(finished, []),
    Error,
    "bounded page capacity",
  );
});
