import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import * as teamProgram from "../computations/team_ratings.js";
import * as playerProgram from "../computations/player_ratings.js";
import { inputs } from "../computations/tests/compute.ts";
import { World } from "../computations/tests/world.ts";
import { legacy, runBounded, sorted } from "./bounded-test.ts";
import { boundedRows, boundedWasm, JOB_BYTES } from "./bounded-ratings.ts";
import { step as teamStep } from "./bounded-team-ratings.ts";
import { step as playerStep } from "./bounded-player-ratings.ts";
import { duckdb, readerOf } from "@mecha/compute/main.ts";

for (const [concurrency, maxJobs] of [[1, 1], [1, 64], [2, 64], [8, 64]] as const) {
  Deno.test({
    name:
      `bounded split ratings preserve complete archive outputs across durable checkpoints (concurrency=${concurrency}, maxJobs=${maxJobs})`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const world = new World();
      const baseLake = await world.lake();
      const teamInputs = await inputs(teamProgram.queries, baseLake);
      for (const rows of Object.values(teamInputs)) rows.reverse();
      const expectedTeam = sorted(await legacy(teamProgram, teamInputs));
      const actualTeam = await runBounded(
        teamStep,
        teamInputs,
        ["team_rating"],
        17,
        concurrency,
        maxJobs,
      );
      assertEquals(actualTeam.out, expectedTeam);

      const ratedLake = await world.lake({
        team_rating: actualTeam.out.team_rating.map((r) => ({
          ...r,
          offense: `${r.offense}`,
          defense: `${r.defense}`,
          rating: `${r.rating}`,
        })),
      });
      const playerInputs = await inputs(playerProgram.queries, ratedLake);
      for (const rows of Object.values(playerInputs)) rows.reverse();
      const expectedPlayer = sorted(await legacy(playerProgram, playerInputs));
      const actualPlayer = await runBounded(
        playerStep,
        playerInputs,
        ["player_rating"],
        17,
        concurrency,
        maxJobs,
      );
      assertEquals(actualPlayer.out, expectedPlayer);
      assert(
        actualTeam.jobs >= 2 && actualPlayer.jobs >= 2,
        "historic refits and player slices run as bounded WASM jobs",
      );
    },
  });
}

Deno.test({
  name: "bounded split ratings handle an empty professional archive without WASM",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    world.rows.game = [];
    const lake = await world.lake();
    const teamOut = await runBounded(
      teamStep,
      await inputs(teamProgram.queries, lake),
      ["team_rating"],
    );
    const playerOut = await runBounded(
      playerStep,
      await inputs(playerProgram.queries, lake),
      ["player_rating"],
    );
    assertEquals(teamOut.out, { team_rating: [] });
    assertEquals(playerOut.out, { player_rating: [] });
    assertEquals(teamOut.jobs + playerOut.jobs, 0);
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
    "staged team ratings preparation preserves timestamp/UUID order and numeric ID mapping",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const game = {
      home_id: "team-z",
      away_id: "team-a",
      home_score: 2,
      away_score: 1,
      home_aet: null,
      away_aet: null,
      home_field: 0,
      moment: 20,
      date: "2026-04-01 00:00:00",
    };
    const captured = {
      teams: [{ id: "team-z" }, { id: "team-a" }],
      games: [{ ...game, id: "game-z" }, {
        ...game,
        id: "game-a",
      }, { ...game, id: "game-first", moment: 10 }],
    };
    let prepared = false;
    const driver: typeof teamStep = async (db, state) => {
      if ((state as { stage?: string } | null)?.stage === "initialize") {
        assertEquals(
          await db.query(`SELECT ordinal,uuid,home_id,away_id,
          home_score,away_score,home_aet,away_aet FROM ratings_historic_games ORDER BY ordinal`),
          [
            {
              ordinal: 0,
              uuid: "game-first",
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
      return await teamStep(db, state);
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
