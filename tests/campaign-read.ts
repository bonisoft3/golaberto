import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import { query as psql } from "./db.ts";

type Plan = {
  "Node Type": string;
  "Function Name"?: string;
  "Actual Loops": number;
  "Actual Rows": number;
  "Index Cond"?: string;
  "Index Name"?: string;
  Plans?: Plan[];
};
const nodes = (
  plan: Plan,
): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

// Campaign history was computed on every read, ranking each round of the whole
// group: a full archive's league page spent 1.4 s per read at the edge. It is
// now stored per group and refreshed by the team-chart queue's drain.
Deno.test("campaign history ranks the whole group, follows source edits through the queue, and reads by index", async () => {
  const [a, b, c, d, champ, phase, group, otherPhase, otherGroup] = Array.from({
    length: 9,
  }, () => crypto.randomUUID());
  const [ab, ca, ad, bc, bd, dc] = Array.from(
    { length: 6 },
    () => crypto.randomUUID(),
  ).sort();
  const query =
    `SELECT p.*,t.name,source.day AS game_day FROM team_campaign_point p
    JOIN team t ON t.id=p.team_id JOIN game source ON source.id=p.game_id
    WHERE p.group_id='${group}' AND p.team_id IN ('${a}','${b}')
    ORDER BY p.sequence,p.team_id LIMIT 800`;
  const paged = `SELECT * FROM team_campaign_point WHERE group_id='${group}'
    AND team_id='${b}' ORDER BY sequence OFFSET 1 LIMIT 1`;
  // What the drain does for a queued group; asserting the queue first keeps a
  // source edit that enqueues nothing from passing.
  const drain = `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}')
        THEN RAISE EXCEPTION 'a source edit did not queue its group'; END IF;
      PERFORM refresh_team_odds_charts(group_id) FROM team_odds_chart_dirty
        WHERE group_id IN ('${group}','${otherGroup}');
      DELETE FROM team_odds_chart_dirty WHERE group_id IN ('${group}','${otherGroup}');
    END $$;`;
  const output = await psql(`BEGIN;
    INSERT INTO team(id,name,country) VALUES ('${a}','Campaign A','Brasil'),
      ('${b}','Campaign B','Brasil'),('${c}','Campaign C','Brasil'),('${d}','Campaign D','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends,point_win,point_draw,point_loss)
      VALUES ('${champ}','Campaign request fixture','Brasil','2026-01-01','2026-12-31',3,1,0);
    INSERT INTO phase(id,championship_id,name,sort,bonus_points,bonus_points_threshold)
      VALUES ('${phase}','${champ}','Historical rank','pt,head,bias,name',0,0),
        ('${otherPhase}','${champ}','Destination','pt,w,gd,gf,bias,name',0,0);
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Campaign fixture'),
      ('${otherGroup}','${otherPhase}','Campaign destination');
    INSERT INTO stage_group(phase_id,name)
      SELECT '${phase}','Unrequested campaign '||i FROM generate_series(1,1000) i;
    INSERT INTO team_group(group_id,team_id,bias) VALUES
      ('${group}','${a}',0),('${group}','${b}',0),('${group}','${c}',0),('${group}','${d}',0),
      ('${otherGroup}','${a}',0);
    INSERT INTO game(id,phase_id,round,day,home_id,away_id,played,home_score,away_score) VALUES
      ('${ab}','${phase}',1,'2026-01-01','${a}','${b}',true,1,0),
      ('${ca}','${phase}',1,'2026-01-01','${c}','${a}',true,1,0),
      ('${ad}','${phase}',1,'2026-01-01','${a}','${d}',true,1,0),
      ('${bc}','${phase}',1,'2026-01-01','${b}','${c}',true,1,0),
      ('${bd}','${phase}',1,'2026-01-01','${b}','${d}',true,1,0),
      ('${dc}','${phase}',1,'2026-01-01','${d}','${c}',true,1,0);
    ${drain}
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 2
        OR (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${a}' AND game_id='${ab}') IS DISTINCT FROM 6
        THEN RAISE EXCEPTION 'selected team must retain the whole-group historical rank'; END IF;
      IF (SELECT count(*) FROM (${query}) comparison) <> 6
        OR (SELECT position FROM (${paged}) page) IS DISTINCT FROM 2
        THEN RAISE EXCEPTION 'comparison joins and pagination must preserve campaign rows'; END IF;
    END $$;
    RESET ROLE;
    UPDATE game SET home_score=0,away_score=1 WHERE id='${ab}';
    ${drain}
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 9
        THEN RAISE EXCEPTION 'a score correction must reach the stored campaign'; END IF;
    END $$;
    UPDATE game SET home_score=1,away_score=0 WHERE id='${ab}';
    UPDATE championship SET point_win=4 WHERE id='${champ}';
    ${drain}
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 8
        THEN RAISE EXCEPTION 'a points rule correction must reach the stored campaign'; END IF;
    END $$;
    UPDATE championship SET point_win=3 WHERE id='${champ}';
    UPDATE team_group SET add_sub=2 WHERE group_id='${group}' AND team_id='${b}';
    ${drain}
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 8
        OR (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 1
        THEN RAISE EXCEPTION 'a membership points correction must rerank the stored group'; END IF;
    END $$;
    UPDATE team_group SET add_sub=0 WHERE group_id='${group}' AND team_id='${b}';
    UPDATE phase SET sort='pt,bias,name' WHERE id='${phase}';
    UPDATE team_group SET bias=10 WHERE group_id='${group}' AND team_id='${b}';
    ${drain}
    DO $$ BEGIN
      IF (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 1
        THEN RAISE EXCEPTION 'a sort and bias correction must rerank the stored group'; END IF;
    END $$;
    UPDATE phase SET sort='pt,head,bias,name' WHERE id='${phase}';
    UPDATE team_group SET bias=0 WHERE group_id='${group}' AND team_id='${b}';
    -- A setting, not a temp table: pgroll records DDL in its ledger, and
    -- concurrent checks recording against one parent collide.
    SET LOCAL golaberto.campaign_plans = '[]';
    SET LOCAL ROLE app_user;
    DO $$ DECLARE result jsonb; BEGIN
      EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ${
    query.replaceAll("'", "''")
  }' INTO result;
      PERFORM set_config('golaberto.campaign_plans',
        (current_setting('golaberto.campaign_plans')::jsonb || jsonb_build_array(result->0->'Plan'))::text,true);
      EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ${
    paged.replaceAll("'", "''")
  }' INTO result;
      PERFORM set_config('golaberto.campaign_plans',
        (current_setting('golaberto.campaign_plans')::jsonb || jsonb_build_array(result->0->'Plan'))::text,true);
    END $$;
    RESET ROLE;
    UPDATE game SET phase_id='${otherPhase}' WHERE id='${ab}';
    ${drain}
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND game_id='${ab}')
        OR NOT EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${otherGroup}' AND game_id='${ab}')
        THEN RAISE EXCEPTION 'a moved game must leave and enter its campaigns'; END IF;
    END $$;
    UPDATE game SET phase_id='${phase}' WHERE id='${ab}';
    DELETE FROM game WHERE id='${dc}';
    DELETE FROM team_group WHERE group_id='${group}' AND team_id='${b}';
    ${drain}
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND (game_id='${dc}' OR team_id='${b}'))
        THEN RAISE EXCEPTION 'deleted games and memberships must leave the stored campaign'; END IF;
    END $$;
    SELECT current_setting('golaberto.campaign_plans');
    ROLLBACK;`);
  const plans: Plan[] = JSON.parse(output);
  assertEquals(plans.length, 2);
  for (const plan of plans) {
    const all = nodes(plan);
    assertEquals(all.filter((node) => node["Function Name"] === "jsonb_to_recordset").length, 0, "a read computes no campaign");
    assert(
      all.some((node) => node["Index Name"] === "team_campaign_point_group_team_sequence_idx" && node["Index Cond"]?.includes(group)),
      "a read finds its group and team by index",
    );
  }
});

