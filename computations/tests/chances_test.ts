// The chances computation over a small lake: the /odds request it builds, as
// Rails' Group#odds does, and the sinks it maps the estimate to.

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import * as chances from "../chances.js";
import { compute, inputs, type Out, type Sink } from "./compute.ts";
import { type Row, uid, World } from "./world.ts";

const AVG_BASE = 1.3350257653834494;
const HOME_ADV = 0.16133676871779334;
const SCALE = AVG_BASE * 0.424 + 0.548;

type Request = {
  phase: { sort: string; championship: Record<string, number> };
  team_groups: { team_id: number; add_sub: number }[];
  zones: { position: number[] }[];
  games: { id: number; home_power: number | null; away_power: number | null; played: boolean }[];
};
type Job = { wasm: string; input: { op: string; request: Request; seed: number } };

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });

const world = new World();

const rating = (team: string, day: string, offense: number, defense: number): Row => ({
  id: uid(12, Number.parseInt(team.slice(-12), 16) * 100000 + Number(day.replaceAll("-", "")) % 100000),
  team_id: team,
  measure_date: day,
  offense: `${offense}`,
  defense: `${defense}`,
  rating: "50",
});

/** The world with ratings for every team on 2026-04-01, and others dated
 * 2026-05-24, a day some games left kick off on and some are known only by. */
const rated = () =>
  world.lake({
    team_rating: [
      ...world.teams.map((t, i) => rating(t, "2026-04-01", 1.2 + 0.1 * i, 1.4 - 0.05 * i)),
      ...world.teams.map((t, i) => rating(t, "2026-05-24", 2.5 - 0.1 * i, 0.5 + 0.05 * i)),
    ],
  });

let computed: Out | undefined;
const once = async () => (computed ??= await compute("chances", await rated()));

const of = (rows: Sink[], group: string) => rows.filter((r) => r.group_id === group);

const plan = (given: Record<string, unknown[]>) => chances.plan(given, 17) as Job[];

/** One live group of two teams and a game between them, priced from `game`. */
function priced(game: Record<string, unknown>) {
  const [h, a] = [uid(1, 1), uid(1, 2)];
  const member = (team: string, position: number) => ({
    group_id: "g",
    team_id: team,
    name: team,
    add_sub: 0,
    bias: 0,
    position,
    points: 0,
    played: 0,
  });
  const [{ input }] = plan({
    groups: [{ id: "g", live: true, sort: "pt", bonus_points: 0, bonus_points_threshold: 0, win: 3, draw: 1, loss: 0 }],
    members: [member(h, 1), member(a, 2)],
    games: [{
      group_id: "g",
      id: "x",
      home_id: h,
      away_id: a,
      home_field: "left",
      played: false,
      home_score: 0,
      away_score: 0,
      ...game,
    }],
    zones: [],
  });
  const [x] = input.request.games;
  return [x.home_power, x.away_power];
}

test("powers follow Rails' Game#home_power", async () => {
  // Game#home_power for offense 1.6 against defense 1.1 at home, by hand:
  // (1.6 - AVG_BASE) / (AVG_BASE * 0.424 + 0.548) = 0.23784750659410223,
  // scaled by (1.1 + HOME_ADV) * 0.424 + 0.548 = 1.0828067899363445,
  // plus the defense and the advantage.
  const [home, away] = priced({ home_off: 1.6, home_def: 0.9, away_off: 1.0, away_def: 1.1 });
  assertAlmostEquals(home!, 0.23784750659410223 * 1.0828067899363445 + 1.1 + HOME_ADV, 1e-15);
  // The away side's defense loses the advantage, where the ratings' own
  // power (and /eval) would add it.
  const scale = (0.9 - HOME_ADV) * 0.424 + 0.548;
  assertAlmostEquals(away!, (1.0 - AVG_BASE) / SCALE * scale + 0.9 - HOME_ADV, 1e-15);
});

test("powers floor the scale and clamp", async () => {
  // A defense of -0.8 makes the scale 0.2088: Rails floors it at 0.25, which
  // gives 0.2468… where the unfloored scale would give 0.0743….
  const neutral = { home_field: "neutral" };
  assertAlmostEquals(priced({ ...neutral, home_off: 6, home_def: 1, away_off: 1, away_def: -0.8 })[0]!, 0.24684941503362756, 1e-14);
  assertEquals(priced({ ...neutral, home_off: 30, home_def: 1, away_off: 0, away_def: 1 }), [10, 0.01]);
  // No rating, no power.
  assertEquals(priced({ ...neutral, home_off: null, home_def: 1, away_off: 1, away_def: 1 }), [null, null]);
});

