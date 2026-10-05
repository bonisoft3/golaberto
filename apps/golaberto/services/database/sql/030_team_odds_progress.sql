-- One shared-date position distribution per team/group. Historical source rows
-- and legacy per-zone projections are retained; only this bounded read model is new.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;
CREATE TABLE IF NOT EXISTS team_odds_progress (
  id portable_string PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  series_json portable_string NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (group_id,team_id),
  CHECK (id = group_id::text || ':' || team_id::text)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_odds_progress_group_team_idx ON team_odds_progress(group_id,team_id);
CALL rls_protect('team_odds_progress');
DROP POLICY IF EXISTS team_odds_progress_app_user_select ON team_odds_progress;
CREATE POLICY team_odds_progress_app_user_select ON team_odds_progress FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_odds_progress_service_all ON team_odds_progress;
CREATE POLICY team_odds_progress_service_all ON team_odds_progress FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_odds_progress FROM anon;
GRANT SELECT ON team_odds_progress TO app_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON team_odds_progress TO service;
GRANT SELECT ON team_odds_progress TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_odds_progress;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_odds_progress FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE team_odds_progress REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default'
    AND schemaname='public' AND tablename='team_odds_progress') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_odds_progress;
  END IF;
END $$;
-- tier: any

CREATE OR REPLACE FUNCTION build_team_odds_progress(target_group uuid,target_team uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH members AS (
    SELECT count(*)::integer AS n FROM team_group WHERE group_id=target_group
  ), zones AS (
    SELECT id,name,color,first,last FROM zone WHERE group_id=target_group
  ), daily AS (
    SELECT h.recorded_on,min(h.captured_at) AS captured_at,min(h.source::text) AS source,
      jsonb_object_agg(h.position::text,h.percent ORDER BY h.position) AS percentages,
      -- A 0.05 percentage-point tolerance admits rounding only; values are never
      -- normalized, clamped, filled or combined across different captures.
      count(*)=m.n AND min(h.position)=1 AND max(h.position)=m.n
        AND count(DISTINCT h.position)=m.n
        AND bool_and(h.percent BETWEEN 0 AND 100)
        AND abs(sum(h.percent::numeric)-100)<=0.05
        AND count(DISTINCT h.source)=1
        AND (count(h.captured_at)=0 OR
          (count(h.captured_at)=count(*) AND count(DISTINCT h.captured_at)=1)) AS complete
    FROM team_odds_history h CROSS JOIN members m
    WHERE h.group_id=target_group AND h.team_id=target_team
    GROUP BY h.recorded_on,m.n
  ), ordered AS (
    SELECT *,row_number() OVER(ORDER BY recorded_on) AS rn,count(*) OVER() AS n
    FROM daily WHERE complete
  ), picked AS (
    -- Retain a maximum of 360 shared dates including both endpoints. Sampling
    -- selects whole snapshots, so every position and hover value stays aligned.
    SELECT o.* FROM ordered o WHERE n<=360 OR rn IN (
      SELECT 1+floor(k::numeric*(o.n-1)/359)::bigint FROM generate_series(0,359) k
    )
  ), snapshots AS (
    SELECT d.recorded_on,jsonb_build_object('day',d.recorded_on::text,
      'capturedAt',CASE WHEN d.captured_at IS NULL THEN NULL ELSE
        to_char(d.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'source',d.source,'percentages',d.percentages,'lastGame',g.value,
      'zoneValues',coalesce((SELECT jsonb_object_agg(z.id::text,
        (SELECT coalesce(sum((d.percentages->>p::text)::numeric),0)
          FROM generate_series(greatest(1,z.first),least(m.n,z.last)) p))
        FROM zones z),'{}'::jsonb)) AS value
    FROM picked d CROSS JOIN members m
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id',g.id,'homeName',h.name,'awayName',a.name,
        'homeScore',g.home_score,'awayScore',g.away_score) AS value
      FROM stage_group sg JOIN game g ON g.phase_id=sg.phase_id
        JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
      WHERE sg.id=target_group AND g.played AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND (g.home_id=target_team OR g.away_id=target_team)
        AND CASE WHEN d.captured_at IS NULL THEN
          CASE WHEN g.kickoff IS NULL THEN g.day<=d.recorded_on
            ELSE g.kickoff < ((d.recorded_on+1)::timestamp AT TIME ZONE 'UTC') END
          ELSE CASE WHEN g.kickoff IS NULL THEN g.day < (d.captured_at AT TIME ZONE 'UTC')::date
            ELSE g.kickoff<=d.captured_at END END
      -- Unknown kickoff is eligible only before a known capture's UTC day;
      -- imported date-only snapshots use the end of their recorded UTC day.
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
      'color',coalesce((SELECT color::text FROM zones WHERE p BETWEEN first AND last ORDER BY first,last,id LIMIT 1),'none'),
      'zoneIds',coalesce((SELECT jsonb_agg(id ORDER BY first,last,id) FROM zones WHERE p BETWEEN first AND last),'[]'::jsonb))
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

-- Preserve the entry point used by both the revision-protected queue and the
-- post-commit capture hook. Existing per-zone rows remain untouched.
CREATE OR REPLACE FUNCTION refresh_team_odds_charts(target_group uuid) RETURNS integer
LANGUAGE sql SET search_path=public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
  SELECT refresh_team_odds_progress(target_group)
$$;

CREATE OR REPLACE FUNCTION mark_team_odds_game_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty(group_id,revision)
  SELECT DISTINCT sg.id,nextval('team_odds_chart_revision_seq')
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
  WHEN ((OLD.phase_id,OLD.home_id,OLD.away_id,OLD.day,OLD.kickoff,OLD.played,OLD.home_score,OLD.away_score)
    IS DISTINCT FROM (NEW.phase_id,NEW.home_id,NEW.away_id,NEW.day,NEW.kickoff,NEW.played,NEW.home_score,NEW.away_score))
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
