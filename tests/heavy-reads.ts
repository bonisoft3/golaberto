// Page reads that were recomputed per request, against the cluster's
// Postgres; every fixture is rolled back.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { query } from "./db.ts";

Deno.test("a player's games keep a player-first plan once PostgREST's statement goes generic", async () => {
  // A generic plan has no selectivity for `category_key LIKE $3`: a player's
  // games were planned from every championship, 0.5-0.8 s against 1 ms.
  const plan = await query(`BEGIN;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    SET LOCAL plan_cache_mode=force_generic_plan;
    PREPARE games(uuid,text,text,bigint,bigint) AS SELECT * FROM player_appearance
      WHERE player_id=$1 AND played_key LIKE $2 AND category_key LIKE $3 LIMIT $4 OFFSET $5;
    EXPLAIN (COSTS OFF) EXECUTE games('00000000-0000-4000-8000-000000000000','true','%',40,0);
    ROLLBACK;`);
  // The player's rows lead, and each finds its game by key.
  assert(/(Index|Bitmap Heap) Scan.*on player_game/.test(plan), plan);
  assert(plan.indexOf("on player_game") < plan.indexOf("on championship"), plan);
  assert(/Index Cond: \(id = a\.game_id\)/.test(plan), plan);
});

Deno.test("a user's counts follow comments and edits without scanning them on read", async () => {
  const [user, champ, phase, home, away, game] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const counts = `SELECT comment_count||'/'||edit_count||'/'||(last_edit_at IS NOT NULL) FROM user_directory WHERE id='${user}'`;
  const output = await query(`BEGIN;
    INSERT INTO app_user(id,handle) VALUES ('${user}','activity-${user.slice(0, 8)}');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Activity season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Activity phase');
    INSERT INTO team(id,name,country) VALUES ('${home}','Activity home','Brasil'),('${away}','Activity away','Brasil');
    INSERT INTO game(id,phase_id,day,home_id,away_id) VALUES ('${game}','${phase}','2026-02-01','${home}','${away}');
    ${counts};
    INSERT INTO comment(game_id,app_user_id,body) VALUES ('${game}','${user}','one'),('${game}','${user}','two');
    INSERT INTO team_comment(team_id,app_user_id,body) VALUES ('${home}','${user}','three');
    INSERT INTO game_change(game_id,actor_id,version,home_name,away_name,championship_name,changes_json)
      SELECT '${game}','${user}',v,'Activity home','Activity away','Activity season','{"played":[false,true]}'
      FROM generate_series(1,3) v;
    ${counts};
    DELETE FROM comment WHERE app_user_id='${user}' AND body='one';
    ${counts};
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    -- The counts were three scans of comments and edits per listed user.
    DO $$ DECLARE line text; BEGIN
      FOR line IN EXPLAIN SELECT * FROM user_directory WHERE id='${user}' LOOP
        IF line ~ '(game_change|comment)' THEN RAISE EXCEPTION 'a directory read scans %', line; END IF;
      END LOOP;
    END $$;
    ROLLBACK;`);
  assertEquals(output.split("\n"), ["0/0/false", "3/3/true", "2/3/true"]);
});
