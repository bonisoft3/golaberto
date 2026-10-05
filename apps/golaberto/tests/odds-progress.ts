// Projection tests use an isolated check stack; source fixtures are rolled back.
// The additive schema upgrade is deliberately replayed on the existing schema.
import { assert, assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("odds-progress requires a disposable check/test COMPOSE_PROJECT_NAME");
}
const psql = async (sql: string) => {
  const process = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database",
      "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await process.output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const id = () => crypto.randomUUID();

Deno.test("odds progress preserves bounded complete vectors, overlap and capture cutoffs", async () => {
  const migration = await Deno.readTextFile(new URL("../services/database/sql/030_team_odds_progress.sql", import.meta.url));
  const colorsMigration = await Deno.readTextFile(new URL("../services/database/sql/031_zone_colors.sql", import.meta.url));
  await psql(`
    CREATE TEMP TABLE source_before_upgrade AS
      SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY id),'')) AS fingerprint
      FROM team_odds_history h;
    ${migration}
    ${colorsMigration}
    ${migration}
    ${colorsMigration}
    DO $$ BEGIN
      IF (SELECT fingerprint FROM source_before_upgrade) IS DISTINCT FROM
        (SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY id),'')) FROM team_odds_history h)
      THEN RAISE EXCEPTION 'replayed migration changed source history'; END IF;
    END $$;
  `);
  const [a,b,c,champ,phase,group,zoneA,zoneB,before,after,unknown] = Array.from({length:11},id);
  const result = JSON.parse(await psql(`BEGIN;
    INSERT INTO team(id,name,country) VALUES ('${a}','Progress A','Brasil'),
      ('${b}','Progress B','Brasil'),('${c}','Progress C','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends,point_win,point_draw,point_loss)
      VALUES ('${champ}','Progress season','Brasil','2025-01-01','2027-12-31',3,1,0);
    INSERT INTO phase(id,championship_id,name,sort,bonus_points,bonus_points_threshold)
      VALUES ('${phase}','${champ}','Progress phase','pt,w,gd,gf,bias,name',0,0);
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Progress group');
    INSERT INTO team_group(group_id,team_id,bias) VALUES ('${group}','${a}',0),
      ('${group}','${b}',0),('${group}','${c}',0);
    INSERT INTO zone(id,group_id,name,color,first,last,position) VALUES
      ('${zoneA}','${group}','Same name','champion',1,2,0),
      ('${zoneB}','${group}','Same name','qualify',2,3,1);
    INSERT INTO game(id,phase_id,day,kickoff,home_id,away_id,played,home_score,away_score) VALUES
      ('${before}','${phase}','2026-02-04','2026-02-04 11:00Z','${a}','${b}',true,1,0),
      ('${after}','${phase}','2026-02-04','2026-02-04 13:00Z','${a}','${c}',true,2,0),
      ('${unknown}','${phase}','2026-02-04',NULL,'${a}','${b}',true,3,0);
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
    SELECT '${group}:${a}:'||('2025-01-01'::date+d)::text||':'||p,'${group}','${a}',
      '2025-01-01'::date+d,(('2025-01-01'::date+d)::timestamp AT TIME ZONE 'UTC')+interval '12 hours',
      p,CASE p WHEN 1 THEN 10.0 WHEN 2 THEN 30.0 ELSE 60.0 END,'imported'
    FROM generate_series(0,399) d CROSS JOIN generate_series(1,3) p;
    -- Four invalid dates: missing position, mixed timestamp, mixed source,
    -- and a complete vector whose sum is outside rounding tolerance.
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
    SELECT '${group}:${a}:'||('2027-01-01'::date+d)::text||':'||p,'${group}','${a}',
      '2027-01-01'::date+d,
      CASE WHEN d=1 AND p=1 THEN NULL ELSE '2027-01-01 12:00Z'::timestamptz END,
      p,CASE WHEN d=3 THEN 20 ELSE CASE p WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END END,
      CASE WHEN d=2 AND p=1 THEN 'computed' ELSE 'imported' END
    FROM generate_series(0,3) d CROSS JOIN generate_series(1,3) p WHERE d<>0 OR p<>3;
    DO $$ BEGIN PERFORM refresh_team_odds_charts('${group}'); END $$;
    CREATE TEMP TABLE progress_before AS SELECT id,ctid::text AS version FROM team_odds_progress WHERE group_id='${group}';
    DO $$ BEGIN
      IF refresh_team_odds_charts('${group}')<>0 OR EXISTS (
        SELECT 1 FROM progress_before p JOIN team_odds_progress d USING(id) WHERE p.version<>d.ctid::text)
      THEN RAISE EXCEPTION 'replay rewrote unchanged projection'; END IF;
    END $$;
    CREATE TEMP TABLE inspected AS SELECT series_json::jsonb AS payload FROM team_odds_progress
      WHERE group_id='${group}' AND team_id='${a}';
    DO $$ DECLARE payload jsonb; BEGIN
      SELECT series_json::jsonb INTO payload FROM team_odds_progress WHERE group_id='${group}' AND team_id='${b}';
      IF payload->>'retainedCount'<>'0' OR payload->'snapshots'<>'[]'::jsonb THEN RAISE EXCEPTION 'empty team synthesized data'; END IF;
      IF (SELECT series_json::jsonb#>>'{snapshots,359,lastGame,id}' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}')<>'${before}'
        THEN RAISE EXCEPTION 'capture cutoff selected a later or unknown-time game'; END IF;
    END $$;
    -- UTC is independent of session timezone; a date-only capture sees the
    -- final known kickoff of the day. Unknown kickoff never becomes midnight.
    SET LOCAL timezone='America/Los_Angeles';
    UPDATE team_odds_history SET captured_at=NULL WHERE group_id='${group}' AND recorded_on='2026-02-04';
    DO $$ BEGIN
      PERFORM refresh_team_odds_charts('${group}');
      IF (SELECT series_json::jsonb#>>'{snapshots,359,lastGame,id}' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}')<>'${after}'
        THEN RAISE EXCEPTION 'date-only cutoff lost end-of-day game'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    UPDATE game SET home_score=4 WHERE id='${after}';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'game metadata did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      IF (SELECT series_json::jsonb#>>'{snapshots,359,lastGame,homeScore}' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}')<>'4'
        THEN RAISE EXCEPTION 'game score stayed stale'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    UPDATE team SET name='Progress C renamed' WHERE id='${c}';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'opponent rename did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      IF (SELECT series_json::jsonb#>>'{snapshots,359,lastGame,awayName}' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}')<>'Progress C renamed'
        THEN RAISE EXCEPTION 'opponent name stayed stale'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    DELETE FROM zone WHERE id='${zoneB}';
    DO $$ DECLARE payload jsonb; BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'zone removal did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      SELECT series_json::jsonb INTO payload FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}';
      IF payload#>>'{positions,0,color}' IS DISTINCT FROM '#d3d3d3'
        OR payload#>'{positions,0,zoneIds}' IS DISTINCT FROM '[]'::jsonb
        OR payload#>'{positions,1,zoneIds}' IS DISTINCT FROM jsonb_build_array('${zoneA}'::text)
        OR payload#>'{snapshots,359,percentages}' IS DISTINCT FROM '{"1":10,"2":30,"3":60}'::jsonb
        THEN RAISE EXCEPTION 'uncovered position lost its value or retained a removed zone'; END IF;
    END $$;
    -- A narrow rounding error is admitted without scaling the source values.
    UPDATE team_odds_history SET percent=60.04 WHERE group_id='${group}' AND recorded_on='2026-02-04' AND position=3;
    DO $$ BEGIN
      IF build_team_odds_progress('${group}','${a}')#>>'{snapshots,359,percentages,3}'<>'60.04'
        THEN RAISE EXCEPTION 'rounding tolerance changed original probability'; END IF;
    END $$;
    DELETE FROM team_group WHERE group_id='${group}' AND team_id='${b}';
    DO $$ BEGIN
      PERFORM refresh_team_odds_charts('${group}');
      IF EXISTS (SELECT 1 FROM team_odds_progress WHERE group_id='${group}' AND team_id='${b}') THEN RAISE EXCEPTION 'removed membership retained projection'; END IF;
      IF (SELECT series_json::jsonb->>'retainedCount' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}')<>'0'
        THEN RAISE EXCEPTION 'old membership vectors were silently truncated'; END IF;
    END $$;
    SELECT payload FROM inspected;
    ROLLBACK;
  `));
  assertEquals(result.version,1);
  assertEquals(result.kind,"odds-progress");
  assertEquals(result.positionCount,3);
  assertEquals(result.sourceCount,404);
  assertEquals(result.omittedCount,4);
  assertEquals(result.retainedCount,360);
  assertEquals(result.snapshots.length,360);
  assertEquals(result.snapshots[0].day,"2025-01-01");
  assertEquals(result.snapshots.at(-1).day,"2026-02-04");
  assertEquals(new Set(result.snapshots.map((s: {day:string})=>s.day)).size,360);
  assertEquals(result.positions.map((p: {position:number})=>p.position),[3,2,1]);
  assertEquals(result.positions[1].color,"#22bb22");
  assertEquals(result.positions[1].zoneIds,[zoneA,zoneB]);
  for (const snapshot of result.snapshots) {
    assertEquals(snapshot.percentages,{"1":10,"2":30,"3":60});
    assertEquals(snapshot.zoneValues,{[zoneA]:40,[zoneB]:90});
  }
});
