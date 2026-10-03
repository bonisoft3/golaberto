-- Championship-controlled team countries in the existing local game feeds.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

ALTER TABLE game_card ADD COLUMN IF NOT EXISTS show_country portable_bool NOT NULL DEFAULT false;
ALTER TABLE game_card ADD COLUMN IF NOT EXISTS home_country portable_string NOT NULL DEFAULT '';
ALTER TABLE game_card ADD COLUMN IF NOT EXISTS away_country portable_string NOT NULL DEFAULT '';
ALTER TABLE home_game_card ADD COLUMN IF NOT EXISTS show_country portable_bool NOT NULL DEFAULT false;
ALTER TABLE home_game_card ADD COLUMN IF NOT EXISTS home_country portable_string NOT NULL DEFAULT '';
ALTER TABLE home_game_card ADD COLUMN IF NOT EXISTS away_country portable_string NOT NULL DEFAULT '';
ALTER TABLE matches_game_card ADD COLUMN IF NOT EXISTS show_country portable_bool NOT NULL DEFAULT false;
ALTER TABLE matches_game_card ADD COLUMN IF NOT EXISTS home_country portable_string NOT NULL DEFAULT '';
ALTER TABLE matches_game_card ADD COLUMN IF NOT EXISTS away_country portable_string NOT NULL DEFAULT '';
ALTER TABLE team_game ADD COLUMN IF NOT EXISTS show_country portable_bool NOT NULL DEFAULT false;
ALTER TABLE team_game ADD COLUMN IF NOT EXISTS opponent_country portable_string NOT NULL DEFAULT '';

-- Copy country metadata along with the selected card; membership stays bounded.
CREATE OR REPLACE FUNCTION copy_home_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO home_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group,
    show_country, home_country, away_country
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group,
    g.show_country, g.home_country, g.away_country
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
    home_upcoming_group = EXCLUDED.home_upcoming_group, home_recent_group = EXCLUDED.home_recent_group,
    show_country = EXCLUDED.show_country, home_country = EXCLUDED.home_country, away_country = EXCLUDED.away_country
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local']);
$$;

CREATE OR REPLACE FUNCTION copy_matches_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO matches_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group,
    show_country, home_country, away_country
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group,
    g.show_country, g.home_country, g.away_country
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
    home_upcoming_group = EXCLUDED.home_upcoming_group, home_recent_group = EXCLUDED.home_recent_group,
    show_country = EXCLUDED.show_country, home_country = EXCLUDED.home_country, away_country = EXCLUDED.away_country
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local']);
$$;

-- Existing cards receive metadata immediately; replay does not rewrite them.
UPDATE game_card g SET show_country = c.show_country,
  home_country = h.country, away_country = a.country
FROM championship c, team h, team a
WHERE c.id = g.championship_id AND h.id = g.home_id AND a.id = g.away_id
  AND (g.show_country, g.home_country, g.away_country)
    IS DISTINCT FROM (c.show_country, h.country, a.country);
UPDATE team_game t SET show_country = g.show_country,
  opponent_country = CASE WHEN t.side = 'home' THEN g.away_country ELSE g.home_country END
FROM game_card g WHERE g.id = t.game_id
  AND (t.show_country, t.opponent_country) IS DISTINCT FROM
    (g.show_country, CASE WHEN t.side = 'home' THEN g.away_country ELSE g.home_country END);
SELECT copy_home_game_cards(COALESCE(array_agg(id), ARRAY[]::uuid[])) FROM home_game_card;
SELECT copy_matches_game_cards(COALESCE(array_agg(id), ARRAY[]::uuid[])) FROM matches_game_card;
NOTIFY pgrst, 'reload schema';
COMMIT;
