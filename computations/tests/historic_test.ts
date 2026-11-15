import { assert, assertEquals, assertRejects } from "@std/assert";
import { runWasm } from "@mecha/compute/wasi.ts";
import {
  advanceHistoric,
  type HistoricalRating,
  initialHistoric,
  type SpiRating,
} from "../../duckstream/historic.ts";

const wasm = await WebAssembly.compile(
  await Deno.readFile(new URL("../golaberto-odds.wasm", import.meta.url)),
);
const call = (op: string, request: unknown) =>
  JSON.parse(
    new TextDecoder().decode(
      runWasm(
        wasm,
        new TextEncoder().encode(JSON.stringify({ op, request })),
        "golaberto-odds",
      ),
    ),
  );

const ratings = Array.from(
  { length: 12 },
  (_, i) => ({ id: i + 1, offense: 0, defense: 0, team: 0 }),
);
const game = (home: number, day: number, n: number) => ({
  phase_id: 1,
  home_id: home,
  away_id: home + 1,
  home_score: n % 3,
  away_score: n % 2,
  timestamp: day * 86400,
  length: 1,
  advantage: 0.16,
});

Deno.test("historic checkpoints preserve WASM priors, expired teams and same-day catch-up fits", async () => {
  const games = [
    ...Array.from({ length: 10 }, (_, i) => game(i + 1, i, i)),
    ...Array.from(
      { length: 60 },
      (_, i) => game(i % 8 + 1, 1460 + Math.floor(i / 3), i),
    ),
  ];
  const expected = call("historic", { games, ratings, phases_to_eval: [] });
  const rows: HistoricalRating[] = [];
  let checkpoint = initialHistoric(ratings);
  let fits = 0;
  for (const [ordinal, g] of games.entries()) {
    const step = await advanceHistoric(checkpoint, {
      ordinal,
      timestamp: g.timestamp,
      last: ordinal === games.length - 1,
    }, (window, priors) => {
      fits++;
      return Promise.resolve(call("spi", {
        games: games.filter((g, i) =>
          i <= window.throughOrdinal && g.timestamp >= window.minimumTimestamp
        ),
        ratings: priors,
        phases_to_eval: [],
      }));
    });
    assert(step.rows.length <= ratings.length);
    rows.push(...step.rows);
    checkpoint = JSON.parse(JSON.stringify(step.checkpoint));
  }
  assertEquals(rows, expected);
  assertEquals(fits, 24);
  assert(checkpoint.complete);
  assert(checkpoint.ratings.some((r) => r.offense === 0 && r.defense === 0));
  assert(
    new Set(rows.map((r) => `${r.team_id}:${r.measure_date}`)).size <
      rows.length,
  );
});

Deno.test("historic forces the final fit before four years and includes the exact window boundary", async () => {
  const games = [game(1, 0, 1), game(2, 1460, 2)];
  let checkpoint = initialHistoric(ratings);
  checkpoint = (await advanceHistoric(checkpoint, {
    ordinal: 0,
    timestamp: 0,
    last: false,
  }, () => {
    throw new Error("premature fit");
  })).checkpoint;
  const result = await advanceHistoric(checkpoint, {
    ordinal: 1,
    timestamp: games[1].timestamp,
    last: true,
  }, (window, priors) => {
    assertEquals(window, { minimumTimestamp: 0, throughOrdinal: 1 });
    return Promise.resolve(
      call("spi", { games, ratings: priors, phases_to_eval: [] }),
    );
  });
  assertEquals(
    result.rows,
    call("historic", { games, ratings, phases_to_eval: [] }),
  );
  const only = await advanceHistoric(
    initialHistoric(ratings),
    { ordinal: 0, timestamp: 0, last: true },
    (_window, priors) =>
      Promise.resolve(
        call("spi", {
          games: games.slice(0, 1),
          ratings: priors,
          phases_to_eval: [],
        }),
      ),
  );
  assertEquals(
    only.rows,
    call("historic", { games: games.slice(0, 1), ratings, phases_to_eval: [] }),
  );
});

Deno.test("a failed historic fit leaves the prior checkpoint reusable", async () => {
  const checkpoint = initialHistoric(ratings);
  const saved = structuredClone(checkpoint);
  await assertRejects(
    () =>
      advanceHistoric(
        checkpoint,
        { ordinal: 0, timestamp: 0, last: true },
        (_window, priors) => {
          priors[0].offense = 99;
          return Promise.reject(new Error("fit failed"));
        },
      ),
    Error,
    "fit failed",
  );
  assertEquals(checkpoint, saved);
  await assertRejects(
    () =>
      advanceHistoric(
        checkpoint,
        { ordinal: 0, timestamp: 0, last: true },
        () => Promise.resolve({} as Record<string, SpiRating | null>),
      ),
    Error,
    "different historic team IDs",
  );
  assertEquals(checkpoint, saved);
});

Deno.test("an archive-sized team table produces one bounded checkpoint batch", async () => {
  const teams = Array.from(
    { length: 3426 },
    (_, i) => ({ id: i + 1, offense: 0, defense: 0, team: 0 }),
  );
  const games = Array.from(
    { length: teams.length / 2 },
    (_, i) => game(i * 2 + 1, 0, i),
  );
  let checkpoint = initialHistoric(teams);
  for (let ordinal = 0; ordinal < games.length - 1; ordinal++) {
    const result = await advanceHistoric(checkpoint, {
      ordinal,
      timestamp: 0,
      last: false,
    }, () => {
      throw new Error("premature fit");
    });
    assertEquals(result.rows.length, 0);
    checkpoint = result.checkpoint;
  }
  const result = await advanceHistoric(
    checkpoint,
    { ordinal: games.length - 1, timestamp: 0, last: true },
    (_window, priors) =>
      Promise.resolve(
        call("spi", { games, ratings: priors, phases_to_eval: [] }),
      ),
  );
  assertEquals(result.rows.length, teams.length);
  assertEquals(result.checkpoint.ratings.length, teams.length);
  assertEquals(
    result.rows,
    call("historic", { games, ratings: teams, phases_to_eval: [] }),
  );
  assert(new TextEncoder().encode(JSON.stringify(result)).length < 1024 * 1024);
});

Deno.test("historic continuation rejects skipped inputs and appends after completion", async () => {
  const checkpoint = initialHistoric(ratings);
  const unused = () => Promise.reject(new Error("unexpected fit"));
  await assertRejects(
    () =>
      advanceHistoric(
        checkpoint,
        { ordinal: 1, timestamp: 0, last: false },
        unused,
      ),
    Error,
    "ordinal order",
  );
  const first = await advanceHistoric(checkpoint, {
    ordinal: 0,
    timestamp: 1,
    last: false,
  }, unused);
  await assertRejects(
    () =>
      advanceHistoric(first.checkpoint, {
        ordinal: 1,
        timestamp: 0,
        last: false,
      }, unused),
    Error,
    "ordinal order",
  );
  await assertRejects(
    () =>
      advanceHistoric({ ...checkpoint, complete: true }, {
        ordinal: 0,
        timestamp: 0,
        last: true,
      }, unused),
    Error,
    "ordinal order",
  );
});