test("the request is Rails' Group#odds", async () => {
  const jobs = plan(await inputs(chances.queries, await world.lake()));
  // Only groups with games left are asked about.
  assertEquals(jobs.length, 1);
  const [{ wasm, input: { op, request } }] = jobs;
  assertEquals([wasm, op], ["golaberto-odds", "odds"]);
  assertEquals(request.phase.sort, "pt,w,gd,gf,name");
  assertEquals(request.phase.championship, { point_win: 3, point_draw: 1, point_loss: 0 });
  // Team groups in name order, numbered in uuid order.
  const names = Object.fromEntries(world.rows.team.map((t) => [t.id, t.name]));
  const teams = [...world.teams].sort();
  assertEquals(request.team_groups.map((t) => names[teams[t.team_id - 1]]), Object.values(names).sort());
  assertEquals(request.team_groups.map((t) => t.add_sub).sort(), [-3, 0, 0, 0, 0, 0]);
  assertEquals(request.zones, [{ position: [1] }, { position: [1, 2] }, { position: [5, 6] }]);
  assertEquals([request.games.length, request.games.filter((g) => !g.played).length], [30, 10]);
  // Without a rating before the game, Rails sends no power: the estimator reads 0.
  assert(request.games.every((g) => g.home_power === null && g.away_power === null));
});

test("sparse zones aggregate only their exact positions", async () => {
  const teams = [1, 2, 3, 4].map((n) => uid(1, n));
  const given = {
    groups: [{ id: "g", live: true, sort: "pt", bonus_points: 0, bonus_points_threshold: 0, win: 3, draw: 1, loss: 0 }],
    members: teams.map((team, index) => ({
      group_id: "g", team_id: team, name: team, add_sub: 0, bias: 0, position: index + 1, points: 0, played: 0,
    })),
    games: [],
    zones: [{ group_id: "g", id: "sparse", first: 1, last: 3, positions: "1,3", color: "qualify" }],
  };
  const [{ input: { request } }] = plan(given);
  assertEquals(request.zones, [{ position: [1, 3] }]);
  const percentages = [[45, 30, 20, 5], [25, 35, 25, 15], [20, 20, 30, 30], [10, 15, 25, 50]];
  const response = {
    team_odds: Object.fromEntries(percentages.map((row, index) => [index + 1, { Pos: row }])),
    game_importance: {},
    rare_position_estimates: Object.fromEntries(teams.map((_, index) => [
      index + 1,
      Object.fromEntries([0, 1, 2, 3].map((position) => [position, { reachability: "reachable" }])),
    ])),
  };
  const out = chances.finish(given, [response]) as Out;
  const zones = of(out.zone_chance, "g");
  assertEquals(zones.map((row) => row.percent), percentages.map((row) => row[0] + row[2]));
  assertEquals(zones.reduce((sum, row) => sum + (row.percent as number), 0), 200);
});

test("zones beyond current membership stay impossible without stopping other groups", async () => {
  const teams = [1, 2, 3, 4].map((n) => uid(1, n));
  for (const live of [false, true]) {
    const given = {
      groups: [{ id: "g", live, sort: "pt", bonus_points: 0, bonus_points_threshold: 0, win: 3, draw: 1, loss: 0 }, { id: "h", live: false }],
      members: teams.map((team, index) => ({
        group_id: index < 3 ? "g" : "h", team_id: team, name: team, add_sub: 0, bias: 0,
        position: index < 3 ? index + 1 : 1, points: 0, played: 0,
      })),
      games: [],
      zones: [
        { group_id: "g", id: "range", first: 1, last: 4, positions: "", color: "qualify" },
        { group_id: "g", id: "sparse", first: 1, last: 4, positions: "1,4", color: "promotion" },
        { group_id: "g", id: "outside", first: 4, last: 5, positions: "4,5", color: "relegation" },
        { group_id: "g", id: "outside-range", first: 4, last: 5, positions: "", color: "relegation" },
        // Two or more past the membership: an inverted range once threw instead of being empty.
        { group_id: "g", id: "far-range", first: 6, last: 7, positions: "", color: "relegation" },
      ],
    };
    const percentages = [[100, 0, 0], [0, 100, 0], [0, 0, 100]];
    const response = {
      team_odds: Object.fromEntries(percentages.map((row, index) => [index + 1, { Pos: row }])),
      game_importance: {},
      rare_position_estimates: Object.fromEntries(percentages.map((row, index) => [index + 1,
        Object.fromEntries(row.map((value, position) => [position, { reachability: value ? "reachable" : "impossible" }])),
      ])),
    };
    if (live) {
      const [{ input: { request } }] = plan(given);
      assertEquals(request.zones, [{ position: [1, 2, 3] }, { position: [1] }, { position: [] }, { position: [] }, { position: [] }]);
    }
    const out = chances.finish(given, live ? [response] : []) as Out;
    assertEquals(out.team_chance.length, 4);
    assertEquals(of(out.position_chance, "h").map((row) => row.percent), [100]);
    assertEquals(of(out.zone_chance, "g").map((row) => [row.percent, row.reach]), [
      [100, ""], [100, ""], [0, "impossible"], [0, "impossible"], [0, "impossible"],
      [100, ""], [0, "impossible"], [0, "impossible"], [0, "impossible"], [0, "impossible"],
      [100, ""], [0, "impossible"], [0, "impossible"], [0, "impossible"], [0, "impossible"],
    ]);
    if (live) {
      response.team_odds[1].Pos.pop();
      assertThrows(() => chances.finish(given, [response]), RangeError, "position 3 is missing");
    }
  }
  const partial = new World();
  partial.rows.zone = partial.rows.zone.map((zone) => ({ ...zone, positions: "7,8" }));
  const out = await compute("chances", await partial.lake());
  assert(out.zone_chance.length > 0);
  assert(out.zone_chance.every((row) => row.percent === 0 && row.reach === "impossible"));
});

