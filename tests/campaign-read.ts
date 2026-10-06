import { assert, assertEquals } from "jsr:@std/assert@1";

import { query as psql } from "./db.ts";

type Plan = {
  "Node Type": string;
  "Function Name"?: string;
  "Actual Loops": number;
  "Actual Rows": number;
  "Index Cond"?: string;
  Plans?: Plan[];
};
const nodes = (
  plan: Plan,
): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

Deno.test("campaign requests rank the whole group and observe source edits immediately", async () => {
  const [a, b, c, d, champ, phase, group, otherPhase, otherGroup] = Array.from({
    length: 9,
  }, () => crypto.randomUUID());
  const [ab, ca, ad, bc, bd, dc] = Array.from(
    { length: 6 },
    () => crypto.randomUUID(),
  ).sort();
  const query =
    `SELECT p.*,t.name,source.day AS game_day FROM team_campaign_point p
    JOIN team t ON t.id=p.team_id CROSS JOIN LATERAL game(p) source
    WHERE p.group_id='${group}' AND p.team_id IN ('${a}','${b}')
    ORDER BY p.sequence,p.team_id LIMIT 800`;
  const paged = `SELECT * FROM team_campaign_point WHERE group_id='${group}'
    AND team_id='${b}' ORDER BY sequence OFFSET 1 LIMIT 1`;
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
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 9
        THEN RAISE EXCEPTION 'score correction must be visible on the next read'; END IF;
    END $$;
    UPDATE game SET home_score=1,away_score=0 WHERE id='${ab}';
    UPDATE championship SET point_win=4 WHERE id='${champ}';
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 8
        THEN RAISE EXCEPTION 'points rule correction must be visible on the next read'; END IF;
    END $$;
    UPDATE championship SET point_win=3 WHERE id='${champ}';
    UPDATE team_group SET add_sub=2 WHERE group_id='${group}' AND team_id='${b}';
    DO $$ BEGIN
      IF (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 8
        OR (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 1
        THEN RAISE EXCEPTION 'membership points correction must rerank the group immediately'; END IF;
    END $$;
    UPDATE team_group SET add_sub=0 WHERE group_id='${group}' AND team_id='${b}';
    UPDATE phase SET sort='pt,bias,name' WHERE id='${phase}';
    UPDATE team_group SET bias=10 WHERE group_id='${group}' AND team_id='${b}';
    DO $$ BEGIN
      IF (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${b}' AND game_id='${ab}') IS DISTINCT FROM 1
        THEN RAISE EXCEPTION 'sort and bias correction must rerank the group immediately'; END IF;
    END $$;
    UPDATE phase SET sort='pt,head,bias,name' WHERE id='${phase}';
    UPDATE team_group SET bias=0 WHERE group_id='${group}' AND team_id='${b}';
    CREATE TEMP TABLE campaign_plans(plan jsonb);
    GRANT INSERT ON campaign_plans TO app_user;
    SET LOCAL ROLE app_user;
    DO $$ DECLARE result jsonb; BEGIN
      EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ${
    query.replaceAll("'", "''")
  }' INTO result;
      INSERT INTO campaign_plans VALUES (result->0->'Plan');
      EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ${
    paged.replaceAll("'", "''")
  }' INTO result;
      INSERT INTO campaign_plans VALUES (result->0->'Plan');
    END $$;
    RESET ROLE;
    UPDATE game SET phase_id='${otherPhase}' WHERE id='${ab}';
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND game_id='${ab}')
        OR NOT EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${otherGroup}' AND game_id='${ab}')
        THEN RAISE EXCEPTION 'moved games must immediately leave and enter their campaigns'; END IF;
    END $$;
    UPDATE game SET phase_id='${phase}' WHERE id='${ab}';
    DELETE FROM game WHERE id='${dc}';
    DELETE FROM team_group WHERE group_id='${group}' AND team_id='${b}';
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND (game_id='${dc}' OR team_id='${b}'))
        THEN RAISE EXCEPTION 'deleted games and memberships must disappear on the next read'; END IF;
      IF (SELECT relkind FROM pg_class WHERE oid='team_campaign_point'::regclass) <> 'v'
        OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename='team_campaign_point')
        OR to_regprocedure('refresh_team_campaign_group(uuid)') IS NOT NULL
        OR to_regprocedure('replace_team_campaign_points(uuid,jsonb)') IS NOT NULL
        THEN RAISE EXCEPTION 'campaign reads must have no stored rows or background writer'; END IF;
    END $$;
    SELECT jsonb_agg(plan) FROM campaign_plans;
    ROLLBACK;`);
  const plans: Plan[] = JSON.parse(output);
  assertEquals(plans.length, 2);
  for (const plan of plans) {
    const all = nodes(plan);
    const scans = all.filter((node) =>
      node["Function Name"] === "jsonb_to_recordset"
    );
    assertEquals(scans.length, 1);
    assertEquals(scans[0]["Actual Loops"], 1);
    assert(scans[0]["Actual Rows"] > 0);
    assert(
      all.some((node) => node["Index Cond"]?.includes(group)),
      "request group must constrain the source scan",
    );
  }
});
