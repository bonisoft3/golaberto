-- Capture records history only. Its history triggers enqueue each group on
-- team_odds_chart_dirty, whose drain refreshes the charts and the odds
-- progress under its advisory lock; a refresh here would contend with that
-- drain for the same rows, and a lock_timeout would roll back the capture.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
CREATE OR REPLACE FUNCTION capture_team_odds_history() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp
SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE captured_time timestamptz := clock_timestamp(); captured integer;
BEGIN
  CREATE TEMP TABLE _computed_odds_groups ON COMMIT DROP AS
  SELECT DISTINCT tg.group_id
  FROM team_group tg
  JOIN team_chance tc ON tc.group_id=tg.group_id AND tc.team_id=tg.team_id
  JOIN stage_group sg ON sg.id=tg.group_id;
  IF NOT EXISTS (SELECT 1 FROM _computed_odds_groups) THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT tg.group_id,tg.team_id,s.group_size
      FROM team_group tg JOIN _computed_odds_groups ready USING (group_id)
      JOIN (SELECT group_id,count(*)::integer AS group_size FROM team_group GROUP BY group_id) s USING (group_id)
    ) members
    LEFT JOIN position_chance pc ON pc.group_id=members.group_id AND pc.team_id=members.team_id
    GROUP BY members.group_id,members.team_id,members.group_size
    HAVING count(pc.id)<>members.group_size OR count(DISTINCT pc.position)<>members.group_size
       OR min(pc.position)<>1 OR max(pc.position)<>members.group_size
       OR min(pc.percent)<0 OR max(pc.percent)>100
  ) THEN
    RAISE EXCEPTION 'odds computation did not publish a complete position vector';
  END IF;

  INSERT INTO team_odds_history AS target
    (id,group_id,team_id,recorded_on,captured_at,position,percent,source)
  SELECT pc.group_id::text||':'||pc.team_id::text||':'||(captured_time AT TIME ZONE 'UTC')::date::text||':'||pc.position::text,
    pc.group_id,pc.team_id,(captured_time AT TIME ZONE 'UTC')::date,captured_time,pc.position,pc.percent,'computed'
  FROM position_chance pc JOIN _computed_odds_groups ready USING (group_id)
  WHERE pc.percent BETWEEN 0 AND 100
  ON CONFLICT(id) DO UPDATE SET captured_at=EXCLUDED.captured_at,percent=EXCLUDED.percent,source='computed'
  WHERE (target.percent,target.source)
    IS DISTINCT FROM (EXCLUDED.percent,'computed');
  GET DIAGNOSTICS captured=ROW_COUNT;
  RETURN captured;
END $$;