test("powers read the latest rating before the game, in f32", async () => {
  const lake = await rated();
  const [{ input: { request } }] = plan(await inputs(chances.queries, lake));
  const group = await lake.query(
    `SELECT g.id::VARCHAR AS id FROM game g WHERE g.phase_id = '${world.phases["2026"]}' ORDER BY
       coalesce(epoch(kickoff::TIMESTAMPTZ), epoch(day::DATE)), 1`,
  );
  const rows = Object.fromEntries(world.rows.game.map((g) => [g.id, g]));
  const onTheDay: boolean[] = [];
  request.games.forEach((g, i) => {
    const row = rows[group[i].id as string];
    const [home, away] = [world.teams.indexOf(row.home_id!), world.teams.indexOf(row.away_id!)];
    // A rating counts from a kickoff later its day, not for a game known only by that day.
    const late = row.day! > "2026-05-24" || (row.day === "2026-05-24" && row.kickoff !== null);
    if (row.day === "2026-05-24") onTheDay.push(row.kickoff === null);
    const off = [home, away].map((t) => Math.fround(late ? 2.5 - 0.1 * t : 1.2 + 0.1 * t));
    const de = [home, away].map((t) => Math.fround(late ? 0.5 + 0.05 * t : 1.4 - 0.05 * t));
    const advantage = row.home_field === "neutral" ? 0 : HOME_ADV;
    const side = (o: number, d: number) =>
      Math.min(Math.max((o - AVG_BASE) / SCALE * Math.max(0.25, d * 0.424 + 0.548) + d, 0.01), 10);
    assertEquals([g.home_power, g.away_power], [side(off[0], de[1] + advantage), side(off[1], de[0] - advantage)]);
  });
  assert(onTheDay.includes(true) && onTheDay.includes(false));
});

test("the sinks hold the estimate", async () => {
  const out = await once();
  const group = world.groups["2026"];
  const teams = of(out.team_chance, group);
  assertEquals(teams.map((r) => r.rank).sort(), [1, 2, 3, 4, 5, 6]);
  assertEquals(new Set(teams.map((r) => r.team_id)), new Set(world.teams));
  const positions = of(out.position_chance, group);
  assertEquals([positions.length, new Set(positions.map((r) => r.id)).size], [36, 36]);
  const p = world.teams.map(() => Array(6).fill(0));
  for (const r of positions) {
    p[world.teams.indexOf(r.team_id as string)][(r.position as number) - 1] = r.percent;
    const rank = teams.find((t) => t.team_id === r.team_id)!.rank;
    assertEquals(r.current, r.position === rank);
  }
  // Rounded to cents, a row and a column each still make the whole.
  for (let i = 0; i < 6; i++) {
    assertAlmostEquals(p[i].reduce((s, x) => s + x, 0), 100, 0.03);
    assertAlmostEquals(p.reduce((s, row) => s + row[i], 0), 100, 0.03);
  }
  const byZone: Record<string, number> = {};
  for (const z of of(out.zone_chance, group)) {
    const row = p[world.teams.indexOf(z.team_id as string)];
    assertAlmostEquals(z.percent as number, row.slice((z.first as number) - 1, z.last as number).reduce((s, x) => s + x), 0.02);
    byZone[`${z.first}-${z.last}`] = (byZone[`${z.first}-${z.last}`] ?? 0) + (z.percent as number);
  }
  // Each zone holds as many teams as positions.
  assertEquals(Object.keys(byZone).length, 3);
  for (const [zone, total] of Object.entries(byZone)) {
    const [first, last] = zone.split("-").map(Number);
    assertAlmostEquals(total, 100 * (last - first + 1), 0.05);
  }
  const band = (x: number) => (x < 0.5 ? 0 : x < 5 ? 1 : x < 20 ? 2 : x < 50 ? 3 : 4);
  assert([...positions, ...of(out.zone_chance, group)].every((r) => r.band === band(r.percent as number)));
});