Deno.test("home feed computed relationships retain the guest reader's access", async () => {
  const [home, away, champ, phase, game] = Array.from({ length: 5 }, () => crypto.randomUUID());
  const output = await psql(`BEGIN;
    INSERT INTO team(id,name,country) VALUES ('${home}','Feed home','Brasil'),('${away}','Feed away','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Feed season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Feed phase');
    INSERT INTO game(id,phase_id,round,day,home_id,away_id,played) VALUES ('${game}','${phase}',1,'2026-01-01','${home}','${away}',false);
    SET LOCAL request.jwt.claims='{"role":"app_user","sub":"guest-fixture","guest":true}';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN PERFORM app_pre_request(); END $$;
    SELECT (SELECT id FROM game_archive(f)) = '${game}'::uuid,
      (SELECT championship_id FROM game_archive(f)) = '${champ}'::uuid,
      (SELECT home_id FROM game_archive(f)) = '${home}'::uuid,
      (SELECT away_id FROM game_archive(f)) = '${away}'::uuid,
      (SELECT id FROM id(f)) = '${game}'::uuid,
      (SELECT id FROM championship(f)) = '${champ}'::uuid,
      (SELECT id FROM home_id(f)) = '${home}'::uuid,
      (SELECT id FROM away_id(f)) = '${away}'::uuid
    FROM jsonb_populate_record(NULL::home_feed, jsonb_build_object(
      'id','${game}','championship_id','${champ}','home_id','${home}','away_id','${away}')) f;
    SET LOCAL app.scopes='';
    SELECT (SELECT count(*) FROM game_archive(f))
    FROM jsonb_populate_record(NULL::home_feed, jsonb_build_object(
      'id','${game}','championship_id','${champ}','home_id','${home}','away_id','${away}')) f;
    ROLLBACK;`);
  assertEquals(output, "t|t|t|t|t|t|t|t\n0");
  await assertRejects(() => psql(`BEGIN;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE anon;
    SELECT count(*) FROM game_archive(NULL::home_feed);
    ROLLBACK;`), Error, "permission denied for view game_archive");
});
