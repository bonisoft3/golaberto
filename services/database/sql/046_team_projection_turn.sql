-- The team-enrichment and team-profiles drains both write a team's roster
-- rows and its roster-total queue: profiles rewrites team_roster, whose
-- triggers enqueue roster totals, while enrichment deletes that queue and
-- reads team_roster, each in its own queue's order. Run together they
-- deadlocked, and Postgres aborting one is not a schedule. Each now takes one
-- turn lock before touching either table, so they run one after the other.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Blocking, unlike the drains' own try-locks: a call that returned without
-- running would leave its queue untouched, and a drain is woken only by its
-- queue changing. The wait is the other drain's one batch, and with that batch
-- it fits the service role's statement_timeout, which bounds the whole call:
-- a call that waits past it fails, and the transform retries it once the
-- other's batch is done, rather than being cancelled mid-batch every time.
CREATE OR REPLACE FUNCTION take_team_projection_turn() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(715030, 1);
  PERFORM set_config('lock_timeout', '2s', true);
END $$;
REVOKE ALL ON FUNCTION take_team_projection_turn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_team_projection_turn() TO service;

-- The call's own clock bounds the batch: the service role's statement_timeout
-- runs from the call's start, a function's SET cannot re-arm it, and a batch
-- it cancelled would roll back and be retried whole. Stopping short of it
-- commits what was done, and the queue's change wakes the drain for the rest.
CREATE OR REPLACE FUNCTION refresh_team_profiles(batch_size integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp
SET lock_timeout = '2s' AS $$
DECLARE
  v_local_day date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_previous_day date;
  item record;
  processed integer := 0;
BEGIN
  PERFORM take_team_projection_turn();
  IF NOT pg_try_advisory_xact_lock(715028, 1) THEN RETURN 0; END IF;

  SELECT c.local_day INTO v_previous_day FROM team_profile_clock c WHERE c.id;
  IF v_previous_day IS DISTINCT FROM v_local_day THEN
    IF v_previous_day IS NOT NULL THEN
      PERFORM enqueue_team_profiles_for_championship(c.id)
      FROM championship c
      WHERE (c.begins > LEAST(v_previous_day, v_local_day) AND c.begins <= GREATEST(v_previous_day, v_local_day))
         OR (c.ends >= LEAST(v_previous_day, v_local_day) AND c.ends < GREATEST(v_previous_day, v_local_day));
    END IF;
    UPDATE team_profile_clock SET local_day = v_local_day WHERE id;
  END IF;

  FOR item IN
    SELECT team_id, revision FROM team_profile_dirty ORDER BY revision, team_id LIMIT greatest(1, least(batch_size, 500))
  LOOP
    PERFORM refresh_one_team_profile(item.team_id);
    DELETE FROM team_profile_dirty WHERE team_id = item.team_id AND revision = item.revision;
    processed := processed + 1;
    EXIT WHEN clock_timestamp() - statement_timestamp() > interval '20s';
  END LOOP;
  RETURN processed;
END $$;

CREATE OR REPLACE FUNCTION refresh_team_enrichment(roster_batch integer DEFAULT 50,
  rating_batch integer DEFAULT 10,odds_batch integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp
SET lock_timeout='2s' AS $$
DECLARE roster_count integer:=0; rating_count integer:=0; odds_count integer:=0; metric_count integer;
BEGIN
  PERFORM take_team_projection_turn();
  -- As refresh_team_profiles: a stage the call's clock leaves no room for
  -- waits for the next call, which the earlier stages' queue changes wake.
  metric_count:=refresh_player_metric_queue(roster_batch);
  IF clock_timestamp()-statement_timestamp() < interval '20s' THEN roster_count:=refresh_team_roster_totals(roster_batch); END IF;
  IF clock_timestamp()-statement_timestamp() < interval '20s' THEN rating_count:=refresh_team_rating_charts(rating_batch); END IF;
  IF clock_timestamp()-statement_timestamp() < interval '20s' THEN odds_count:=refresh_team_odds_chart_queue(odds_batch); END IF;
  RETURN jsonb_build_object('roster_totals',roster_count,'rating_charts',rating_count,'odds_charts',odds_count,'player_metrics',metric_count);
END $$;
COMMIT;
