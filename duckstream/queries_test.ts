import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import * as ratings from "../computations/ratings.js";
import * as chances from "../computations/chances.js";
import * as oldRatings from "./ratings.legacy.js";
import * as oldChances from "./chances.legacy.js";
import { inputs } from "../computations/tests/compute.ts";
import { uid, World } from "../computations/tests/world.ts";
import { build } from "./build.ts";
import { calendarWorld } from "./calendar-fixture.ts";

// The numerical oracle stays unchanged; only the application's history boundary advances monthly.
const monthlyRatings = {
  ...oldRatings,
  queries: {
    ...oldRatings.queries,
    games: oldRatings.queries.games.replace(
      "(SELECT max(utc) FROM x) - INTERVAL 7 YEAR",
      "(SELECT date_trunc('month', max(utc)) FROM x) - INTERVAL 7 YEAR",
    ),
  },
};

const visible = (rows: Record<string, unknown[]>) =>
  Object.fromEntries(
    Object.entries(rows).map(([key, values]) => [
      key,
      values.map((value) =>
        Object.fromEntries(
          Object.entries(value as object).filter(([key]) => key !== "__order"),
        )
      ),
    ]),
  );

Deno.test({
  name:
    "Duckstream-derived queries preserve archive calendar, strict ASOF and f32 boundaries",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    world.rows.team[0].name = "\uE000";
    world.rows.team[1].name = "😀";
    const played = world.rows.game.filter((g) => g.played === "true");
    played[0].kickoff = "2024-02-29T23:59:59.500001Z";
    played[1].kickoff = "2024-02-29T23:59:59.499999Z";
    played.find((g) => g.phase_id === world.phases["2026"])!.kickoff =
      "2028-02-29T23:59:59.500001Z";
    const live = world.rows.game.filter((g) => g.played === "false");
    live[0].kickoff = "2026-05-24T00:00:00.000000Z";
    live[1].kickoff = "2026-05-24T00:00:00.000001Z";
    live[2].kickoff = "2026-05-24T03:00:00.000001+03:00";
    const lake = await world.lake({
      team_rating: world.teams.flatMap((team, i) =>
        ["2026-04-01", "2026-05-24"].map((day, j) => ({
          id: uid(12, i * 10 + j),
          team_id: team,
          measure_date: day,
          offense: String(1.23456789 + j),
          defense: String(0.98765432 + j),
          rating: "50",
        }))
      ),
    });
    for (
      const [program, legacy] of [[ratings, monthlyRatings], [
        chances,
        oldChances,
      ]]
    ) {
      assertEquals(
        visible(await inputs(program.queries, lake)),
        await inputs(legacy.queries, lake),
      );
    }
    const captured = await inputs(chances.queries, lake);
    const shuffled = Object.fromEntries(
      Object.entries(captured).map(([key, rows]) => [key, [...rows].reverse()]),
    );
    assertEquals(chances.plan(shuffled, 17), chances.plan(captured, 17));
    const ratingInputs = await inputs(ratings.queries, lake);
    assertEquals(
      ratings.plan(
        Object.fromEntries(
          Object.entries(ratingInputs).map((
            [key, rows],
          ) => [key, [...rows].reverse()]),
        ),
        17,
        [],
      ),
      ratings.plan(ratingInputs, 17, []),
    );
  },
});
Deno.test({
  name: "Duckstream-derived ratings preserve an empty professional archive",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    for (const game of world.rows.game) game.played = "false";
    const lake = await world.lake();
    assertEquals(
      visible(await inputs(ratings.queries, lake)),
      await inputs(monthlyRatings.queries, lake),
    );
  },
});
Deno.test("Golaberto programs and native descriptors are generated from admitted Duckstream SQL", async () => {
  for (const name of ["ratings", "chances"] as const) {
    const actual = await build(name);
    assertEquals(
      await Deno.readTextFile(
        new URL(`../computations/${name}.js`, import.meta.url),
      ),
      actual.source,
    );
    assertEquals(
      await Deno.readTextFile(new URL(`${name}.risingwave.json`, import.meta.url)),
      actual.risingwave,
    );
  }
});

Deno.test({
  name:
    "ambiguous rating team/day fails before either engine can choose a power",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = new World();
    const lake = await world.lake({
      team_rating: [0, 1].map((i) => ({
        id: uid(12, i),
        team_id: world.teams[0],
        measure_date: "2026-04-01",
        offense: String(i + 1),
        defense: "1",
        rating: "50",
      })),
    });
    const descriptor = JSON.parse(
      await Deno.readTextFile(new URL("chances.risingwave.json", import.meta.url)),
    );
    await assertRejects(
      () => lake.query(chances.queries.games),
      Error,
      "ambiguous team_rating team/day",
    );
    await assertRejects(
      () => lake.query(descriptor.inputs.source_team_rating.query),
      Error,
      "ambiguous team_rating team/day",
    );
  },
});

for (const years of [4, 7] as const) {
  Deno.test({
    name:
      `calendar ${years}-year boundary preserves its declared monthly or phase policy`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const world = calendarWorld(years);
      const lake = await world.lake();
      const actual = await inputs(ratings.queries, lake);
      assertEquals(visible(actual), await inputs(monthlyRatings.queries, lake));
      if (years === 7) {
        assertEquals(
          actual.games.find((row) => row.id === world.rows.game[0].id)
            ?.seven_years,
          true,
        );
      } else {
        assertEquals(
          actual.phases[0].since,
          Date.parse("2100-02-28T21:00:00Z") / 1000,
        );
      }
    },
  });
}

