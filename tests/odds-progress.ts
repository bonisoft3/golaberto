// Odds progress against the cluster's Postgres: every fixture is rolled back.
import { assertEquals } from "jsr:@std/assert@1";
import { query, replayLock } from "./db.ts";

const id = () => crypto.randomUUID();
const migration = (await Deno.readTextFile(new URL("../services/database/sql/042_team_odds_progress.sql", import.meta.url)))
  .replaceAll("\nBEGIN;\n", "\n").replaceAll("\nCOMMIT;\n", "\n");

Deno.test("042 replays over itself without touching recorded history", async () => {
  const fingerprint = `(SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY id),'')) FROM team_odds_history h)`;
  assertEquals(await query(`BEGIN;${replayLock}
    SELECT set_config('golaberto.odds_history_before',${fingerprint},true) IS NOT NULL AS taken;
    ${migration}
    ${migration}
    SELECT current_setting('golaberto.odds_history_before')=${fingerprint};
    ROLLBACK;`), "t\nt");
});

Deno.test("odds progress keeps whole complete days, sparse zone sums and capture cutoffs", async () => {
  const [a, b, c, champ, phase, group, zoneA, zoneB, zoneC, before, after, unknown] = Array.from({ length: 12 }, id);
  const progress = (team: string, path: string) =>
    `(SELECT series_json::jsonb#>>'{${path}}' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${team}')`;
  const slug = (game: string) => `(SELECT slug FROM game WHERE id='${game}')`;
  const result = JSON.parse((await query(`BEGIN;
    INSERT INTO team(id,name,country) VALUES ('${a}','Progress A','Brasil'),
      ('${b}','Progress B','Brasil'),('${c}','Progress C','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends,point_win,point_draw,point_loss)
      VALUES ('${champ}','Progress season','Brasil','2025-01-01','2027-12-31',3,1,0);
    INSERT INTO phase(id,championship_id,name,sort,bonus_points,bonus_points_threshold)
      VALUES ('${phase}','${champ}','Progress phase','pt,w,gd,gf,bias,name',0,0);
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Progress group');
    INSERT INTO team_group(group_id,team_id,bias) VALUES ('${group}','${a}',0),
      ('${group}','${b}',0),('${group}','${c}',0);
    INSERT INTO zone(id,group_id,name,color,first,last,positions) VALUES
      ('${zoneA}','${group}','Same name','champion',1,2,''),
      ('${zoneB}','${group}','Same name','#8a2be2',2,3,''),
      ('${zoneC}','${group}','Ends','qualify',1,3,'1,3');
    INSERT INTO game(id,phase_id,day,kickoff,home_id,away_id,played,home_score,away_score) VALUES
      ('${before}','${phase}','2026-02-04','2026-02-04 11:00Z','${a}','${b}',true,1,0),
      ('${after}','${phase}','2026-02-04','2026-02-04 13:00Z','${a}','${c}',true,2,0),
      ('${unknown}','${phase}','2026-02-04',NULL,'${a}','${b}',true,3,0);
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
    SELECT '${group}:${a}:'||('2025-01-01'::date+d)::text||':'||p,'${group}','${a}',
      '2025-01-01'::date+d,(('2025-01-01'::date+d)::timestamp AT TIME ZONE 'UTC')+interval '12 hours',
      p,CASE p WHEN 1 THEN 10.0 WHEN 2 THEN 30.0 ELSE 60.0 END,'imported'
    FROM generate_series(0,399) d CROSS JOIN generate_series(1,3) p;
    -- Capture rewrites only the cells whose percent moved, so one complete
    -- day may carry two capture times; its latest one is the day's.
    UPDATE team_odds_history SET captured_at='2026-02-03 18:00Z'
      WHERE group_id='${group}' AND recorded_on='2026-02-03' AND position=1;
    -- Four invalid dates: a missing position, a position past the group,
    -- mixed sources, and a complete vector outside rounding tolerance.
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
    SELECT '${group}:${a}:'||('2027-01-01'::date+d)::text||':'||p,'${group}','${a}',
      '2027-01-01'::date+d,'2027-01-01 12:00Z'::timestamptz,
      p,CASE WHEN p=4 THEN 0 WHEN d=3 THEN 20 ELSE CASE p WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END END,
      CASE WHEN d=2 AND p=1 THEN 'computed' ELSE 'imported' END
    FROM generate_series(0,3) d CROSS JOIN generate_series(1,4) p
    WHERE (d<>0 OR p<>3) AND (p<>4 OR d=1);
    SELECT refresh_team_odds_charts('${group}')>0 AS refreshed;
    SELECT set_config('golaberto.odds_progress_versions',
      (SELECT string_agg(ctid::text,',' ORDER BY id) FROM team_odds_progress WHERE group_id='${group}'),true) IS NOT NULL AS taken;
    DO $$ BEGIN
      IF refresh_team_odds_charts('${group}')<>0 OR current_setting('golaberto.odds_progress_versions')<>
        (SELECT string_agg(ctid::text,',' ORDER BY id) FROM team_odds_progress WHERE group_id='${group}')
      THEN RAISE EXCEPTION 'a replay rewrote an unchanged projection'; END IF;
      IF ${progress(b, "retainedCount")}<>'0' OR ${progress(b, "snapshots")}::jsonb<>'[]'
        THEN RAISE EXCEPTION 'a team without history synthesized data'; END IF;
      IF ${progress(a, "snapshots,359,lastGame,slug")}<>${slug(before)}
        THEN RAISE EXCEPTION 'the capture cutoff selected a later or unknown-time game'; END IF;
    END $$;
    SELECT set_config('golaberto.odds_progress_payload',
      (SELECT series_json FROM team_odds_progress WHERE group_id='${group}' AND team_id='${a}'),true) IS NOT NULL AS taken;
    -- UTC is independent of session timezone; a date-only capture sees the
    -- final known kickoff of the day. An unknown kickoff never becomes midnight.
    SET LOCAL timezone='America/Los_Angeles';
    UPDATE team_odds_history SET captured_at=NULL WHERE group_id='${group}' AND recorded_on='2026-02-04';
    DO $$ BEGIN
      PERFORM refresh_team_odds_charts('${group}');
      IF ${progress(a, "snapshots,359,lastGame,slug")}<>${slug(after)}
        THEN RAISE EXCEPTION 'a date-only cutoff lost the end-of-day game'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    UPDATE game SET home_score=4 WHERE id='${after}';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'a score edit did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      IF ${progress(a, "snapshots,359,lastGame,homeScore")}<>'4' THEN RAISE EXCEPTION 'the score stayed stale'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    UPDATE team SET name='Progress C renamed' WHERE id='${c}';
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'an opponent rename did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      IF ${progress(a, "snapshots,359,lastGame,awayName")}<>'Progress C renamed' THEN RAISE EXCEPTION 'the opponent name stayed stale'; END IF;
    END $$;
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    DELETE FROM zone WHERE id IN ('${zoneB}','${zoneC}');
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}') THEN RAISE EXCEPTION 'a zone removal did not enqueue'; END IF;
      PERFORM refresh_team_odds_charts('${group}');
      IF ${progress(a, "positions,0,color")} IS NOT NULL
        OR ${progress(a, "positions,0,zoneIds")}::jsonb<>'[]'
        OR ${progress(a, "positions,1,zoneIds")}::jsonb<>'["${zoneA}"]'
        OR ${progress(a, "snapshots,359,percentages")}::jsonb<>'{"1":10,"2":30,"3":60}'
        THEN RAISE EXCEPTION 'an uncovered position lost its value or kept a removed zone'; END IF;
    END $$;
    -- A narrow rounding error is admitted without scaling the source values.
    UPDATE team_odds_history SET percent=60.04 WHERE group_id='${group}' AND recorded_on='2026-02-04' AND position=3;
    DO $$ BEGIN
      IF build_team_odds_progress('${group}','${a}')#>>'{snapshots,359,percentages,3}'<>'60.04'
        THEN RAISE EXCEPTION 'the rounding tolerance changed a recorded probability'; END IF;
    END $$;
    DELETE FROM team_group WHERE group_id='${group}' AND team_id='${b}';
    DO $$ BEGIN
      PERFORM refresh_team_odds_charts('${group}');
      IF EXISTS (SELECT 1 FROM team_odds_progress WHERE group_id='${group}' AND team_id='${b}') THEN RAISE EXCEPTION 'a removed membership kept its projection'; END IF;
      IF ${progress(a, "retainedCount")}<>'0' THEN RAISE EXCEPTION 'vectors of the old membership were silently truncated'; END IF;
    END $$;
    SELECT current_setting('golaberto.odds_progress_payload');
    ROLLBACK;`)).split("\n").at(-1)!);
  // test-odds-history: 404 recorded days, four incomplete, 360 retained.
  assertEquals(result.version, 1);
  assertEquals(result.kind, "odds-progress");
  assertEquals(result.positionCount, 3);
  assertEquals(result.sourceCount, 404);
  assertEquals(result.omittedCount, 4);
  assertEquals(result.retainedCount, 360);
  assertEquals(result.snapshots.length, 360);
  assertEquals(result.snapshots[0].day, "2025-01-01");
  assertEquals(result.snapshots.at(-1).day, "2026-02-04");
  assertEquals(new Set(result.snapshots.map((s: { day: string }) => s.day)).size, 360);
  assertEquals(result.zones.map((z: { id: string }) => z.id), [zoneA, zoneC, zoneB]);
  assertEquals(result.positions.map((p: { position: number }) => p.position), [3, 2, 1]);
  assertEquals(result.positions.map((p: { color: string }) => p.color), ["qualify", "champion", "champion"]);
  assertEquals(result.positions.map((p: { zoneIds: string[] }) => p.zoneIds), [[zoneC, zoneB], [zoneA, zoneB], [zoneA, zoneC]]);
  for (const snapshot of result.snapshots) {
    assertEquals(snapshot.percentages, { "1": 10.0, "2": 30.0, "3": 60.0 });
    assertEquals(snapshot.zoneValues, { [zoneA]: 40.0, [zoneB]: 90.0, [zoneC]: 70.0 });
  }
});

