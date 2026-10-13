-- The homepage feeds are computed when they are read, as home_feed. Their
-- selection is a function of now() -- the three-hour grace after kickoff, the
-- fourteen-day windows, each game's decay from the reference instant and the
-- latest rating on today's date -- so a stored copy is stale between refreshes
-- by construction. What is stored is the data the read needs, shaped so a cold
-- read touches few pages: GameCard's window through one covering index, and
-- each team's latest rating in a table of one row per team rather than an
-- eight-million-row index walked once per candidate team. On the full archive
-- the read went from about 750 page reads to about 70.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP TRIGGER IF EXISTS sync_home_game_card_insert ON game_card;
DROP TRIGGER IF EXISTS sync_home_game_card_update ON game_card;
DROP TRIGGER IF EXISTS sync_home_game_card_delete ON game_card;
DROP FUNCTION IF EXISTS refresh_home_games();
DROP FUNCTION IF EXISTS copy_home_game_cards(uuid[]);
DROP FUNCTION IF EXISTS sync_home_game_card();
-- pgroll runs this in one transaction, where no index drops concurrently.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS game_card_home_upcoming_idx;
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS game_card_home_recent_idx;
-- The window's candidates are read from the index alone.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS game_card_home_kickoff_idx;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_home_window_idx ON game_card (kickoff)
  INCLUDE (id, played, phase_id, home_id, away_id) WHERE kickoff IS NOT NULL;

-- Each team's newest rating, kept in step with team_rating by statement
-- triggers, so a write and the read that follows it agree. A rating dated
-- after the read's day is not the latest the read wants; the selection falls
-- back to team_rating for that team alone.
CREATE TABLE IF NOT EXISTS team_latest_rating (
  team_id uuid PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,
  rating double precision,
  measure_date date NOT NULL,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('team_latest_rating');
DROP POLICY IF EXISTS team_latest_rating_app_user_select ON team_latest_rating;
CREATE POLICY team_latest_rating_app_user_select ON team_latest_rating FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_latest_rating_service_all ON team_latest_rating;
CREATE POLICY team_latest_rating_service_all ON team_latest_rating FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_latest_rating FROM PUBLIC, anon, app_user, service;
GRANT SELECT ON team_latest_rating TO anon, app_user, service;

CREATE OR REPLACE FUNCTION refresh_team_latest_ratings(teams uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO team_latest_rating AS l (team_id, rating, measure_date)
  SELECT t.id, r.rating, r.measure_date
  FROM (SELECT DISTINCT unnest(teams) AS id) t
  JOIN team ON team.id = t.id
  CROSS JOIN LATERAL (
    SELECT rating, measure_date FROM team_rating WHERE team_id = t.id
    ORDER BY measure_date DESC, id LIMIT 1
  ) r
  ON CONFLICT (team_id) DO UPDATE SET rating = EXCLUDED.rating, measure_date = EXCLUDED.measure_date
  WHERE (l.rating, l.measure_date) IS DISTINCT FROM (EXCLUDED.rating, EXCLUDED.measure_date);
  DELETE FROM team_latest_rating l WHERE l.team_id = ANY(teams)
    AND NOT EXISTS (SELECT 1 FROM team_rating r WHERE r.team_id = l.team_id);
$$;
CREATE OR REPLACE FUNCTION team_latest_rating_inserted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM refresh_team_latest_ratings(ARRAY(SELECT DISTINCT team_id FROM new_rows));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION team_latest_rating_updated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM refresh_team_latest_ratings(ARRAY(SELECT team_id FROM new_rows UNION SELECT team_id FROM old_rows));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION team_latest_rating_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM refresh_team_latest_ratings(ARRAY(SELECT DISTINCT team_id FROM old_rows));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION refresh_team_latest_ratings(uuid[]), team_latest_rating_inserted(),
  team_latest_rating_updated(), team_latest_rating_deleted() FROM PUBLIC;
DROP TRIGGER IF EXISTS team_latest_rating_insert ON team_rating;
CREATE TRIGGER team_latest_rating_insert AFTER INSERT ON team_rating
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION team_latest_rating_inserted();
DROP TRIGGER IF EXISTS team_latest_rating_update ON team_rating;
CREATE TRIGGER team_latest_rating_update AFTER UPDATE ON team_rating
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION team_latest_rating_updated();
DROP TRIGGER IF EXISTS team_latest_rating_delete ON team_rating;
CREATE TRIGGER team_latest_rating_delete AFTER DELETE ON team_rating
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION team_latest_rating_deleted();
SELECT refresh_team_latest_ratings(ARRAY(SELECT id FROM team));

-- The ranks GameCard carried are retired; the matches copy stops carrying them.
CREATE OR REPLACE FUNCTION copy_matches_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO matches_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id
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
    attendance = EXCLUDED.attendance, stadium_id = EXCLUDED.stadium_id, referee_id = EXCLUDED.referee_id
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country',
      'home_upcoming_rank', 'home_recent_rank', 'home_upcoming_group', 'home_recent_group'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country',
      'home_upcoming_rank', 'home_recent_rank', 'home_upcoming_group', 'home_recent_group']);
