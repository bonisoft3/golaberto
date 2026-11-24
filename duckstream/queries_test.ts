import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import * as teamRatings from "../computations/team_ratings.js";
import * as playerRatings from "../computations/player_ratings.js";
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
    const legacyRatings = await inputs(monthlyRatings.queries, lake);
    const actualTeam = await inputs(teamRatings.queries, lake);
    const actualPlayer = visible(await inputs(playerRatings.queries, lake));
    assertEquals(
      actualTeam.games,
      legacyRatings.games.filter((g) => g.seven_years).map(({
        phase_id: _p,
        seven_years: _s,
        recent: _r,
        ...rest
      }) => rest),
    );
    assertEquals(actualTeam.teams, legacyRatings.teams);
    assertEquals(
      actualPlayer.games,
      legacyRatings.games.filter((g) => g.recent).map(({
        phase_id: _p,
        home_score: _hs,
        away_score: _as,
        away_aet: _aa,
        seven_years: _s,
        recent: _r,
        ...rest
      }) => rest),
    );
    assertEquals(actualPlayer.cutoff, legacyRatings.cutoff);
    assertEquals(actualPlayer.teams, legacyRatings.teams);
    assertEquals(actualPlayer.players, legacyRatings.players);
    assertEquals(actualPlayer.appearances, legacyRatings.appearances);
    assertEquals(actualPlayer.goals, legacyRatings.goals);
    assertEquals(
      visible(await inputs(chances.queries, lake)),
      await inputs(oldChances.queries, lake),
    );
    for (
      const program of [teamRatings, playerRatings, chances] as const
    ) {
      const captured = await inputs(program.queries, lake);
      const shuffled = Object.fromEntries(
        Object.entries(captured).map(([key, rows]) => [key, [...rows].reverse()]),
      );
      assertEquals(program.plan(shuffled, 17, []), program.plan(captured, 17, []));
    }
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
    assertEquals((await inputs(teamRatings.queries, lake)).games, []);
    const players = visible(await inputs(playerRatings.queries, lake));
    assertEquals(players.games, []);
    assertEquals(players.appearances, []);
    assertEquals(players.goals, []);
  },
});

Deno.test("Golaberto programs and native descriptors are generated from admitted Duckstream SQL", async () => {
  for (
    const name of [
      "team_ratings",
      "player_ratings",
      "chances",
      "cards",
      "standings",
      "player_stats",
    ] as const
  ) {
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

Deno.test({
  name: "calendar 7-year boundary preserves its declared monthly policy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const world = calendarWorld(7);
    const lake = await world.lake();
    const legacy = await inputs(monthlyRatings.queries, lake);
    const actual = await inputs(teamRatings.queries, lake);
    assertEquals(
      actual.games.some((row) => row.id === world.rows.game[0].id),
      true,
    );
    assertEquals(
      actual.games.map((g) => g.id),
      legacy.games.filter((g) => g.seven_years).map((g) => g.id),
    );
  },
});

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
    const ratings = world.teams.map((team_id, i) => ({
      id: uid(12, i),
      team_id,
      measure_date: "2026-04-01",
      offense: "1.25",
      defense: "0.95",
      rating: "50",
    }));
    world.rows.team_rating = ratings;
    const baseline = await world.lake();
    const expectedTeam = await inputs(teamRatings.queries, baseline);
    const expectedPlayer = await inputs(playerRatings.queries, baseline);
    const expectedChances = await inputs(chances.queries, baseline);
    for (const available of [teams.slice(1), []]) {
      world.rows.team = available;
      world.rows.player = [];
      const lake = await world.lake();
      const known = new Set(available.map((t) => t.id));
      for (const prog of [teamRatings, playerRatings] as const) {
        const captured = await inputs(prog.queries, lake);
        assertEquals(
          captured.games.every((g) =>
            known.has(String(g.home_id)) && known.has(String(g.away_id))
          ),
          true,
        );
        prog.plan(captured, 17, []);
      }
      const capturedPlayers = await inputs(playerRatings.queries, lake);
      assertEquals(capturedPlayers.goals, []);
      assertEquals(capturedPlayers.appearances, []);
      const odds = await inputs(chances.queries, lake);
      assertEquals(odds.groups, []);
      assertEquals(chances.plan(odds, 17), []);
      chances.finish(odds, []);
    }
    world.rows.team = teams;
    world.rows.player = players;
    world.rows.team_rating = [];
    const unratedPlayers = await inputs(playerRatings.queries, await world.lake());
    assertEquals(unratedPlayers.games, []);
    assertEquals(unratedPlayers.appearances, []);
    assertEquals(playerRatings.plan(unratedPlayers, 17, []), []);
    world.rows.team_rating = ratings;
    const restored = await world.lake();
    assertEquals(await inputs(teamRatings.queries, restored), expectedTeam);
    assertEquals(await inputs(playerRatings.queries, restored), expectedPlayer);
    assertEquals(await inputs(chances.queries, restored), expectedChances);
    teamRatings.plan(expectedTeam, 17, []);
    playerRatings.plan(expectedPlayer, 17, []);
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
      const first = await inputs(teamRatings.queries, lake);
      const ids = new Set(first.games.map((row) => row.id));
      assertEquals(ids.has(world.rows.game[0].id), false, latest);
      assertEquals(ids.has(world.rows.game[1].id), true, latest);
      assertEquals(ids.has(world.rows.game[2].id), true, latest);
      assertEquals(await inputs(teamRatings.queries, lake), first);
    }
  },
});

Deno.test({
  name:
    "an unplayed fixture the provider withdrew is no game to simulate and keeps no group live",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