Deno.test("capture records history and leaves the refresh to the queue's drain", async () => {
  const [team, champ, phase, group] = Array.from({ length: 4 }, id);
  assertEquals(await query(`BEGIN;
    -- Capture once refreshed every group inline, outside the drain's advisory
    -- lock: a drain batch holding a group made it time out and roll back the
    -- day's capture with it.
    SELECT position('refresh_team_odds' in prosrc)=0 FROM pg_proc WHERE proname='capture_team_odds_history';
    INSERT INTO team(id,name,country) VALUES ('${team}','Queued A','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Queued season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Queued phase');
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Queued group');
    INSERT INTO team_group(group_id,team_id,bias) VALUES ('${group}','${team}',0);
    DELETE FROM team_odds_chart_dirty WHERE group_id='${group}';
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
      VALUES ('${group}:${team}:2026-02-01:1','${group}','${team}','2026-02-01','2026-02-01 12:00Z',1,100,'computed');
    SELECT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}')
      AND NOT EXISTS(SELECT 1 FROM team_odds_progress WHERE group_id='${group}');
    SELECT refresh_team_odds_charts('${group}')>0;
    SELECT series_json::jsonb->>'retainedCount'='1' FROM team_odds_progress WHERE group_id='${group}' AND team_id='${team}';
    ROLLBACK;`), "t\nt\nt\nt");
});
