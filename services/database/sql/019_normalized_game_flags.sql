-- Flag visibility and countries now come from championship/team joins.
-- Retired columns remain for upgrade compatibility, outside the live writer.
SET lock_timeout = '5s';
SET statement_timeout = '1min';
BEGIN;

CREATE OR REPLACE FUNCTION copy_home_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO home_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group
  FROM unnest(game_ids) selected(id) JOIN game_card g USING (id)
  WHERE g.home_upcoming_rank > 0 OR g.home_recent_rank > 0
  ON CONFLICT (id) DO UPDATE SET
    phase_id = EXCLUDED.phase_id, championship_id = EXCLUDED.championship_id,
    round = EXCLUDED.round, day = EXCLUDED.day, kickoff = EXCLUDED.kickoff, played = EXCLUDED.played,
    home_id = EXCLUDED.home_id, away_id = EXCLUDED.away_id,
    home_name = EXCLUDED.home_name, away_name = EXCLUDED.away_name,
    home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
    home_aet = EXCLUDED.home_aet, away_aet = EXCLUDED.away_aet,
    home_pen = EXCLUDED.home_pen, away_pen = EXCLUDED.away_pen,
    championship_name = EXCLUDED.championship_name, phase_name = EXCLUDED.phase_name,
    stadium_name = EXCLUDED.stadium_name, referee_name = EXCLUDED.referee_name,
    attendance = EXCLUDED.attendance, stadium_id = EXCLUDED.stadium_id, referee_id = EXCLUDED.referee_id,
    home_upcoming_rank = EXCLUDED.home_upcoming_rank, home_recent_rank = EXCLUDED.home_recent_rank,
    home_upcoming_group = EXCLUDED.home_upcoming_group, home_recent_group = EXCLUDED.home_recent_group
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country']);
$$;

CREATE OR REPLACE FUNCTION copy_matches_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO matches_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group
  FROM unnest(game_ids) selected(id) JOIN game_card g USING (id)
  ON CONFLICT (id) DO UPDATE SET
    phase_id = EXCLUDED.phase_id, championship_id = EXCLUDED.championship_id,
    round = EXCLUDED.round, day = EXCLUDED.day, kickoff = EXCLUDED.kickoff, played = EXCLUDED.played,
    home_id = EXCLUDED.home_id, away_id = EXCLUDED.away_id,
    home_name = EXCLUDED.home_name, away_name = EXCLUDED.away_name,
    home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
    home_aet = EXCLUDED.home_aet, away_aet = EXCLUDED.away_aet,
    home_pen = EXCLUDED.home_pen, away_pen = EXCLUDED.away_pen,
    championship_name = EXCLUDED.championship_name, phase_name = EXCLUDED.phase_name,
    stadium_name = EXCLUDED.stadium_name, referee_name = EXCLUDED.referee_name,
    attendance = EXCLUDED.attendance, stadium_id = EXCLUDED.stadium_id, referee_id = EXCLUDED.referee_id,
    home_upcoming_rank = EXCLUDED.home_upcoming_rank, home_recent_rank = EXCLUDED.home_recent_rank,
    home_upcoming_group = EXCLUDED.home_upcoming_group, home_recent_group = EXCLUDED.home_recent_group
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country']);
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