$$;

-- The window is one kickoff range the covering index answers alone; ratings
-- come from team_latest_rating unless a team's newest is dated after the day.
CREATE OR REPLACE FUNCTION home_game_selection(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer, highlighted boolean)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH reference AS (
    SELECT at_time - interval '3 hours' AS kickoff_reference
  ), candidates AS MATERIALIZED (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.home_id, g.away_id,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day
    FROM game_card g CROSS JOIN reference r
    WHERE g.kickoff > r.kickoff_reference - interval '14 days' AND g.kickoff < at_time + interval '14 days' AND (
      (NOT g.played AND g.kickoff > r.kickoff_reference
        AND g.kickoff < at_time + interval '14 days')
      OR (g.played AND g.kickoff > r.kickoff_reference - interval '14 days'
        AND g.kickoff < r.kickoff_reference + interval '14 days')
    )
  ), quality AS (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.local_day,
      COALESCE(2.0 * r.home * r.away / NULLIF(r.home + r.away, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0) AS raw_quality,
      COALESCE(2.0 * r.home * r.away / NULLIF(r.home + r.away, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0)
        / power(2.0, abs(extract(epoch FROM (g.kickoff - (at_time - interval '3 hours'))) / 86400.0)) AS weighted_quality
    FROM candidates g
    LEFT JOIN team_latest_rating hl ON hl.team_id = g.home_id
    LEFT JOIN team_latest_rating al ON al.team_id = g.away_id
    CROSS JOIN LATERAL (SELECT
      CASE WHEN hl.measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN hl.rating WHEN hl.team_id IS NOT NULL THEN
        (SELECT rating FROM team_rating WHERE team_id = g.home_id AND measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY measure_date DESC, id LIMIT 1) END AS home,
      CASE WHEN al.measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN al.rating WHEN al.team_id IS NOT NULL THEN
        (SELECT rating FROM team_rating WHERE team_id = g.away_id AND measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY measure_date DESC, id LIMIT 1) END AS away) r
    LEFT JOIN game_importance i ON i.id = g.id
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY played
      ORDER BY weighted_quality DESC, raw_quality DESC, kickoff DESC, id) AS pick,
      max(weighted_quality) OVER (PARTITION BY played, phase_id, local_day) AS phase_day_quality
    FROM quality
  ), phase_day_winners AS (
    SELECT DISTINCT ON (played, phase_id, local_day) id
    FROM quality
    ORDER BY played, phase_id, local_day,
      weighted_quality DESC, raw_quality ASC, kickoff ASC, id DESC
  ), presentation AS (
    SELECT p.*,
      row_number() OVER (PARTITION BY played ORDER BY
        CASE WHEN NOT played THEN local_day END ASC,
        CASE WHEN played THEN local_day END DESC,
        phase_day_quality DESC,
        CASE WHEN NOT played THEN kickoff END ASC,
        CASE WHEN played THEN kickoff END DESC,
        weighted_quality DESC, id)::integer AS feed_rank
    FROM ranked p WHERE pick <= 20
  ), highlighted AS (
    SELECT p.id, p.played, p.feed_rank,
      (p.raw_pick <= 5 OR w.id IS NOT NULL) AS highlighted
    FROM (
      SELECT presentation.*, row_number() OVER (PARTITION BY played ORDER BY raw_quality DESC, feed_rank) AS raw_pick
      FROM presentation
    ) p
    LEFT JOIN phase_day_winners w ON w.id = p.id
  )
  SELECT id, played, feed_rank, highlighted FROM highlighted;
$$;

-- The stored projection goes, and so does the table a generated baseline
-- declares for the view before this replaces it. pgroll's version schemas
-- hold views over both. The stored one keeps its old name, not the view's,
-- because migrations 013 to 021 replay against it on every fresh volume.
DO $$ DECLARE target text; alias record; BEGIN
  FOREACH target IN ARRAY ARRAY['home_game_card', 'home_feed'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || target) AND relkind = 'r') THEN
      IF to_regclass('pgroll.migrations') IS NOT NULL THEN
        FOR alias IN SELECT n.nspname, c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pgroll.migrations m ON n.nspname = m.schema || '_' || m.name
          WHERE m.schema = 'public' AND c.relname = target AND c.relkind = 'v'
        LOOP EXECUTE format('DROP VIEW %I.%I', alias.nspname, alias.relname); END LOOP;
      END IF;
      EXECUTE format('DROP TABLE %I', target);
    END IF;
  END LOOP;
