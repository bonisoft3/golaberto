-- One shared-date position distribution per team and group, drained by the
-- existing team_odds_chart_dirty queue beside the per-zone histories.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;
CREATE TABLE IF NOT EXISTS team_odds_progress (
  id text PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  series_json text NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_odds_progress_group_id ON team_odds_progress USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_team_odds_progress_team_id ON team_odds_progress USING btree (team_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_odds_progress_group_team ON team_odds_progress (group_id, team_id);
CALL rls_protect('team_odds_progress');
DROP POLICY IF EXISTS team_odds_progress_app_user_select ON team_odds_progress;
CREATE POLICY team_odds_progress_app_user_select ON team_odds_progress FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_odds_progress_service_all ON team_odds_progress;
CREATE POLICY team_odds_progress_service_all ON team_odds_progress FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_odds_progress FROM anon;
GRANT SELECT ON team_odds_progress TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_odds_progress TO service;
GRANT SELECT ON team_odds_progress TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_odds_progress;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_odds_progress
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_odds_progress REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_odds_progress') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_odds_progress;
  END IF;
END $$;
-- tier: any

-- A recorded day is one complete vector: every position once, within 0..100,
-- summing to 100 within rounding, from one source. Capture rewrites only the
-- cells whose percent moved, so a day's capture time is its latest cell.
CREATE OR REPLACE FUNCTION build_team_odds_progress(target_group uuid,target_team uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH members AS (
    SELECT count(*)::integer AS n FROM team_group WHERE group_id=target_group
  ), zones AS (
    SELECT z.id,z.name,z.color,z.first,z.last,
      CASE WHEN z.positions<>'' THEN competition_zone_positions(z.positions)
        ELSE ARRAY(SELECT generate_series(z.first,z.last)) END AS positions
    FROM zone z WHERE z.group_id=target_group
  ), daily AS (
    SELECT h.recorded_on,max(h.captured_at) AS captured_at,min(h.source) AS source,
      jsonb_object_agg(h.position::text,h.percent ORDER BY h.position) AS percentages,
      count(*)=m.n AND min(h.position)=1 AND max(h.position)=m.n
        AND count(DISTINCT h.position)=m.n
        AND bool_and(h.percent BETWEEN 0 AND 100)
        AND abs(sum(h.percent::numeric)-100)<=0.05
        AND count(DISTINCT h.source)=1 AS complete
    FROM team_odds_history h CROSS JOIN members m
    WHERE h.group_id=target_group AND h.team_id=target_team
    GROUP BY h.recorded_on,m.n
  ), ordered AS (
    SELECT *,row_number() OVER(ORDER BY recorded_on) AS rn,count(*) OVER() AS total
    FROM daily WHERE complete
  ), picked AS (
    -- At most 360 whole snapshots, both endpoints kept, so every position and
    -- hover value of a retained day stays aligned.
    SELECT o.* FROM ordered o WHERE total<=360 OR rn IN (
      SELECT 1+floor(k::numeric*(o.total-1)/359)::bigint FROM generate_series(0,359) k
    )
  ), snapshots AS (
    SELECT d.recorded_on,jsonb_build_object('day',d.recorded_on::text,
      'source',d.source,'percentages',d.percentages,'lastGame',g.value,
      'zoneValues',coalesce((SELECT jsonb_object_agg(z.id::text,
        (SELECT coalesce(sum((d.percentages->>p::text)::numeric),0)
          FROM unnest(z.positions) p WHERE p BETWEEN 1 AND m.n))
        FROM zones z),'{}'::jsonb)) AS value
    FROM picked d CROSS JOIN members m
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('slug',g.slug,'homeName',h.name,'awayName',a.name,
        'homeScore',g.home_score,'awayScore',g.away_score) AS value
      FROM stage_group sg JOIN game g ON g.phase_id=sg.phase_id
        JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
      WHERE sg.id=target_group AND g.played AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND (g.home_id=target_team OR g.away_id=target_team)
        -- An imported date-only snapshot closes at the end of its UTC day; an
        -- unknown kickoff counts only before a known capture's UTC day.
        AND CASE WHEN d.captured_at IS NULL THEN
          CASE WHEN g.kickoff IS NULL THEN g.day<=d.recorded_on
            ELSE g.kickoff < ((d.recorded_on+1)::timestamp AT TIME ZONE 'UTC') END
          ELSE CASE WHEN g.kickoff IS NULL THEN g.day < (d.captured_at AT TIME ZONE 'UTC')::date
            ELSE g.kickoff<=d.captured_at END END
      ORDER BY g.day DESC,g.kickoff DESC NULLS LAST,g.id DESC LIMIT 1
    ) g ON true
  )
  SELECT jsonb_build_object('version',1,'kind','odds-progress','positionCount',m.n,
    'sourceCount',(SELECT count(*) FROM daily),
    'retainedCount',(SELECT count(*) FROM picked),
    'omittedCount',(SELECT count(*) FROM daily WHERE NOT complete),
    'zones',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'color',color,
      'first',first,'last',last) ORDER BY first,last,id) FROM zones),'[]'::jsonb),
    'positions',coalesce((SELECT jsonb_agg(jsonb_build_object('position',p,
      'color',(SELECT color FROM zones WHERE p=ANY(positions) ORDER BY first,last,id LIMIT 1),
      'zoneIds',coalesce((SELECT jsonb_agg(id ORDER BY first,last,id) FROM zones WHERE p=ANY(positions)),'[]'::jsonb))
      ORDER BY p DESC) FROM generate_series(1,m.n) p),'[]'::jsonb),
    'snapshots',coalesce((SELECT jsonb_agg(value ORDER BY recorded_on) FROM snapshots),'[]'::jsonb))
  FROM members m
