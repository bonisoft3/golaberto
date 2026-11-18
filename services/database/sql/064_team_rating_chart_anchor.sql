-- A rating chart's windows end at the team's latest rating, so a series changes
-- only when its ratings do, and the rating triggers queue exactly those teams.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE OR REPLACE FUNCTION refresh_one_team_rating_chart(target_team uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
DECLARE p record; data jsonb; latest date;
BEGIN
  -- Rating sources and dirty queue rows can outlive a deleted team. Remove
  -- any stale projection and let the bounded queue consume this orphan.
  IF NOT EXISTS (SELECT 1 FROM team WHERE id=target_team) THEN
    DELETE FROM team_rating_chart WHERE team_id=target_team;
    RETURN;
  END IF;
  SELECT max(measure_date) INTO latest FROM team_rating WHERE team_id=target_team;
  FOR p IN SELECT * FROM (VALUES ('1m',latest-interval '1 month'),('3m',latest-interval '3 months'),
    ('6m',latest-interval '6 months'),('1y',latest-interval '1 year'),('5y',latest-interval '5 years'),('all',NULL::timestamp)) v(period,cutoff)
  LOOP
    data := build_team_rating_series(target_team,p.cutoff::date);
    INSERT INTO team_rating_chart AS d(id,team_id,period,series_json)
    VALUES (target_team::text||':'||p.period,target_team,p.period,data::text)
    ON CONFLICT(id) DO UPDATE SET series_json=EXCLUDED.series_json
    WHERE d.series_json IS DISTINCT FROM EXCLUDED.series_json;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION refresh_team_rating_charts(batch_size integer DEFAULT 30) RETURNS integer
LANGUAGE plpgsql SET search_path = public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE item record; processed integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715029,1) THEN RETURN 0; END IF;
  FOR item IN SELECT team_id,revision FROM team_rating_chart_dirty ORDER BY revision,team_id LIMIT greatest(1,least(batch_size,100)) LOOP
    PERFORM refresh_one_team_rating_chart(item.team_id);
    DELETE FROM team_rating_chart_dirty WHERE team_id=item.team_id AND revision=item.revision;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;

-- Charts drawn before this anchor are re-anchored once.
SELECT enqueue_team_rating_chart(id) FROM team;
COMMIT;
