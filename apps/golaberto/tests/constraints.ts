// The archive's shape, graded where it is enforced: each case runs in the
// running cluster's Postgres inside a transaction that is rolled back, so the
// database is left as it was found. A case is a test pair of the ir.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";

const psql = async (sql: string) => {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = out.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`BEGIN;\n${sql}\nROLLBACK;\n`));
  await writer.close();
  const { success, stdout, stderr } = await out.output();
  return { success, stdout: new TextDecoder().decode(stdout).trim(), stderr: new TextDecoder().decode(stderr).trim() };
};

const kept = async (sql: string) => {
  const r = await psql(sql);
  assert(r.success, `refused: ${r.stderr}`);
  return r.stdout;
};

// Named, because any other check a fixture trips refuses the script just as well.
const refused = async (sql: string, constraint: string) => {
  const r = await psql(sql);
  assert(!r.success, `accepted what should be refused: ${sql}`);
  assertStringIncludes(r.stderr, `violates check constraint "${constraint}"`);
};

const CHAMPIONSHIP = "aaaaaaaa-0000-4000-8000-000000000001";
const PHASE = "aaaaaaaa-0000-4000-8000-000000000002";
const HOME = "aaaaaaaa-0000-4000-8000-000000000003";
const AWAY = "aaaaaaaa-0000-4000-8000-000000000004";
const GROUP = "aaaaaaaa-0000-4000-8000-000000000005";
const PLAYER = "aaaaaaaa-0000-4000-8000-000000000006";

// Read back through RETURNING: the cluster's database may already hold rows.
const championship = `INSERT INTO championship (id, name, region_name, begins, ends)
  VALUES ('${CHAMPIONSHIP}', 'Campeonato Brasileiro', 'Brasil', '2026-01-28', '2026-12-02')`;
const fixtures = `${championship};
INSERT INTO phase (id, championship_id, name) VALUES ('${PHASE}', '${CHAMPIONSHIP}', 'Turno e Returno');
INSERT INTO team (id, name, country) VALUES ('${HOME}', 'Flamengo-RJ', 'Brasil'), ('${AWAY}', 'Palmeiras-SP', 'Brasil');`;
const game = (cols: string, vals: string, away = AWAY) =>
  `INSERT INTO game (phase_id, day, home_id, away_id${cols}) VALUES ('${PHASE}', '2026-10-01', '${HOME}', '${away}'${vals})`;

// A goal on a played game between the fixtures' two teams.
const goal = (cols: string, vals: string) =>
  `${fixtures}\n${game(", played, home_score, away_score", ", true, 1, 0")} RETURNING id \\gset\nINSERT INTO player (id, name) VALUES ('${PLAYER}', 'Pedro');\nINSERT INTO goal (game_id, player_id, minute${cols}) VALUES (:'id', '${PLAYER}', 30${vals});`;

Deno.test("test-score-whole: a half-typed score is refused", async () => {
  await refused(`${fixtures}\n${game(", played, home_score", ", true, 2")};`, "game_check");
});

Deno.test("test-played-game: a played game with both scores is kept as given", async () => {
  assertEquals(await kept(`${fixtures}\n${game(", played, home_score, away_score", ", true, 2, 1")} RETURNING home_score || '-' || away_score;`), "2-1");
});

Deno.test("test-no-self-game: a team never plays itself", async () => {
  await refused(`${fixtures}\n${game("", "", HOME)};`, "game_check");
});

Deno.test("test-points-default: three, one and none", async () => {
  assertEquals(await kept(`${championship} RETURNING point_win || ',' || point_draw || ',' || point_loss;`), "3,1,0");
});

Deno.test("test-season-single: a season inside one year reads as that year", async () => {
  assertEquals(await kept(`${championship} RETURNING season;`), "2026");
});

Deno.test("test-season-span: a season across two years reads as both", async () => {
  assertEquals(
    await kept(`INSERT INTO championship (name, region_name, begins, ends) VALUES ('Premier League', 'Inglaterra', '2026-08-21', '2027-05-30') RETURNING season || '|' || full_name;`),
    "2026/2027|Inglaterra - Premier League 2026/2027",
  );
});

Deno.test("test-position: a position outside the eight is refused", async () => {
  await refused(`INSERT INTO player (name, position) VALUES ('Vinícius', 'lw');`, "player_position_check");
});

Deno.test("test-half-score-unplayed: a score with one side is refused even on an unplayed game", async () => {
  await refused(`${fixtures}\n${game(", played, home_score", ", false, 2")};`, "game_check");
});

Deno.test("test-unplayed-scored: an unplayed game carries no score", async () => {
  await refused(`${fixtures}\n${game(", played, home_score, away_score", ", false, 2, 1")};`, "game_check");
});

Deno.test("test-unplayed-game: a game not yet played is kept with no score", async () => {
  assertEquals(await kept(`${fixtures}\n${game("", "")} RETURNING played || '|' || coalesce(home_score::text, '');`), "false|");
});

Deno.test("test-aet-half: an extra-time score with one side is refused", async () => {
  await refused(`${fixtures}\n${game(", played, home_score, away_score, home_aet", ", true, 1, 1, 2")};`, "game_check");
});

Deno.test("test-pen-half: a shoot-out with one side is refused", async () => {
  await refused(`${fixtures}\n${game(", played, home_score, away_score, home_pen", ", true, 1, 1, 4")};`, "game_check");
});

Deno.test("test-aet-unplayed: extra time on an unplayed game is refused", async () => {
  await refused(`${fixtures}\n${game(", home_aet, away_aet", ", 2, 1")};`, "game_check");
});

