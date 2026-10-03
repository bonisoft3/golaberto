// Read-only query-plan checks run only against an explicitly disposable stack.
import { assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME");
if (!project || !/(?:check|test)/.test(project) || project === "golaberto") {
  throw new Error(
    "route-queries requires a disposable COMPOSE_PROJECT_NAME containing check or test",
  );
}

const command = [
  "compose",
  "-p",
  project,
  "exec",
  "-T",
  "apps_golaberto-database",
  "psql",
  "-U",
  "postgres",
  "-d",
  "golaberto",
  "-v",
  "ON_ERROR_STOP=1",
];
const plans: Array<[string, string, string]> = [
  [
    "championship routes",
    `SELECT id FROM championship WHERE region='national' ORDER BY begins DESC,id LIMIT 6`,
    "championship_routes_region_begins_idx",
  ],
  [
    "championship catalog",
    `SELECT id FROM championship WHERE search_key LIKE '%cup%' AND region LIKE '%national%' ORDER BY region_name,name,begins DESC,id`,
    "championship_routes_catalog_order_idx",
  ],
  [
    "featured championship",
    `SELECT id FROM championship WHERE featured ORDER BY begins DESC,id LIMIT 1`,
    "championship_routes_featured_idx",
  ],
  [
    "team directory",
    `SELECT id,name FROM team_directory WHERE search_key LIKE '%united%' ORDER BY rating DESC NULLS LAST,name,id`,
    "team_directory_rating_order_idx",
  ],
  [
    "stadium directory",
    `SELECT id,name FROM stadium WHERE search_key LIKE '%park%' ORDER BY name,id`,
    "stadium_routes_name_id_idx",
  ],
  [
    "referee directory",
    `SELECT id,name FROM referee WHERE search_key LIKE '%silva%' ORDER BY name,id`,
    "referee_routes_name_id_idx",
  ],
  [
    "championship round",
    `SELECT id FROM game_card WHERE phase_id='00000000-0000-4000-8000-000000000001' AND round=1 ORDER BY day,kickoff,id LIMIT 20`,
    "game_card_routes_phase_round_idx",
  ],
  [
    "stadium history",
    `SELECT id FROM game_card WHERE stadium_id='00000000-0000-4000-8000-000000000001' ORDER BY day DESC,kickoff DESC,id`,
    "game_card_routes_stadium_history_idx",
  ],
  [
    "referee history",
    `SELECT id FROM game_card WHERE referee_id='00000000-0000-4000-8000-000000000001' ORDER BY day DESC,kickoff DESC,id`,
    "game_card_routes_referee_history_idx",
  ],
  [
    "team upcoming games",
    `SELECT id FROM team_game WHERE team_id='00000000-0000-4000-8000-000000000001' AND NOT played ORDER BY day,kickoff,id LIMIT 5`,
    "team_game_routes_upcoming_idx",
  ],
  [
    "team results",
    `SELECT id FROM team_game WHERE team_id='00000000-0000-4000-8000-000000000001' AND played ORDER BY day DESC,kickoff DESC,id LIMIT 10`,
    "team_game_routes_results_idx",
  ],
  [
    "team squad",
    `SELECT id FROM player_stat WHERE team_id='00000000-0000-4000-8000-000000000001' ORDER BY championship_name,played DESC,minutes DESC,player_name,id`,
    "player_stat_routes_team_idx",
  ],
  [
    "player seasons",
    `SELECT id FROM player_stat WHERE player_id='00000000-0000-4000-8000-000000000001' ORDER BY championship_name,team_name,id`,
    "player_stat_routes_player_idx",
  ],
  [
    "player appearances",
    `SELECT id FROM player_game WHERE player_id='00000000-0000-4000-8000-000000000001' ORDER BY day DESC,id LIMIT 40`,
    "player_game_routes_player_day_idx",
  ],
  [
    "game lineups",
    `SELECT id FROM player_game WHERE game_id='00000000-0000-4000-8000-000000000001' ORDER BY side DESC,bench,on_minute,id`,
    "player_game_routes_game_lineup_idx",
  ],
  [
    "game goals",
    `SELECT id FROM goal WHERE game_id='00000000-0000-4000-8000-000000000001' ORDER BY aet,minute,id`,
    "goal_routes_game_order_idx",
  ],
  [
    "game comments",
    `SELECT id FROM comment WHERE game_id='00000000-0000-4000-8000-000000000001' ORDER BY created_at DESC,id`,
    "comment_routes_game_order_idx",
  ],
  // The home screen already owns this covering index from 015.
  [
    "latest team rating",
    `SELECT rating FROM team_rating WHERE team_id='00000000-0000-4000-8000-000000000001' ORDER BY measure_date DESC,id LIMIT 1`,
    "team_rating_home_latest_idx",
  ],
];

Deno.test("route list queries use ordered indexes without a sort", async () => {
  const values = plans.map(([label, query, index]) =>
    `('${label.replaceAll("'", "''")}','${
      query.replaceAll("'", "''")
    }','${index}')`
  ).join(",\n");
  const sql = `BEGIN;
    SET LOCAL enable_seqscan=off;
    SET LOCAL enable_bitmapscan=off;
    -- This gate checks full-order index availability; small fixture tables
    -- can otherwise make a partial-order index plus a cheap sort preferable.
    SET LOCAL enable_sort=off;
    SET LOCAL enable_incremental_sort=off;
    DO $$ DECLARE route record; plan json; BEGIN
      FOR route IN SELECT * FROM (VALUES ${values}) AS routes(label,query,index_name) LOOP
        EXECUTE 'EXPLAIN (FORMAT JSON) ' || route.query INTO plan;
        IF plan::text NOT LIKE '%' || route.index_name || '%'
          THEN RAISE EXCEPTION '% did not use %: %',route.label,route.index_name,plan; END IF;
        IF plan::text LIKE '%"Node Type": "Sort"%'
          THEN RAISE EXCEPTION '% still sorts its selected rows: %',route.label,plan; END IF;
      END LOOP;
    END $$;
    SELECT to_json(true);
    ROLLBACK;`;
  const result = await new Deno.Command("docker", {
    args: [...command, "-Atq", "-c", sql],
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  assertEquals(new TextDecoder().decode(result.stdout).trim(), "true");
});