$$;

CREATE OR REPLACE FUNCTION refresh_team_odds_progress(target_group uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE changed integer; removed integer;
BEGIN
  INSERT INTO team_odds_progress AS d(id,group_id,team_id,series_json)
  SELECT target_group::text||':'||m.team_id::text,target_group,m.team_id,
    build_team_odds_progress(target_group,m.team_id)::text
  FROM team_group m WHERE m.group_id=target_group
  ON CONFLICT(id) DO UPDATE SET series_json=EXCLUDED.series_json
  WHERE d.series_json IS DISTINCT FROM EXCLUDED.series_json;
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM team_odds_progress d WHERE d.group_id=target_group AND NOT EXISTS (
    SELECT 1 FROM team_group m WHERE m.group_id=d.group_id AND m.team_id=d.team_id
  );
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN changed+removed;
END $$;

-- The queue drain and the post-capture hook both call this entry point.
CREATE OR REPLACE FUNCTION refresh_team_odds_charts(target_group uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE changed integer;
BEGIN
  INSERT INTO team_odds_chart AS d(id,group_id,team_id,zone_id,series_json)
  SELECT g.id::text||':'||m.team_id::text||':'||z.id::text,g.id,m.team_id,z.id,
    build_team_odds_series(g.id,m.team_id,z.first,z.last,z.positions)::text
  FROM stage_group g JOIN team_group m ON m.group_id=g.id JOIN zone z ON z.group_id=g.id WHERE g.id=target_group
  ON CONFLICT(id) DO UPDATE SET series_json=EXCLUDED.series_json WHERE d.series_json IS DISTINCT FROM EXCLUDED.series_json;
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM team_odds_chart d WHERE d.group_id=target_group AND NOT EXISTS (
    SELECT 1 FROM team_group m JOIN zone z ON z.group_id=m.group_id
    WHERE m.group_id=d.group_id AND m.team_id=d.team_id AND z.id=d.zone_id);
  RETURN changed+refresh_team_odds_progress(target_group);
END $$;

-- A snapshot names the team's last result before it, so game edits, a group's
-- phase and team names re-queue groups that have recorded history.
CREATE OR REPLACE FUNCTION mark_team_odds_game_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty(group_id,revision)
  SELECT sg.id,nextval('team_odds_chart_revision_seq')
  FROM stage_group sg WHERE EXISTS (
    SELECT 1 FROM team_group m WHERE m.group_id=sg.id AND (
      (TG_OP<>'INSERT' AND sg.phase_id=OLD.phase_id AND m.team_id IN (OLD.home_id,OLD.away_id)) OR
      (TG_OP<>'DELETE' AND sg.phase_id=NEW.phase_id AND m.team_id IN (NEW.home_id,NEW.away_id))))
    AND EXISTS (SELECT 1 FROM team_odds_history h WHERE h.group_id=sg.id)
  ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_game_insert_delete ON game;
CREATE TRIGGER team_odds_game_insert_delete AFTER INSERT OR DELETE ON game
  FOR EACH ROW EXECUTE FUNCTION mark_team_odds_game_dirty();
DROP TRIGGER IF EXISTS team_odds_game_update ON game;
CREATE TRIGGER team_odds_game_update AFTER UPDATE ON game FOR EACH ROW
  WHEN ((OLD.phase_id,OLD.home_id,OLD.away_id,OLD.day,OLD.kickoff,OLD.played,OLD.home_score,OLD.away_score,OLD.slug)
    IS DISTINCT FROM (NEW.phase_id,NEW.home_id,NEW.away_id,NEW.day,NEW.kickoff,NEW.played,NEW.home_score,NEW.away_score,NEW.slug))
  EXECUTE FUNCTION mark_team_odds_game_dirty();

CREATE OR REPLACE FUNCTION mark_team_odds_group_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM enqueue_team_odds_chart(NEW.id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_group_update ON stage_group;
CREATE TRIGGER team_odds_group_update AFTER UPDATE OF phase_id ON stage_group FOR EACH ROW
  WHEN (OLD.phase_id IS DISTINCT FROM NEW.phase_id) EXECUTE FUNCTION mark_team_odds_group_dirty();

CREATE OR REPLACE FUNCTION mark_team_odds_name_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty(group_id,revision)
  SELECT sg.id,nextval('team_odds_chart_revision_seq') FROM stage_group sg
  WHERE EXISTS (SELECT 1 FROM game g WHERE g.phase_id=sg.phase_id AND (g.home_id=NEW.id OR g.away_id=NEW.id))
    AND EXISTS (SELECT 1 FROM team_odds_history h WHERE h.group_id=sg.id)
  ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_name_update ON team;
CREATE TRIGGER team_odds_name_update AFTER UPDATE OF name ON team FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION mark_team_odds_name_dirty();

REVOKE ALL ON FUNCTION build_team_odds_progress(uuid,uuid),refresh_team_odds_progress(uuid),
  mark_team_odds_game_dirty(),mark_team_odds_group_dirty(),mark_team_odds_name_dirty() FROM PUBLIC,anon,app_user;
GRANT EXECUTE ON FUNCTION build_team_odds_progress(uuid,uuid),refresh_team_odds_progress(uuid) TO service;
INSERT INTO team_odds_chart_dirty(group_id,revision)
SELECT group_id,nextval('team_odds_chart_revision_seq') FROM (SELECT DISTINCT group_id FROM team_odds_history) groups
ON CONFLICT(group_id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