Deno.test({
  name:
    "native odds partitions own whole phases and preserve group seeds and requests",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const world = new World();
    const lake = await world.lake();
    const descriptor = JSON.parse(
      await Deno.readTextFile(new URL("chances.risingwave.json", import.meta.url)),
    );
    await lake.query(
      "CREATE VIEW source_stage_group AS SELECT id,phase_id FROM stage_group",
    );
    const whole = await inputs(chances.queries, lake);
    const partitions: Record<string, typeof whole> = {};
    for (const [name, query] of Object.entries(chances.queries)) {
      await lake.query(`CREATE VIEW result_${name} AS ${query}`);
      const rows = await lake.query(
        descriptor.incremental.outputs[name].partitionQuery,
      );
      for (const { __partition, ...row } of rows) {
        const key = String(__partition);
        partitions[key] ??= Object.fromEntries(
          Object.keys(whole).map((name) => [name, []]),
        );
        partitions[key][name].push(row);
        const group = world.rows.stage_group.find((g) =>
          g.id === (name === "groups" ? row.id : row.group_id)
        );
        assertEquals(group!.phase_id, key);
      }
    }
    const jobs = chances.plan(whole, 17);
    const scoped = Object.values(partitions).flatMap((part) =>
      chances.plan(part, 17)
    );
    const normalize = (job: typeof jobs[number]) => {
      const copy = structuredClone(job);
      delete copy.input.request.id;
      return JSON.stringify(copy);
    };
    assertEquals(scoped.map(normalize).sort(), jobs.map(normalize).sort());
  },
});

Deno.test({
  name:
    "per-table CDC skew never captures dangling calculation references and converges",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const world = new World();
    const teams = world.rows.team;
    const players = world.rows.player;
    const baseline = await world.lake();
    const expectedRatings = await inputs(ratings.queries, baseline);
    const expectedChances = await inputs(chances.queries, baseline);
    // Child rows may arrive before inserts, or remain after parent deletes.
    for (const available of [teams.slice(1), []]) {
      world.rows.team = available;
      world.rows.player = [];
      const lake = await world.lake();
      const captured = await inputs(ratings.queries, lake);
      const known = new Set(available.map((t) => t.id));
      assertEquals(
        captured.games.every((g) =>
          known.has(String(g.home_id)) && known.has(String(g.away_id))
        ),
        true,
      );
      assertEquals(captured.goals, []);
      assertEquals(captured.appearances, []);
      ratings.plan(captured, 17, [[]]);
      const odds = await inputs(chances.queries, lake);
      assertEquals(odds.groups, []);
      assertEquals(chances.plan(odds, 17), []);
      chances.finish(odds, []);
    }
    world.rows.team = teams;
    world.rows.player = players;
    const restored = await world.lake();
    assertEquals(await inputs(ratings.queries, restored), expectedRatings);
    assertEquals(await inputs(chances.queries, restored), expectedChances);
    ratings.plan(expectedRatings, 17, [[]]);
    chances.plan(expectedChances, 17);
  },
});

Deno.test({
  name:
    "seven-year statistics history advances only at UTC month boundaries and replays",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    for (
      const [latest, start] of [
        ["2026-10-01T00:00:00.000000Z", "2019-10-01"],
        ["2026-10-31T23:59:59.999999Z", "2019-10-01"],
        ["2026-11-01T00:00:00.000000Z", "2019-11-01"],
        ["2026-11-01T00:30:00+01:00", "2019-10-01"],
        ["2024-02-29T23:59:59.999999Z", "2017-02-01"],
        ["2024-03-01T00:00:00.000000Z", "2017-03-01"],
        ["2027-01-01T00:00:00.000000Z", "2020-01-01"],
      ]
    ) {
      const world = new World();
      const at = start + "T00:00:00.000000Z";
      const before = new Date(Date.parse(at) - 1).toISOString();
      world.rows.game = world.rows.game.slice(0, 3).map((game, i) => ({
        ...game,
        played: "true",
        kickoff: [before, at, latest][i],
        day: [before, at, latest][i].slice(0, 10),
      }));
      const lake = await world.lake();
      const first = await inputs(ratings.queries, lake);
      const history = new Map(
        first.games.map((row) => [row.id, row.seven_years]),
      );
      assertEquals(history.get(world.rows.game[0].id), false, latest);
      assertEquals(history.get(world.rows.game[1].id), true, latest);
      assertEquals(history.get(world.rows.game[2].id), true, latest);
      assertEquals(visible(first), await inputs(monthlyRatings.queries, lake));
      assertEquals(await inputs(ratings.queries, lake), first);
    }
  },
});

Deno.test({
  name:
    "an unplayed fixture the provider withdrew is no game to simulate and keeps no group live",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A SofaScore update marks cancelled, abandoned and awarded fixtures
    // without a score; projecting them as pending would invent results and
    // hold a finished group open.
    const world = new World();
    const phase = world.phases["2026"];
    const pending = world.rows.game.filter((g) =>
      g.phase_id === phase && g.played === "false"
    );
    const [cancelled, abandoned, awarded, ...rest] = pending;
    cancelled.sync_status = "cancelled";
    abandoned.sync_status = "abandoned";
    awarded.sync_status = "awarded";
    rest[0].sync_status = "postponed";
    const before = await inputs(chances.queries, await world.lake());
    const ids = (before.games as { id: string }[]).map((g) => g.id);
    for (const g of [cancelled, abandoned, awarded]) {
      assertEquals(ids.includes(g.id as string), false);
    }
    assertEquals(ids.includes(rest[0].id as string), true);
    const group = world.groups["2026"];
    const live = (rows: Record<string, unknown[]>) =>
      (rows.groups as { id: string; live: boolean }[]).find((g) => g.id === group)!.live;
    assertEquals(live(before), true);
    for (const g of rest) g.sync_status = "cancelled";
    assertEquals(live(await inputs(chances.queries, await world.lake())), false);
  },
});
