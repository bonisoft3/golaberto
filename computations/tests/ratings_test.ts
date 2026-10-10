// The ratings computation over a small lake, and the chances reading what it writes.

import { assert, assertEquals } from "@std/assert";
import { runWasm } from "@mecha/compute/wasi.ts";
import * as chances from "../chances.js";
import * as ratings from "../ratings.js";
import { compute, inputs, odds, type Out } from "./compute.ts";
import { type Row, World } from "./world.ts";

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });

const world = new World();
let computed: Out | undefined;
const once = async () => (computed ??= await compute("ratings", await world.lake()));

const professional = (w: World) =>
  w.rows.game.filter((g) => [w.phases["2021"], w.phases["2026"]].includes(g.phase_id!) && g.played === "true");

const seconds = (day: string) => Date.parse(`${day}Z`.replace(" ", "T")) / 1000;

test("team ratings are the persisted historic series", async () => {
  const rows = (await once()).team_rating;
  // By hand from the rows: the request Rails builds, through the wasm.
  const games = professional(world);
  const at = (g: Row) => seconds(g.kickoff ? g.kickoff.slice(0, 19) : `${g.day} 00:00:00`);
  games.sort((a, b) => at(a) - at(b) || (a.id! < b.id! ? -1 : 1));
  const teams = [...world.teams].sort();
  const phases = [...new Set(games.map((g) => g.phase_id!))].sort();
  const HOME_ADV = 0.16133676871779334;
  const request = {
    games: games.map((g) => {
      const length = g.home_aet === null ? 1 : 4 / 3;
      return {
        phase_id: phases.indexOf(g.phase_id!) + 1,
        home_id: teams.indexOf(g.home_id!) + 1,
        away_id: teams.indexOf(g.away_id!) + 1,
        home_score: (Number(g.home_score) + Number(g.home_aet ?? 0)) / length,
        away_score: (Number(g.away_score) + Number(g.away_aet ?? 0)) / length,
        timestamp: at(g),
        length,
        advantage: { left: HOME_ADV, neutral: 0, right: -HOME_ADV }[g.home_field as "left"],
      };
    }),
    ratings: teams.map((_, i) => ({ id: i + 1, offense: 0, defense: 0, team: 0 })),
    phases_to_eval: [],
  };
  type Raw = { team_id: number; measure_date: string; off_rating: number; def_rating: number; rating: number };
  const raw: Raw[] = JSON.parse(new TextDecoder().decode(
    runWasm(odds, new TextEncoder().encode(JSON.stringify({ op: "historic", request })), "golaberto-odds"),
  ));
  // The upsert keeps a team's last row of a day, to six decimals.
  const last = new Map(raw.map((r) => [`${r.team_id} ${r.measure_date}`, r]));
  const expected = [...last.values()]
    .sort((a, b) => a.team_id - b.team_id || (a.measure_date < b.measure_date ? -1 : 1))
    .map((r) => [teams[r.team_id - 1], r.measure_date, ...[r.off_rating, r.def_rating, r.rating].map((v) => Number(v.toFixed(6)))]);
  assertEquals(rows.map((r) => [r.team_id, r.measure_date, r.offense, r.defense, r.rating]), expected);
  assertEquals(new Set(rows.map((r) => r.id)).size, rows.length);
  assert(rows.length > 0 && rows.every((r) => 0 <= r.rating && r.rating <= 100));
  // Every team that played the last four years is rated as of the last game.
  const lastDay = games.map((g) => g.day!).sort().at(-1);
  assertEquals(new Set(rows.filter((r) => r.measure_date === lastDay).map((r) => r.team_id)), new Set(world.teams));
});

test("player ratings cover who played and only them", async () => {
  const rows = (await once()).player_rating;
  const recent = new Set(professional(world).filter((g) => g.day! >= "2026").map((g) => g.id));
  assertEquals(
    new Set(rows.map((r) => r.id)),
    new Set(world.rows.player_game.filter((a) => recent.has(a.game_id)).map((a) => a.player_id)),
  );
  assert(rows.every((r) => [r.rating, r.off_rating, r.def_rating].every(
    (value) => Number.isFinite(value) && Math.fround(value) === value,
  )));
  assert(new Set(rows.map((r) => r.rating)).size > rows.length / 2);
});

test("an evaluation per professional phase", async () => {
  const rows = (await once()).rating_eval;
  assertEquals(new Set(rows.map((r) => r.id)), new Set([world.phases["2021"], world.phases["2026"]]));
  assert(rows.every((r) => 0 <= r.rps && r.rps <= 1));
});

test("ratings are a function of the lake, not the seed", async () => {
  assertEquals(await compute("ratings", await world.lake(), "another"), await once());
});

test("no professional game, no rows", async () => {
  const w = new World();
  w.rows.game = w.rows.game.filter((g) => g.phase_id === w.phases["2026-sub20"]);
  assertEquals(await compute("ratings", await w.lake()), { team_rating: [], player_rating: [], rating_eval: [] });
});

test("the chances price games with the ratings", async () => {
  const teamRating = (await once()).team_rating.map((r) => ({
    ...r,
    offense: `${r.offense}`,
    defense: `${r.defense}`,
    rating: `${r.rating}`,
  }));
  const jobs = chances.plan(await inputs(chances.queries, await world.lake({ team_rating: teamRating })), 17);
  assertEquals(jobs.length, 1);
  const left = (jobs[0].input.request.games as { played: boolean; home_power: number | null }[]).filter((g) => !g.played);
  assert(left.length > 0 && left.every((g) => g.home_power !== null && 0.01 <= g.home_power && g.home_power <= 10));
});

test("windows count calendar years", async () => {
  // Rails' `- n.years` keeps the day, but for a 29 February missing from
  // the year it lands in, which falls to the 28th.
  const w = new World();
  const template = w.rows.game.find((g) => g.phase_id === w.phases["2026"] && g.played === "true")!;
  const days: Record<string, string> = {
    "2024-02-29": w.phases["2026"],
    "2017-02-28": w.phases["2021"],
    "2017-02-27": w.phases["2021"],
    "2020-03-01": w.phases["2026"],
  };
  const id = (day: string) => `00000013-0000-4000-8000-0000${day.replaceAll("-", "")}`;
  w.rows.game = Object.entries(days).map(([day, phase]) => ({ ...template, id: id(day), day, kickoff: null, phase_id: phase }));
  const { games, phases } = await inputs(ratings.queries, await w.lake());
  assertEquals(
    Object.fromEntries(games.map((g) => [g.id, g.seven_years])),
    Object.fromEntries(Object.keys(days).map((d) => [id(d), d !== "2017-02-27"])),
  );
  assertEquals(Object.fromEntries(phases.map((p) => [p.id, [p.since, p.until]])), {
    [w.phases["2021"]]: [seconds("2013-02-27 00:00:00"), seconds("2017-02-28 00:00:00")],
    [w.phases["2026"]]: [seconds("2016-03-01 00:00:00"), seconds("2024-02-29 00:00:00")],
  });
});
