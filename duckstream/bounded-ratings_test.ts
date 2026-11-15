import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import * as program from "../computations/ratings.js";
import { inputs } from "../computations/tests/compute.ts";
import { World } from "../computations/tests/world.ts";
import { legacy, runBounded, sorted } from "./bounded-test.ts";
import { boundedRows, boundedWasm, JOB_BYTES, step } from "./bounded-ratings.ts";
import { duckdb, readerOf } from "@mecha/compute/main.ts";

Deno.test({
  name:
    "bounded ratings preserve complete archive outputs across durable checkpoints and player partitions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    const queried = await inputs(program.queries, await world.lake());
    for (const rows of Object.values(queried)) rows.reverse();
    const expected = sorted(await legacy(program, queried));
    let prepared = 0;
    const driver: typeof step = async (db, state) => {
      const stage = (state as { stage?: string } | null)?.stage;
      const result = await step(db, state);
      if (
        state === null || stage === "prepare" || stage === "prepare_players"
      ) {
        assertEquals(result.statements?.length, 1);
        assertEquals(result.writes, {});
        prepared++;
      }
      return result;
    };
    const actual = await runBounded(driver, queried, [
      "team_rating",
      "player_rating",
      "rating_eval",
    ]);
    assertEquals(actual.out, expected);
    assertEquals(prepared, 35);
    assert(
      actual.jobs > queried.phases.length + 2,
      "players and historic refits require independent jobs",
    );
  },
});

Deno.test({
  name: "bounded ratings handle an empty professional archive without WASM",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    world.rows.game = [];
    const queried = await inputs(program.queries, await world.lake());
    const actual = await runBounded(step, queried, [
      "team_rating",
      "player_rating",
      "rating_eval",
    ]);
    assertEquals(actual.out, {
      team_rating: [],
      player_rating: [],
      rating_eval: [],
    });
    assertEquals(actual.jobs, 0);
  },
});

Deno.test("oversized numerical inputs fail before allocating a WASM instance", async () => {
  let called = false;
  await assertRejects(
    () =>
      boundedWasm({
        query: () => Promise.resolve([]),
        wasmFromQuery: () => {
          throw new Error("unexpected query-backed input");
        },
        wasm: () => {
          called = true;
          return Promise.resolve(null);
        },
      }, { request: "x".repeat(JOB_BYTES) }),
    Error,
    "bounded WASM input capacity",
  );
  assertEquals(called, false);
});

Deno.test("ratings read ordered inputs beyond host row and byte limits", async () => {
  const database = await duckdb();
  const con = await database.connect();
  try {
    const reader = readerOf(con);
    const lengths: number[] = [];
    const query = async (sql: string) => {
      const rows = await reader.query(sql);
      if (
        rows.length > 4096 ||
        new TextEncoder().encode(JSON.stringify(rows)).length > 1024 * 1024
      ) {
        throw new Error("execution query exceeds page limit");
      }
      lengths.push(rows.length);
      return rows;
    };
    const sql =
      "SELECT i::INTEGER AS id,repeat('x',300) AS value FROM range(5000) t(i) ORDER BY i";
    await assertRejects(
      () => query(sql),
      Error,
      "execution query exceeds page limit",
    );
    const rows = await boundedRows({
      query,
      wasm: () => {
        throw new Error("unexpected WASM");
      },
      wasmFromQuery: () => {
        throw new Error("unexpected WASM");
      },
    }, sql);
    assertEquals(rows.length, 5000);
    assert(lengths[0] < 4096 && lengths[0] > 128);
    assertEquals(lengths.at(-1), 0);
    assertEquals(
      rows.map((row) => row.id),
      Array.from({ length: 5000 }, (_, i) => i),
    );
    lengths.length = 0;
    const narrow = await boundedRows({
      query,
      wasm: () => { throw new Error("unexpected WASM"); },
      wasmFromQuery: () => { throw new Error("unexpected WASM"); },
    }, "SELECT i::INTEGER AS id FROM range(5000) t(i) ORDER BY i");
    assertEquals(narrow.map((row) => row.id), Array.from({ length: 5000 }, (_, i) => i));
    assertEquals(lengths, [4096, 904, 0]);
    lengths.length = 0;
    const wide = await boundedRows({
      query,
      wasm: () => { throw new Error("unexpected WASM"); },
      wasmFromQuery: () => { throw new Error("unexpected WASM"); },
    }, "SELECT i::INTEGER AS id,repeat('x',600000) AS value FROM range(2) t(i) ORDER BY i");
    assertEquals(wide.map((row) => row.id), [0, 1]);
    assertEquals(lengths, [1, 1, 0]);
  } finally {
    con.closeSync();
    database.closeSync();
  }
});

Deno.test({
  name:
    "staged ratings preparation preserves timestamp/UUID order and numeric ID mapping",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const game = {
      phase_id: "phase-z",
      home_id: "team-z",
      away_id: "team-a",
      home_score: 2,
      away_score: 1,
      home_aet: null,
      away_aet: null,
      home_field: 0,
      moment: 20,
      date: "1970-01-01 00:00:20",
      recent: true,
      seven_years: true,
    };
    const captured = {
      teams: [{ id: "team-z" }, { id: "team-a" }],
      players: [],
      games: [{ ...game, id: "game-z" }, {
        ...game,
        id: "game-a",
        phase_id: "phase-a",
      }, { ...game, id: "game-first", moment: 10 }],
    };
    let prepared = false;
    const driver: typeof step = async (db, state) => {
      if ((state as { stage?: string } | null)?.stage === "initialize") {
        assertEquals(
          await db.query(`SELECT ordinal,uuid,phase_id,home_id,away_id,
          home_score,away_score,home_aet,away_aet FROM ratings_games ORDER BY ordinal`),
          [
            {
              ordinal: 0,
              uuid: "game-first",
              phase_id: 2,
              home_id: 2,
              away_id: 1,
              home_score: 2,
              away_score: 1,
              home_aet: null,
              away_aet: null,
            },
            {
              ordinal: 1,
              uuid: "game-a",
              phase_id: 1,
              home_id: 2,
              away_id: 1,
              home_score: 2,
              away_score: 1,
              home_aet: null,
              away_aet: null,
            },
            {
              ordinal: 2,
              uuid: "game-z",
              phase_id: 2,
              home_id: 2,
              away_id: 1,
              home_score: 2,
              away_score: 1,
              home_aet: null,
              away_aet: null,
            },
          ],
        );
        prepared = true;
        return { checkpoint: { stage: "done" }, writes: {}, done: true };
      }
      return await step(db, state);
    };
    assertEquals((await runBounded(driver, captured, [])).jobs, 0);
    assert(prepared);
    captured.games[0].home_id = "unknown";
    await assertRejects(
      () => runBounded(driver, captured, []),
      Error,
      "unknown home team",
    );
  },
});