test("rank, points and played are the standing's", async () => {
  const group = world.groups["2026"];
  const standing = world.standing().filter((r) => r.group_id === group);
  assertEquals(
    Object.fromEntries(of((await once()).team_chance, group).map((r) => [r.team_id, [r.rank, r.points, r.played]])),
    Object.fromEntries(standing.map((s) => [s.team_id, [Number(s.position), Number(s.points), Number(s.played)]])),
  );
  // The add_sub counts in the points the standing holds.
  const last = standing.find((s) => s.team_id === world.teams[5])!;
  assert(Number(last.points) < 3 * Number(last.played));
});

test("rank follows the standings' ladder, not points", async () => {
  // The standing ranks by the phase's ladder, which may set a team below one
  // with fewer points (head to head, a bias): chances used to re-rank by
  // points, wins and goals, and showed a table the standings did not.
  const group = world.groups["2026"];
  const reversed = world.standing().map((r) => (r.group_id === group ? { ...r, position: `${7 - Number(r.position)}` } : r));
  const out = await compute("chances", await world.lake({ standing: reversed }));
  const rank = Object.fromEntries(reversed.filter((r) => r.group_id === group).map((r) => [r.team_id, Number(r.position)]));
  assertEquals(Object.fromEntries(of(out.team_chance, group).map((r) => [r.team_id, r.rank])), rank);
  assert(of(out.position_chance, group).every((r) => r.current === (r.position === rank[r.team_id as string])));
});

test("a group the standing does not rank has no chances", async () => {
  const group = world.groups["2026"];
  // A member without its standing row, and a team that left keeping one.
  const partial = world.standing().filter((r) => !(r.group_id === group && r.team_id === world.teams[0]));
  const out = await compute("chances", await world.lake({ standing: partial }));
  assertEquals([of(out.team_chance, group), out.game_importance], [[], []]);
  const gone = uid(1, 99);
  const old = world.groups["2021"];
  const stale = [
    ...world.standing(),
    { id: `${old}:${gone}`, group_id: old, team_id: gone, position: "3", points: "0", played: "0" },
  ];
  assertEquals(of((await compute("chances", await world.lake({ standing: stale }))).team_chance, old).length, 6);
});

test("a finished group is its final table", async () => {
  const out = await once();
  for (const name of ["2021", "2026-sub20"]) {
    const group = world.groups[name];
    const rank = Object.fromEntries(
      world.standing().filter((r) => r.group_id === group).map((r) => [r.team_id, Number(r.position)]),
    );
    assertEquals(Object.fromEntries(of(out.team_chance, group).map((r) => [r.team_id, r.rank])), rank);
    const positions = of(out.position_chance, group);
    assertEquals(positions.length, 36);
    for (const r of positions) {
      const final = r.position === rank[r.team_id as string];
      assertEquals([r.percent, r.band, r.current], final ? [100, 4, true] : [0, 0, false]);
    }
    const zones = of(out.zone_chance, group);
    assertEquals(zones.length, 18);
    const inside = (z: Sink) => (z.first as number) <= rank[z.team_id as string] && rank[z.team_id as string] <= (z.last as number);
    assert(zones.every((z) => z.percent === (inside(z) ? 100 : 0)));
  }
});

test("the last result turns the chances into the final table", async () => {
  // The rows a group had while live are replaced by its final table, and its
  // games' importance rows are no longer produced, so the service deletes them.
  const w = new World();
  for (const g of w.rows.game) if (w.left.includes(g.id!)) Object.assign(g, { played: "true", home_score: "1", away_score: "0" });
  const out = await compute("chances", await w.lake());
  assertEquals(out.game_importance, []);
  const positions = of(out.position_chance, w.groups["2026"]);
  assertEquals(positions.map((r) => r.percent).sort((a, b) => (a as number) - (b as number)), [
    ...Array(30).fill(0),
    ...Array(6).fill(100),
  ]);
  assertEquals(new Set(positions.map((r) => r.id)), new Set(of((await once()).position_chance, w.groups["2026"]).map((r) => r.id)));
});