Deno.test("test-pen-unplayed: a shoot-out on an unplayed game is refused", async () => {
  await refused(`${fixtures}\n${game(", home_pen, away_pen", ", 4, 3")};`, "game_check");
});

Deno.test("test-aet-pen-kept: a game decided after extra time and penalties keeps all three scores", async () => {
  assertEquals(await kept(`${fixtures}\n${game(", played, home_score, away_score, home_aet, away_aet, home_pen, away_pen", ", true, 1, 1, 2, 2, 4, 3")} RETURNING home_aet || '-' || away_aet || '|' || home_pen || '-' || away_pen;`), "2-2|4-3");
});

Deno.test("test-season-order: a season that ends before it begins is refused", async () => {
  await refused(`INSERT INTO championship (name, region_name, begins, ends) VALUES ('Taça', 'Brasil', '2026-12-02', '2026-01-28');`, "championship_check");
});

Deno.test("test-season-one-day: a one-day tournament is a season", async () => {
  assertEquals(await kept(`INSERT INTO championship (name, region_name, begins, ends) VALUES ('Taça', 'Brasil', '2026-07-19', '2026-07-19') RETURNING season;`), "2026");
});

Deno.test("test-points-own: a championship keeps the points it states", async () => {
  assertEquals(await kept(`INSERT INTO championship (name, region_name, begins, ends, point_win) VALUES ('Brasileiro', 'Brasil', '1985-01-01', '1985-12-31', 2) RETURNING point_win || ',' || point_draw || ',' || point_loss;`), "2,1,0");
});

Deno.test("test-points-range: points outside a single digit are refused", async () => {
  await refused(`INSERT INTO championship (name, region_name, begins, ends, point_win) VALUES ('X', 'Brasil', '2026-01-01', '2026-12-31', 10);`, "championship_point_win_check");
});

Deno.test("test-position-kept: each of the eight positions, and none, is kept", async () => {
  assertEquals(await kept(`INSERT INTO player (name, position) VALUES ('a', 'g'), ('b', 'dr'), ('c', 'dc'), ('d', 'dl'), ('e', 'dm'), ('f', 'cm'), ('h', 'am'), ('i', 'fw'), ('j', NULL) RETURNING coalesce(position, '-');`), "g\ndr\ndc\ndl\ndm\ncm\nam\nfw\n-");
});

Deno.test("test-zone-order: a zone whose last place is above its first is refused", async () => {
  await refused(`${fixtures}\nINSERT INTO stage_group (id, phase_id, name) VALUES ('${GROUP}', '${PHASE}', 'Grupo Único');\nINSERT INTO zone (group_id, name, color, first, last) VALUES ('${GROUP}', 'Rebaixamento', 'relegation', 17, 4);`, "zone_check");
});

Deno.test("test-goal-kind: a goal is not both a penalty and an own goal", async () => {
  await refused(goal(", side, penalty, own_goal", ", 'home', true, true"), "goal_check");
});

const appearance = (cols: string, vals: string) =>
  `${fixtures}\n${game(", played, home_score, away_score", ", true, 1, 0")} RETURNING id \\gset\nINSERT INTO player (id, name) VALUES ('${PLAYER}', 'Pedro');\nINSERT INTO player_game (game_id, player_id, side${cols}) VALUES (:'id', '${PLAYER}', 'home'${vals});`;

// Blanks beyond the space: Postgres's btrim() kept a newline or a no-break
// space, and the cluster stored a body the composer's CEL refuses.
Deno.test("test-comment-empty: a comment of blanks, or past 1000 characters, is refused", async () => {
  for (const body of ["'   '", "E'\\n\\t'", "U&'\\00A0\\3000'", "repeat('a', 1001)"]) {
    await refused(
      `${fixtures}\n${game(", played, home_score, away_score", ", true, 1, 0")} RETURNING id \\gset\nINSERT INTO app_user (id, handle) VALUES ('${PLAYER}', 'reader');\nINSERT INTO comment (game_id, app_user_id, body) VALUES (:'id', '${PLAYER}', ${body});`,
      "comment_body_check",
    );
  }
});

Deno.test("test-bench-whole: a substitute never brought on has no minute off", async () => {
  await refused(appearance(", bench, on_minute, off_minute", ", true, 0, 90"), "player_game_check");
});

Deno.test("test-bench-on: a substitute never brought on came on at nothing", async () => {
  await refused(appearance(", bench, on_minute", ", true, 10"), "player_game_check");
});

const phase = (sort: string) =>
  `${championship};\nINSERT INTO phase (championship_id, name${sort ? ", sort" : ""}) VALUES ('${CHAMPIONSHIP}', 'Mata-mata'${sort ? `, '${sort}'` : ""}) RETURNING sort;`;

Deno.test("test-sort-upstream: upstream's own ladder is kept", async () => {
  assertEquals(await kept(phase("pt,w,gd,gf,gp,g_away,name")), "pt,w,gd,gf,gp,g_away,name");
});

Deno.test("test-sort-default: a phase that states no ladder takes upstream's", async () => {
  assertEquals(await kept(phase("")), "pt,w,gd,gf,gp,g_away,name");
});

Deno.test("test-sort-unknown: a key outside the vocabulary is refused", async () => {
  await refused(phase("pt,xx"), "phase_sort_check");
});

Deno.test("test-side: a goal counts for home or away and nothing else", async () => {
  await refused(goal(", side", ", 'visitor'"), "goal_side_check");
});