END $$;

-- Each column traces to game_card, so PostgREST embeds through its keys. A
-- row heads its day when the previous row of its feed falls on another day,
-- and its phase when either the day or the phase changes.
CREATE OR REPLACE VIEW home_feed WITH (security_invoker = true) AS
SELECT g.id, g.phase_id, g.championship_id, g.round, s.local_day AS day, g.kickoff, g.played,
  g.home_id, g.away_id, g.home_name, g.away_name, g.home_score, g.away_score,
  g.home_aet, g.away_aet, g.home_pen, g.away_pen, g.championship_name, g.phase_name,
  g.stadium_name, g.referee_name, g.attendance,
  lpad(extract(day FROM s.local_day)::int::text, 2, '0') || '/' || lpad(extract(month FROM s.local_day)::int::text, 2, '0')
    || '/' || extract(year FROM s.local_day)::int::text AS day_display,
  lpad(extract(hour FROM (g.kickoff AT TIME ZONE 'America/Sao_Paulo'))::int::text, 2, '0') || ':'
    || lpad(extract(minute FROM (g.kickoff AT TIME ZONE 'America/Sao_Paulo'))::int::text, 2, '0') AS kickoff_local,
  g.stadium_id, g.referee_id,
  CASE WHEN s.is_played THEN 0 ELSE s.feed_rank END AS home_upcoming_rank,
  CASE WHEN s.is_played THEN s.feed_rank ELSE 0 END AS home_recent_rank,
  NOT s.is_played AND s.new_group AS home_upcoming_group,
  s.is_played AND s.new_group AS home_recent_group,
  false AS show_country, ''::text AS home_country, ''::text AS away_country,
  s.highlighted AS home_highlighted,
  s.new_day AS home_new_day,
  NULL::bigint AS txid, 'public:'::text AS scope_id
FROM (
  SELECT o.*,
    lag(o.local_day) OVER feed IS DISTINCT FROM o.local_day AS new_day,
    (lag(o.local_day) OVER feed, lag(o.phase_id) OVER feed) IS DISTINCT FROM (o.local_day, o.phase_id) AS new_group
  FROM (
    SELECT sel.game_id, sel.is_played, sel.feed_rank, sel.highlighted, c.phase_id,
      (c.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day
    FROM home_game_selection(now()) sel JOIN game_card c ON c.id = sel.game_id
  ) o
  WINDOW feed AS (PARTITION BY o.is_played ORDER BY o.feed_rank)
) s
JOIN game_card g ON g.id = s.game_id;

-- The schema's default privileges grant every role writes on a new relation.
REVOKE ALL ON home_feed FROM PUBLIC, anon, app_user, service;
GRANT SELECT ON home_feed TO anon, app_user, service;
GRANT EXECUTE ON FUNCTION home_game_selection(timestamptz) TO anon, app_user;

NOTIFY pgrst, 'reload schema';
COMMIT;