test("a played game leaves the importance", async () => {
  const w = new World();
  const played = w.left[0];
  Object.assign(w.rows.game.find((g) => g.id === played)!, { played: "true", home_score: "2", away_score: "2" });
  const out = await compute("chances", await w.lake());
  assertEquals(new Set(out.game_importance.map((r) => r.id)), new Set(w.left.slice(1)));
});

test("game importance covers the games left", async () => {
  const rows = (await once()).game_importance;
  assertEquals(new Set(rows.map((r) => r.id)), new Set(world.left));
  for (const r of rows) {
    assertEquals(Object.keys(r).sort(), ["away", "home", "id"]);
    assert([r.home, r.away].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0));
  }
});

test("a cell that shows 0 says whether it can still be reached", async () => {
  const out = await once();
  for (const r of [...out.position_chance, ...out.zone_chance]) {
    assertEquals(r.reach === "", r.percent !== 0, `${r.id} shows ${r.percent} with reach "${r.reach}"`);
  }
  // Ten games left leave the live group positions its points already rule out.
  assert(of(out.position_chance, world.groups["2026"]).some((r) => r.reach === "impossible"));
  // A finished group's other positions are out of reach.
  for (const name of ["2021", "2026-sub20"]) {
    assert([...of(out.position_chance, world.groups[name]), ...of(out.zone_chance, world.groups[name])]
      .every((r) => r.percent !== 0 || r.reach === "impossible"));
  }
});

/** finish over one live group of four teams, its zones 1–2 and 3–4, and an
 * answer whose cells carry `statuses` beside `pct`. */
function reached(pct: number[][], statuses: (string | undefined)[][]) {
  const teams = [1, 2, 3, 4].map((n) => uid(1, n));
  const given = {
    groups: [{ id: "g", live: true, sort: "pt", bonus_points: 0, bonus_points_threshold: 0, win: 3, draw: 1, loss: 0 }],
    members: teams.map((team, i) => ({ group_id: "g", team_id: team, name: team, add_sub: 0, bias: 0, position: i + 1, points: 0, played: 0 })),
    games: [{
      group_id: "g", id: "x", home_id: teams[0], away_id: teams[1], home_field: "left", played: false,
      home_score: 0, away_score: 0, home_off: null, home_def: null, away_off: null, away_def: null,
    }],
    zones: [
      { group_id: "g", id: "top", first: 1, last: 2, color: "promotion" },
      { group_id: "g", id: "bottom", first: 3, last: 4, color: "relegation" },
    ],
  };
  const answer = {
    team_odds: Object.fromEntries(pct.map((row, t) => [t + 1, { Pos: row }])),
    game_importance: {},
    rare_position_estimates: Object.fromEntries(
      statuses.map((row, t) => [t + 1, Object.fromEntries(row.map((reachability, r) => [r, { reachability }]))]),
    ),
  };
  const out = chances.finish(given, [answer]) as Out;
  const byTeam = (rows: Sink[]) => teams.map((team) => rows.filter((r) => r.team_id === team).map((r) => r.reach));
  return { positions: byTeam(out.position_chance), zones: byTeam(out.zone_chance) };
}

test("a zero's reach is upstream's: an estimate under the cent or a witness is reachable, all proofs impossible, else undecided", async () => {
  const [R, I, U] = ["reachable", "impossible", "undecided"];
  const { positions, zones } = reached(
    [[99.999, 0.001, 0, 0], [0, 0, 60, 40], [0, 0, 40, 60], [0, 100, 0, 0]],
    [[R, R, I, I], [U, I, R, R], [R, I, R, R], [I, R, I, I]],
  );
  assertEquals(positions, [["", R, I, I], [U, I, "", ""], [R, I, "", ""], [I, "", I, I]]);
  // A zone is out of reach only when each of its positions is; one proved
  // reachable makes it so.
  assertEquals(zones, [["", I], [U, ""], [R, ""], ["", I]]);
});

test("an answer without a cell's reachability fails the run", async () => {
  const R = "reachable";
  assertThrows(() => reached([[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 100, 0], [0, 0, 0, 100]], [[R, R, R, R], [R, R, R, R], [R, R, undefined, R], [R, R, R, R]]), RangeError);
});

test("a seed is an answer", async () => {
  assertEquals(await compute("chances", await rated()), await once());
});
