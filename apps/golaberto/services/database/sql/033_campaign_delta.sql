-- Campaign rebuilds publish only actual changes, so replay does not grow CDC logs.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE OR REPLACE FUNCTION replace_team_campaign_points(target_group uuid, rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array';
  END IF;
  -- Share the refresh lock with direct replacement callers. NO KEY UPDATE
  -- serializes this group without blocking foreign-key checks on its members.
  PERFORM 1 FROM stage_group WHERE id = target_group FOR NO KEY UPDATE;
  DELETE FROM team_campaign_point existing
  WHERE existing.group_id = target_group
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(rows) AS item(team_id uuid, game_id uuid)
      WHERE item.team_id = existing.team_id AND item.game_id = existing.game_id
    );
  INSERT INTO team_campaign_point AS existing
    (id, group_id, team_id, game_id, sequence, day, points, position, result)
  SELECT target_group::text || ':' || item.team_id::text || ':' || item.game_id::text,
    target_group, item.team_id, item.game_id, item.sequence, item.day, item.points, item.position, item.result
  FROM jsonb_to_recordset(rows) AS item(
    team_id uuid, game_id uuid, sequence integer, day date,
    points integer, position integer, result text
  )
  ON CONFLICT (id) DO UPDATE SET
    sequence = EXCLUDED.sequence, day = EXCLUDED.day, points = EXCLUDED.points,
    position = EXCLUDED.position, result = EXCLUDED.result
  WHERE (existing.sequence, existing.day, existing.points, existing.position, existing.result)
    IS DISTINCT FROM (EXCLUDED.sequence, EXCLUDED.day, EXCLUDED.points, EXCLUDED.position, EXCLUDED.result);
  -- The RPC contract counts reconstructed rows, including unchanged rows.
  RETURN jsonb_array_length(rows);
END $$;
REVOKE ALL ON FUNCTION replace_team_campaign_points(uuid, jsonb) FROM PUBLIC, anon, app_user;
GRANT EXECUTE ON FUNCTION replace_team_campaign_points(uuid, jsonb) TO service;

CREATE OR REPLACE FUNCTION refresh_team_campaign_group(target_group uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Acquire before computing: a waiter must read source data after the preceding
  -- refresh commits, rather than publishing a snapshot computed before waiting.
  PERFORM 1 FROM stage_group WHERE id = target_group FOR NO KEY UPDATE;
  RETURN replace_team_campaign_points(target_group, compute_team_campaign_rows(target_group));
END $$;
REVOKE ALL ON FUNCTION refresh_team_campaign_group(uuid) FROM PUBLIC, anon, app_user;
GRANT EXECUTE ON FUNCTION refresh_team_campaign_group(uuid) TO service;

NOTIFY pgrst, 'reload schema';
COMMIT;
