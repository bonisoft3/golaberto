// Source invalidation, worker restart and retained replay run in a disposable
// database, with all fixture, queue, function and trigger changes rolled back.
import { assert, assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("campaign-work requires a disposable COMPOSE_PROJECT_NAME containing check or test");
}

async function psql(sql: string) {
  const child = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database",
      "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const done = child.output();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await done;
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("campaign work is selective, bounded, resumable and migration replay stays idle", async () => {
  const ids = Array.from({ length: 17 }, () => crypto.randomUUID());
  const [a,b,c,d,champ,otherChamp,phase,otherPhase,group,peer,otherGroup,emptyGroup,game,peerGame,extraGame,zone,deletedGroup] = ids;
  const migration = (await Deno.readTextFile(new URL("../services/database/sql/034_campaign_queue.sql", import.meta.url)))
    .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
  const expectQueue = (groups: string[], message: string) =>
    `DO $$ BEGIN PERFORM pg_temp.assert_campaign_queue(ARRAY[${groups.map((id) => `'${id}'`).join(",")}]::uuid[],'${message}'); END $$;`;
  const mutation = (sql: string, groups: string[], message: string) =>
    `DELETE FROM team_campaign_dirty; ${sql} ${expectQueue(groups, message)}`;

  const output = await psql(`BEGIN;
    DELETE FROM team_campaign_dirty;
    CREATE FUNCTION pg_temp.assert_campaign_queue(expected uuid[], context text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE actual uuid[]; sorted uuid[]; BEGIN
      SELECT coalesce(array_agg(group_id ORDER BY group_id),'{}'::uuid[]) INTO actual FROM team_campaign_dirty;
      SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO sorted FROM unnest(expected) id;
      IF actual IS DISTINCT FROM sorted THEN
        RAISE EXCEPTION '%: expected %, got %',context,sorted,actual;
      END IF;
    END $$;
    INSERT INTO team(id,name,country) VALUES ('${a}','Campaign A','Brasil'),('${b}','Campaign B','Brasil'),
      ('${c}','Campaign C','Brasil'),('${d}','Campaign D','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends,point_win,point_draw,point_loss) VALUES
      ('${champ}','Campaign Work','Brasil','2026-01-01','2026-12-31',3,1,0),
      ('${otherChamp}','Campaign Other','Brasil','2026-01-01','2026-12-31',3,1,0);
    INSERT INTO phase(id,championship_id,name,sort) VALUES
      ('${phase}','${champ}','Primary','pt,w,gd,gf,bias,name'),
      ('${otherPhase}','${otherChamp}','Other','pt,w,gd,gf,bias,name');
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Primary'),
      ('${peer}','${phase}','Peer'),('${otherGroup}','${otherPhase}','Other'),('${emptyGroup}','${phase}','Empty');
    INSERT INTO team_group(group_id,team_id) VALUES ('${group}','${a}'),('${group}','${b}'),
      ('${peer}','${c}'),('${otherGroup}','${a}'),('${otherGroup}','${b}');
    INSERT INTO game(id,phase_id,day,round,home_id,away_id,played,home_score,away_score) VALUES
      ('${game}','${phase}','2026-01-01',1,'${a}','${b}',true,1,0),
      ('${peerGame}','${phase}','2026-01-01',1,'${c}','${d}',true,1,0);
    ${expectQueue([group,peer,otherGroup,emptyGroup], "new groups and memberships require initial work")}
    DO $$ DECLARE processed integer; BEGIN
      processed:=refresh_team_campaigns(1);
      IF processed<>1 OR (SELECT count(*) FROM team_campaign_dirty)<>3
        THEN RAISE EXCEPTION 'campaign drain exceeded its bounded batch'; END IF;
      processed:=refresh_team_campaigns(4);
      IF processed<>3 OR EXISTS (SELECT 1 FROM team_campaign_dirty)
        THEN RAISE EXCEPTION 'campaign drain failed to complete its queue'; END IF;
    END $$;
    CREATE TEMP TABLE campaign_versions AS SELECT id,ctid AS physical_row,xmin::text AS row_version,txid
      FROM team_campaign_point WHERE group_id IN ('${group}','${peer}');
    DO $$ BEGIN
      IF refresh_team_campaigns(4)<>0 OR refresh_team_campaigns(4)<>0
        THEN RAISE EXCEPTION 'idle worker or restart must not reconstruct completed groups'; END IF;
      IF EXISTS (SELECT 1 FROM campaign_versions v JOIN team_campaign_point p USING(id)
        WHERE (v.physical_row,v.row_version,v.txid) IS DISTINCT FROM (p.ctid,p.xmin::text,p.txid))
        THEN RAISE EXCEPTION 'idle campaign worker changed projection rows'; END IF;
    END $$;

    -- A newly changed group must not wait behind older legacy certification.
    INSERT INTO team_campaign_dirty(group_id,revision,backfill)
      SELECT id,nextval('team_campaign_revision_seq'),true
      FROM unnest(ARRAY['${group}','${peer}','${otherGroup}','${emptyGroup}']::uuid[]) id;
    CREATE TEMP TABLE campaign_backfill_versions AS SELECT *,ctid AS physical_row
      FROM team_campaign_dirty WHERE group_id<>'${group}';
    UPDATE game SET home_score=2 WHERE id='${game}';
    DO $$ DECLARE processed integer; BEGIN
      IF NOT EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${group}' AND NOT backfill
        AND revision>(SELECT max(revision) FROM campaign_backfill_versions))
        THEN RAISE EXCEPTION 'live source event must promote its existing backfill key'; END IF;
      processed:=refresh_team_campaigns(1);
      IF processed<>1 OR EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${group}')
        OR EXISTS (SELECT * FROM campaign_backfill_versions EXCEPT SELECT *,ctid FROM team_campaign_dirty)
        OR EXISTS (SELECT *,ctid FROM team_campaign_dirty EXCEPT SELECT * FROM campaign_backfill_versions)
        THEN RAISE EXCEPTION 'live group must drain first without changing older pending backfill'; END IF;
    END $$;
    UPDATE game SET home_score=1 WHERE id='${game}';
    DO $$ BEGIN PERFORM refresh_team_campaigns(1); END $$;

    ${mutation(`UPDATE game SET attendance=1234,home_score=home_score WHERE id='${game}';
      UPDATE team SET country='Test',name=name WHERE id='${a}';
      UPDATE phase SET name='Renamed',sort=sort WHERE id='${phase}';
      UPDATE championship SET name='Renamed',point_win=point_win WHERE id='${champ}';
      UPDATE stage_group SET name='Renamed',phase_id=phase_id WHERE id='${group}';
      UPDATE team_group SET bias=bias,add_sub=add_sub WHERE group_id='${group}';
      INSERT INTO zone(id,group_id,name,color,first,last) VALUES ('${zone}','${group}','Zone','#112233',1,1);
      UPDATE zone SET color='#334455',name='Renamed zone' WHERE id='${zone}';
      DELETE FROM zone WHERE id='${zone}';`, [], "irrelevant fields, exact replays and zones must not enqueue")}
    ${mutation(`INSERT INTO game(id,phase_id,day,round,home_id,away_id,played,home_score,away_score)
      VALUES ('${extraGame}','${phase}','2026-01-02',2,'${a}','${c}',false,NULL,NULL);`, [], "unplayed insert cannot affect campaign")}
    ${mutation(`UPDATE game SET played=true,home_score=1,away_score=0 WHERE id='${extraGame}';`, [group,peer], "played result affects participant groups only")}
    ${mutation(`UPDATE game SET played=false,home_score=NULL,away_score=NULL WHERE id='${extraGame}';`, [group,peer], "cleared played result removes old campaign observations")}
    ${mutation(`DELETE FROM game WHERE id='${extraGame}';`, [], "unplayed deletion does not affect campaign")}
    ${mutation(`INSERT INTO game(id,phase_id,day,round,home_id,away_id,played,home_score,away_score)
      VALUES ('${extraGame}','${phase}','2026-01-02',2,'${a}','${c}',true,1,0);`, [group,peer], "played insertion enqueues exact participant scopes")}
    ${mutation(`DELETE FROM game WHERE id='${extraGame}';`, [group,peer], "played deletion retains old scopes")}
    ${mutation(`UPDATE game SET phase_id='${otherPhase}' WHERE id='${game}';`, [group,otherGroup], "game move queues old and new phases")}
    ${mutation(`UPDATE game SET phase_id='${phase}' WHERE id='${game}';`, [group,otherGroup], "game move back queues old and new phases")}
    ${mutation(`UPDATE game SET home_id='${c}' WHERE id='${game}';`, [group,peer], "participant change includes old and new teams")}
    ${mutation(`UPDATE game SET home_id='${a}' WHERE id='${game}';`, [group,peer], "participant restoration includes old and new teams")}
    -- Optional score pairs must be present together before either side can
    -- change independently under the game validation constraint.
    ${mutation(`UPDATE game SET home_aet=0,away_aet=0,home_pen=0,away_pen=0 WHERE id='${game}';`,
      [group], "optional score pairs initialize together")}
    -- Change each result/ranking input alone: another changed input must not
    -- conceal a missing invalidation for points, tie breaks or chronology.
    ${[
      ["home_score=2", "home regulation score changes points"],
      ["away_score=1", "away regulation score changes points"],
      ["home_aet=1", "home extra-time score changes tie breaks"],
      ["away_aet=1", "away extra-time score changes tie breaks"],
      ["home_pen=4", "home penalties change tie breaks"],
      ["away_pen=3", "away penalties change tie breaks"],
      ["day='2026-01-02'", "day changes chronological batches"],
      ["kickoff='2026-01-02T15:00:00Z'", "kickoff changes chronological ordering"],
      ["round=2", "round changes cumulative ranking batches"],
    ].map(([change,reason]) => mutation(`UPDATE game SET ${change} WHERE id='${game}';`, [group], reason)).join("\n")}
    ${[
      ["sort='pt,bias,name'", "sort changes ranking priority"],
      ["bonus_points=1", "bonus points change campaign totals"],
      ["bonus_points_threshold=2", "bonus threshold changes qualifying scores"],
    ].map(([change,reason]) => mutation(`UPDATE phase SET ${change} WHERE id='${phase}';`,
      [group,peer,emptyGroup], reason)).join("\n")}
    ${mutation(`UPDATE phase SET championship_id='${otherChamp}' WHERE id='${phase}';`,
      [group,peer,emptyGroup], "phase championship move changes points rules")}
    ${mutation(`UPDATE phase SET championship_id='${champ}' WHERE id='${phase}';`,
      [group,peer,emptyGroup], "phase restoration changes points rules")}
    ${[
      ["point_win=4", "win points change all championship groups"],
      ["point_draw=2", "draw points change all championship groups"],
      ["point_loss=1", "loss points change all championship groups"],
    ].map(([change,reason]) => mutation(`UPDATE championship SET ${change} WHERE id='${champ}';`,
      [group,peer,emptyGroup], reason)).join("\n")}
    ${mutation(`UPDATE team SET name='Campaign A renamed' WHERE id='${a}';`, [group,otherGroup], "team name tie break affects memberships")}
    ${mutation(`UPDATE team_group SET add_sub=2 WHERE group_id='${group}' AND team_id='${a}';`,
      [group], "membership adjustments change cumulative points")}
    ${mutation(`UPDATE team_group SET bias=3 WHERE group_id='${group}' AND team_id='${a}';`,
      [group], "membership bias changes ranking ties")}
    ${mutation(`UPDATE team_group SET group_id='${peer}' WHERE group_id='${group}' AND team_id='${a}';`,
      [group,peer], "membership move retains both scopes")}
    ${mutation(`UPDATE team_group SET group_id='${group}' WHERE group_id='${peer}' AND team_id='${a}';`,
      [group,peer], "membership restoration retains both scopes")}
    ${mutation(`DELETE FROM team_group WHERE group_id='${group}' AND team_id='${b}';`,
      [group], "membership deletion retains old group")}
    ${mutation(`INSERT INTO team_group(group_id,team_id) VALUES ('${group}','${b}');`,
      [group], "membership insert queues its group")}
    ${mutation(`UPDATE stage_group SET phase_id='${otherPhase}' WHERE id='${emptyGroup}';`,
      [emptyGroup], "group phase change queues the moved group")}
    ${mutation(`INSERT INTO stage_group(id,phase_id,name) VALUES ('${deletedGroup}','${phase}','Deleted');
      DELETE FROM stage_group WHERE id='${deletedGroup}';`, [deletedGroup], "deleted group leaves consumable orphan work")}
    DO $$ DECLARE processed integer; BEGIN
      processed:=refresh_team_campaigns(4);
      IF processed<>1 OR EXISTS (SELECT 1 FROM team_campaign_dirty)
        THEN RAISE EXCEPTION 'deleted campaign group blocked queue drain'; END IF;
    END $$;

    -- A burst replaces one pending revision, not one queue row per source event.
    UPDATE game SET home_score=3 WHERE id='${game}';
    CREATE TEMP TABLE campaign_revision AS SELECT revision FROM team_campaign_dirty WHERE group_id='${group}';
    UPDATE game SET home_score=4 WHERE id='${game}';
    UPDATE game SET home_score=5 WHERE id='${game}';
    ${expectQueue([group], "same-group burst must coalesce")}
    DO $$ BEGIN
      IF (SELECT revision FROM team_campaign_dirty WHERE group_id='${group}') <= (SELECT revision FROM campaign_revision)
        THEN RAISE EXCEPTION 'coalesced work must retain a fresh revision'; END IF;
      PERFORM refresh_team_campaigns(1);
    END $$;

    -- Inject a source write after computation, while projection updates run.
    -- The new revision must survive the worker deleting its observed revision.
    CREATE TEMP TABLE campaign_injection (pending boolean);
    INSERT INTO campaign_injection VALUES (true);
    CREATE FUNCTION pg_temp.inject_campaign_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE pg_temp.campaign_injection SET pending=false WHERE pending;
      IF FOUND THEN UPDATE team SET name='Campaign A during refresh' WHERE id='${a}'; END IF;
      RETURN NULL;
    END $$;
    CREATE TRIGGER campaign_revision_test AFTER UPDATE ON team_campaign_point
      FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_campaign_revision();
    UPDATE game SET home_score=0,away_score=1 WHERE id='${game}';
    DO $$ BEGIN PERFORM refresh_team_campaigns(1); END $$;
    ${expectQueue([group,otherGroup], "source revision arriving during refresh must survive")}
    DROP TRIGGER campaign_revision_test ON team_campaign_point;
    DO $$ BEGIN PERFORM refresh_team_campaigns(4); END $$;
    ${expectQueue([], "next batch converges and consumes new revisions")}

    -- A persistent failure in the oldest group must not starve healthy groups.
    -- Fail its second row after the first write, proving partial work rolls back.
    CREATE TEMP TABLE campaign_failure_count (writes integer);
    INSERT INTO campaign_failure_count VALUES (0);
    CREATE FUNCTION pg_temp.reject_campaign_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.group_id='${group}' THEN
        UPDATE pg_temp.campaign_failure_count SET writes=writes+1;
        IF (SELECT writes FROM pg_temp.campaign_failure_count)>=2 THEN
          RAISE EXCEPTION 'injected campaign failure' USING ERRCODE='check_violation';
        END IF;
      END IF;
      RETURN NULL;
    END $$;
    CREATE TRIGGER campaign_failure_test AFTER UPDATE ON team_campaign_point
      FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_campaign_write();
    UPDATE game SET home_score=2,away_score=0 WHERE id='${game}';
    UPDATE game SET home_score=0,away_score=1 WHERE id='${peerGame}';
    CREATE TEMP TABLE campaign_before_failure AS SELECT *,ctid AS physical_row,xmin::text AS row_version
      FROM team_campaign_point WHERE group_id='${group}';
    CREATE TEMP TABLE campaign_pending_failure AS SELECT revision FROM team_campaign_dirty WHERE group_id='${group}';
    DO $$ DECLARE processed integer; BEGIN
      processed:=refresh_team_campaigns(4);
      IF processed<>1 OR EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${peer}')
        OR (SELECT result FROM team_campaign_point WHERE group_id='${peer}' AND team_id='${c}') IS DISTINCT FROM 'l'
        THEN RAISE EXCEPTION 'failing oldest group blocked healthy campaign work'; END IF;
      IF NOT EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${group}'
          AND revision=(SELECT revision FROM campaign_pending_failure)
          AND retry_after>clock_timestamp() AND last_error='injected campaign failure')
        OR EXISTS (SELECT * FROM campaign_before_failure EXCEPT
          SELECT *,ctid,xmin::text FROM team_campaign_point WHERE group_id='${group}')
        OR EXISTS (SELECT *,ctid,xmin::text FROM team_campaign_point WHERE group_id='${group}'
          EXCEPT SELECT * FROM campaign_before_failure)
        THEN RAISE EXCEPTION 'failure must retain delayed work and roll back every physical projection change'; END IF;
      IF refresh_team_campaigns(4)<>0 THEN RAISE EXCEPTION 'delayed failure was retried before its due time'; END IF;
    END $$;
    ${expectQueue([group], "only failed group remains queued")}
    UPDATE game SET home_score=3 WHERE id='${game}';
    DO $$ DECLARE processed integer; BEGIN
      IF NOT EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${group}'
        AND retry_after='-infinity'::timestamptz AND last_error IS NULL
        AND revision>(SELECT revision FROM campaign_pending_failure))
        THEN RAISE EXCEPTION 'new source revision must clear retry delay and error'; END IF;
      processed:=refresh_team_campaigns(4);
      IF processed<>0 OR NOT EXISTS (SELECT 1 FROM team_campaign_dirty WHERE group_id='${group}'
          AND retry_after>clock_timestamp() AND last_error='injected campaign failure')
        THEN RAISE EXCEPTION 'persistent failure must remain delayed and retryable'; END IF;
    END $$;
    DROP TRIGGER campaign_failure_test ON team_campaign_point;
    UPDATE game SET home_score=4 WHERE id='${game}';
    DO $$ DECLARE processed integer; BEGIN
      processed:=refresh_team_campaigns(4);
      IF processed<>1 THEN RAISE EXCEPTION 'corrected failed group did not complete'; END IF;
    END $$;
    ${expectQueue([], "retry must consume retained work")}

    DELETE FROM team_group WHERE group_id='${group}';
    ${expectQueue([group], "removing final memberships still queues the old group")}
    DO $$ DECLARE processed integer; BEGIN
      processed:=refresh_team_campaigns(4);
      IF processed<>1 OR EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}')
        OR EXISTS (SELECT 1 FROM team_campaign_dirty)
        THEN RAISE EXCEPTION 'empty membership refresh must remove stale campaign and consume work'; END IF;
    END $$;

    -- Certify legacy groups once even if their old projection happens to exist.
    DELETE FROM team_campaign_backfill WHERE version='034';
    ${migration}
    DO $$ BEGIN
      PERFORM pg_temp.assert_campaign_queue(ARRAY(SELECT id FROM stage_group),'initial retained certification');
      IF EXISTS (SELECT 1 FROM team_campaign_dirty WHERE NOT backfill)
        THEN RAISE EXCEPTION 'initial retained certification must have lower priority than live changes'; END IF;
    END $$;
    CREATE TEMP TABLE campaign_seed_versions AS SELECT *,ctid AS physical_row FROM team_campaign_dirty;
    ${migration}
    DO $$ BEGIN
      IF EXISTS (SELECT * FROM campaign_seed_versions EXCEPT SELECT *,ctid FROM team_campaign_dirty)
        OR EXISTS (SELECT *,ctid FROM team_campaign_dirty EXCEPT SELECT * FROM campaign_seed_versions)
        THEN RAISE EXCEPTION 'retained migration replay reset pending certification progress'; END IF;
    END $$;
    DELETE FROM team_campaign_dirty;
    ${migration}
    ${expectQueue([], "retained replay after completion must not reseed")}
    DO $$ BEGIN
      IF refresh_team_campaigns(4)<>0 THEN RAISE EXCEPTION 'restart after certification rebuilt completed groups'; END IF;
      IF has_function_privilege('anon','refresh_team_campaigns(integer)','EXECUTE')
        OR has_function_privilege('app_user','refresh_team_campaigns(integer)','EXECUTE')
        OR has_function_privilege('anon','enqueue_team_campaign(uuid)','EXECUTE')
        OR has_function_privilege('app_user','enqueue_team_campaign(uuid)','EXECUTE')
        OR NOT has_function_privilege('service','refresh_team_campaigns(integer)','EXECUTE')
        OR has_table_privilege('electric','team_campaign_dirty','SELECT')
        OR has_table_privilege('anon','team_campaign_dirty','SELECT')
        OR has_table_privilege('app_user','team_campaign_dirty','SELECT')
        OR has_table_privilege('anon','team_campaign_backfill','SELECT')
        OR has_table_privilege('app_user','team_campaign_backfill','SELECT')
        THEN RAISE EXCEPTION 'campaign work must remain service-only and outside Electric'; END IF;
    END $$;
    ROLLBACK;`);
  assertEquals(output, "");
});
