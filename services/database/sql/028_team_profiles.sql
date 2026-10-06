-- On-demand, team-scoped profile projections. Source writes mark only the
-- affected teams; the clock worker drains a bounded number on each request.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- These values are projected into team_roster below. Declare them here as
-- well as in the later additive migration so retained installs can create the
-- profile function before the enrichment migration runs.
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS off_rating double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS def_rating double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS contribution double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS contribution_per90 double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS goals_per90 double precision;

-- Each lookup starts with a team or phase. The archive is large enough that
-- rebuilding one profile must not scan every registration or appearance.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_player_team_profile_idx
  ON team_player (team_id, championship_id, player_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_stat_team_profile_idx
  ON player_stat (team_id, championship_id, player_id);
-- Championship edits and date-boundary refreshes enumerate one competition's
-- teams, so this reverse order keeps those events candidate-scoped too.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_stat_champ_team_profile_idx
  ON player_stat (championship_id, team_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_group_team_profile_idx
  ON team_group (team_id, group_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_home_team_phase_profile_idx
  ON game (home_id, phase_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_away_team_phase_profile_idx
  ON game (away_id, phase_id);
-- Championship pages page one team's games within one competition.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_game_team_champ_upcoming_idx
  ON team_game (team_id, championship_id, day, kickoff, id) WHERE NOT played;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_game_team_champ_results_idx
  ON team_game (team_id, championship_id, day DESC, kickoff DESC, id) WHERE played;

CREATE TABLE IF NOT EXISTS team_championship (
  id text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  championship_id uuid NOT NULL REFERENCES championship(id) ON DELETE CASCADE,
  championship_name text NOT NULL,
  begins date NOT NULL,
  ends date NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'upcoming', 'past')),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (team_id, championship_id)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_championship_team_status_order_idx
  ON team_championship (team_id, status, begins DESC, championship_id);
CALL rls_protect('team_championship');
DROP POLICY IF EXISTS team_championship_app_user_select ON team_championship;
CREATE POLICY team_championship_app_user_select ON team_championship FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_championship_service_all ON team_championship;
CREATE POLICY team_championship_service_all ON team_championship FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON team_championship TO anon, app_user, service;
GRANT SELECT ON team_championship TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_championship;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_championship
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE team_championship REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_championship') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_championship;
  END IF;
END $$;
-- tier: any

CREATE TABLE IF NOT EXISTS team_roster (
  id text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  championship_id uuid NOT NULL REFERENCES championship(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  player_name text NOT NULL,
  position text NOT NULL DEFAULT '' CHECK (position IN ('', 'g', 'dr', 'dc', 'dl', 'dm', 'cm', 'am', 'fw')),
  played integer NOT NULL DEFAULT 0 CHECK (played >= 0),
  started integer NOT NULL DEFAULT 0 CHECK (started >= 0),
  came_on integer NOT NULL DEFAULT 0 CHECK (came_on >= 0),
  bench integer NOT NULL DEFAULT 0 CHECK (bench >= 0),
  minutes integer NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  goals integer NOT NULL DEFAULT 0 CHECK (goals >= 0),
  penalties integer NOT NULL DEFAULT 0 CHECK (penalties >= 0),
  own_goals integer NOT NULL DEFAULT 0 CHECK (own_goals >= 0),
  yellow integer NOT NULL DEFAULT 0 CHECK (yellow >= 0),
  red integer NOT NULL DEFAULT 0 CHECK (red >= 0),
  championship_name text NOT NULL,
  off_rating double precision,
  def_rating double precision,
  contribution double precision,
  contribution_per90 double precision,
  goals_per90 double precision,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (team_id, championship_id, player_id)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_roster_team_championship_order_idx
  ON team_roster (team_id, championship_id, player_name, player_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_roster_team_player_order_idx
  ON team_roster (team_id, player_name, player_id);
CALL rls_protect('team_roster');
DROP POLICY IF EXISTS team_roster_app_user_select ON team_roster;
CREATE POLICY team_roster_app_user_select ON team_roster FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_roster_service_all ON team_roster;
CREATE POLICY team_roster_service_all ON team_roster FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON team_roster TO anon, app_user, service;
GRANT SELECT ON team_roster TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_roster;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_roster
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE team_roster REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_roster') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_roster;
  END IF;
END $$;
-- tier: any

CREATE TABLE IF NOT EXISTS team_player_history (
  id text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  player_name text NOT NULL,
  position text NOT NULL DEFAULT '' CHECK (position IN ('', 'g', 'dr', 'dc', 'dl', 'dm', 'cm', 'am', 'fw')),
  country text,
  is_current boolean NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (team_id, player_id)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_player_history_team_current_order_idx
  ON team_player_history (team_id, is_current DESC, player_name, player_id);
CALL rls_protect('team_player_history');
DROP POLICY IF EXISTS team_player_history_app_user_select ON team_player_history;
CREATE POLICY team_player_history_app_user_select ON team_player_history FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_player_history_service_all ON team_player_history;
CREATE POLICY team_player_history_service_all ON team_player_history FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON team_player_history TO anon, app_user, service;
GRANT SELECT ON team_player_history TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_player_history;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_player_history
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE team_player_history REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_player_history') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_player_history;
  END IF;
END $$;
-- tier: any

-- Queue rows deliberately have no team FK: a deleted team still needs its
-- queue entry to be removed after cascading its public projection rows.
CREATE SEQUENCE IF NOT EXISTS team_profile_revision_seq;
CREATE TABLE IF NOT EXISTS team_profile_dirty (
  team_id uuid PRIMARY KEY,
  revision bigint NOT NULL
);
-- The worker drains in this order; the index avoids sorting the pending queue.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_profile_dirty_revision_team_idx
  ON team_profile_dirty (revision, team_id);
CREATE TABLE IF NOT EXISTS team_profile_clock (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  local_day date NOT NULL
);
INSERT INTO team_profile_clock (id, local_day)
VALUES (true, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS team_profile_backfill (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  completed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON team_profile_dirty, team_profile_clock, team_profile_backfill FROM PUBLIC, anon, app_user, electric;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_profile_dirty, team_profile_clock, team_profile_backfill TO service;
GRANT USAGE, SELECT ON SEQUENCE team_profile_revision_seq TO service;

CREATE OR REPLACE FUNCTION enqueue_team_profile(target_team uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO team_profile_dirty (team_id, revision)
  VALUES (target_team, nextval('team_profile_revision_seq'))
  ON CONFLICT (team_id) DO UPDATE SET revision = EXCLUDED.revision;
$$;

CREATE OR REPLACE FUNCTION enqueue_team_profiles_for_phase(target_phase uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN SELECT x.team_id FROM (
    SELECT tg.team_id FROM stage_group g JOIN team_group tg ON tg.group_id = g.id WHERE g.phase_id = target_phase
    UNION
    SELECT home_id FROM game WHERE phase_id = target_phase
    UNION
    SELECT away_id FROM game WHERE phase_id = target_phase
  ) x ORDER BY x.team_id
  LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enqueue_team_profiles_for_championship(target_championship uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN SELECT x.team_id FROM (
    SELECT team_id FROM team_player WHERE championship_id = target_championship
    UNION
    SELECT team_id FROM player_stat WHERE championship_id = target_championship
    UNION
    SELECT tg.team_id FROM phase p JOIN stage_group g ON g.phase_id = p.id
      JOIN team_group tg ON tg.group_id = g.id WHERE p.championship_id = target_championship
    UNION
    SELECT g.home_id FROM phase p JOIN game g ON g.phase_id = p.id WHERE p.championship_id = target_championship
    UNION
    SELECT g.away_id FROM phase p JOIN game g ON g.phase_id = p.id WHERE p.championship_id = target_championship
  ) x ORDER BY x.team_id
  LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION mark_team_profile_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  target_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;

  IF TG_TABLE_NAME IN ('team_player', 'player_stat', 'team_group') THEN
    FOR target_id IN
      SELECT DISTINCT team_id FROM unnest(ARRAY[
        CASE WHEN old_row IS NULL THEN NULL ELSE (old_row->>'team_id')::uuid END,
        CASE WHEN new_row IS NULL THEN NULL ELSE (new_row->>'team_id')::uuid END
      ]) team_ids(team_id)
      WHERE team_id IS NOT NULL ORDER BY team_id
    LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'game' THEN
    FOR target_id IN
      SELECT DISTINCT team_id FROM unnest(ARRAY[
        CASE WHEN old_row IS NULL THEN NULL ELSE (old_row->>'home_id')::uuid END,
        CASE WHEN old_row IS NULL THEN NULL ELSE (old_row->>'away_id')::uuid END,
        CASE WHEN new_row IS NULL THEN NULL ELSE (new_row->>'home_id')::uuid END,
        CASE WHEN new_row IS NULL THEN NULL ELSE (new_row->>'away_id')::uuid END
      ]) team_ids(team_id)
      WHERE team_id IS NOT NULL ORDER BY team_id
    LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'stage_group' THEN
    FOR target_id IN
      SELECT team_id FROM team_group
      WHERE group_id = COALESCE((old_row->>'id')::uuid, (new_row->>'id')::uuid)
      ORDER BY team_id
    LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'phase' THEN
    IF old_row IS NOT NULL THEN PERFORM enqueue_team_profiles_for_phase((old_row->>'id')::uuid); END IF;
    IF new_row IS NOT NULL THEN PERFORM enqueue_team_profiles_for_phase((new_row->>'id')::uuid); END IF;
  ELSIF TG_TABLE_NAME = 'championship' THEN
    IF old_row IS NOT NULL THEN PERFORM enqueue_team_profiles_for_championship((old_row->>'id')::uuid); END IF;
    IF new_row IS NOT NULL AND (old_row IS NULL OR old_row->>'id' IS DISTINCT FROM new_row->>'id') THEN
      PERFORM enqueue_team_profiles_for_championship((new_row->>'id')::uuid);
    END IF;
  ELSIF TG_TABLE_NAME = 'player' THEN
    FOR target_id IN
      SELECT teams.team_id FROM (
        SELECT team_id FROM team_player WHERE player_id = COALESCE((old_row->>'id')::uuid, (new_row->>'id')::uuid)
        UNION
        SELECT team_id FROM player_stat WHERE player_id = COALESCE((old_row->>'id')::uuid, (new_row->>'id')::uuid)
      ) teams ORDER BY teams.team_id
    LOOP PERFORM enqueue_team_profile(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'team' THEN
    IF TG_OP = 'DELETE' THEN DELETE FROM team_profile_dirty WHERE team_id = OLD.id;
    ELSE PERFORM enqueue_team_profile(NEW.id); END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS team_profile_dirty_team_player ON team_player;
CREATE TRIGGER team_profile_dirty_team_player AFTER INSERT OR UPDATE OR DELETE ON team_player
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_player_stat ON player_stat;
CREATE TRIGGER team_profile_dirty_player_stat AFTER INSERT OR UPDATE OR DELETE ON player_stat
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_team_group ON team_group;
CREATE TRIGGER team_profile_dirty_team_group AFTER INSERT OR UPDATE OR DELETE ON team_group
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_game ON game;
CREATE TRIGGER team_profile_dirty_game AFTER INSERT OR UPDATE OR DELETE ON game
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_stage_group ON stage_group;
CREATE TRIGGER team_profile_dirty_stage_group AFTER INSERT OR UPDATE OR DELETE ON stage_group
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_phase ON phase;
CREATE TRIGGER team_profile_dirty_phase AFTER INSERT OR UPDATE OR DELETE ON phase
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_championship ON championship;
CREATE TRIGGER team_profile_dirty_championship AFTER INSERT OR UPDATE OR DELETE ON championship
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_player ON player;
CREATE TRIGGER team_profile_dirty_player AFTER UPDATE OR DELETE ON player
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
DROP TRIGGER IF EXISTS team_profile_dirty_team ON team;
CREATE TRIGGER team_profile_dirty_team AFTER INSERT OR DELETE ON team
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();

CREATE OR REPLACE FUNCTION refresh_one_team_profile(target_team uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE local_day date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  WITH membership AS (
    SELECT tp.championship_id FROM team_player tp WHERE tp.team_id = target_team
    UNION
    SELECT ps.championship_id FROM player_stat ps WHERE ps.team_id = target_team
    UNION
    SELECT p.championship_id FROM team_group tg JOIN stage_group sg ON sg.id = tg.group_id
      JOIN phase p ON p.id = sg.phase_id WHERE tg.team_id = target_team
    UNION
    SELECT p.championship_id FROM game g JOIN phase p ON p.id = g.phase_id WHERE g.home_id = target_team
    UNION
    SELECT p.championship_id FROM game g JOIN phase p ON p.id = g.phase_id WHERE g.away_id = target_team
  ), source AS (
    SELECT c.id AS championship_id, c.full_name, c.begins, c.ends,
      CASE WHEN local_day < c.begins THEN 'upcoming'
           WHEN local_day > c.ends THEN 'past' ELSE 'current' END AS status
    FROM membership m JOIN championship c ON c.id = m.championship_id
  )
  INSERT INTO team_championship AS d (id, team_id, championship_id, championship_name, begins, ends, status)
  SELECT target_team::text || ':' || championship_id::text, target_team, championship_id, full_name, begins, ends, status
  FROM source
  ON CONFLICT (id) DO UPDATE SET championship_name = EXCLUDED.championship_name,
    begins = EXCLUDED.begins, ends = EXCLUDED.ends, status = EXCLUDED.status
  WHERE (d.championship_name, d.begins, d.ends, d.status)
    IS DISTINCT FROM (EXCLUDED.championship_name, EXCLUDED.begins, EXCLUDED.ends, EXCLUDED.status);
  DELETE FROM team_championship d WHERE d.team_id = target_team
    AND NOT EXISTS (SELECT 1 FROM (
      SELECT tp.championship_id FROM team_player tp WHERE tp.team_id = target_team
      UNION SELECT ps.championship_id FROM player_stat ps WHERE ps.team_id = target_team
      UNION SELECT p.championship_id FROM team_group tg JOIN stage_group sg ON sg.id = tg.group_id
        JOIN phase p ON p.id = sg.phase_id WHERE tg.team_id = target_team
      UNION SELECT p.championship_id FROM game g JOIN phase p ON p.id = g.phase_id WHERE g.home_id = target_team
      UNION SELECT p.championship_id FROM game g JOIN phase p ON p.id = g.phase_id WHERE g.away_id = target_team
    ) m WHERE m.championship_id = d.championship_id);

  WITH roster_source AS (
    SELECT tp.championship_id, tp.player_id FROM team_player tp WHERE tp.team_id = target_team
    UNION
    SELECT ps.championship_id, ps.player_id FROM player_stat ps WHERE ps.team_id = target_team
  )
  INSERT INTO team_roster AS d (
    id, team_id, championship_id, player_id, player_name, position,
    played, started, came_on, bench, minutes, goals, penalties, own_goals, yellow, red, championship_name
  )
  SELECT rs.championship_id::text || ':' || target_team::text || ':' || rs.player_id::text,
    target_team, rs.championship_id, rs.player_id, p.name, COALESCE(p.position, ''),
    COALESCE(ps.played, 0), COALESCE(ps.started, 0), COALESCE(ps.came_on, 0), COALESCE(ps.bench, 0),
    COALESCE(ps.minutes, 0), COALESCE(ps.goals, 0), COALESCE(ps.penalties, 0), COALESCE(ps.own_goals, 0),
    COALESCE(ps.yellow, 0), COALESCE(ps.red, 0), c.full_name
  FROM roster_source rs JOIN player p ON p.id = rs.player_id
    JOIN championship c ON c.id = rs.championship_id
    LEFT JOIN player_stat ps ON ps.team_id = target_team AND ps.championship_id = rs.championship_id
      AND ps.player_id = rs.player_id
  ON CONFLICT (id) DO UPDATE SET player_name = EXCLUDED.player_name, position = EXCLUDED.position,
    played = EXCLUDED.played, started = EXCLUDED.started, came_on = EXCLUDED.came_on,
    bench = EXCLUDED.bench, minutes = EXCLUDED.minutes, goals = EXCLUDED.goals,
    penalties = EXCLUDED.penalties, own_goals = EXCLUDED.own_goals, yellow = EXCLUDED.yellow,
    red = EXCLUDED.red, championship_name = EXCLUDED.championship_name
  WHERE (d.player_name, d.position, d.played, d.started, d.came_on, d.bench, d.minutes, d.goals,
         d.penalties, d.own_goals, d.yellow, d.red, d.championship_name)
    IS DISTINCT FROM (EXCLUDED.player_name, EXCLUDED.position, EXCLUDED.played, EXCLUDED.started,
      EXCLUDED.came_on, EXCLUDED.bench, EXCLUDED.minutes, EXCLUDED.goals, EXCLUDED.penalties,
      EXCLUDED.own_goals, EXCLUDED.yellow, EXCLUDED.red, EXCLUDED.championship_name);
  DELETE FROM team_roster d WHERE d.team_id = target_team
    AND NOT EXISTS (SELECT 1 FROM (
      SELECT tp.championship_id, tp.player_id FROM team_player tp WHERE tp.team_id = target_team
      UNION SELECT ps.championship_id, ps.player_id FROM player_stat ps WHERE ps.team_id = target_team
    ) rs WHERE rs.championship_id = d.championship_id AND rs.player_id = d.player_id);

  WITH history_source AS (
    SELECT tp.player_id FROM team_player tp WHERE tp.team_id = target_team
    UNION
    SELECT ps.player_id FROM player_stat ps WHERE ps.team_id = target_team
  ), current_players AS (
    SELECT DISTINCT rs.player_id
    FROM (
      SELECT tp.player_id, tp.championship_id FROM team_player tp WHERE tp.team_id = target_team
      UNION SELECT ps.player_id, ps.championship_id FROM player_stat ps WHERE ps.team_id = target_team
    ) rs(player_id, championship_id)
    JOIN championship c ON c.id = rs.championship_id
    WHERE c.ends >= local_day
  )
  INSERT INTO team_player_history AS d (id, team_id, player_id, player_name, position, country, is_current)
  SELECT target_team::text || ':' || hs.player_id::text, target_team, hs.player_id,
    p.name, COALESCE(p.position, ''), p.country, cp.player_id IS NOT NULL
  FROM history_source hs JOIN player p ON p.id = hs.player_id
  LEFT JOIN current_players cp ON cp.player_id = hs.player_id
  ON CONFLICT (id) DO UPDATE SET player_name = EXCLUDED.player_name, position = EXCLUDED.position,
    country = EXCLUDED.country, is_current = EXCLUDED.is_current
  WHERE (d.player_name, d.position, d.country, d.is_current)
    IS DISTINCT FROM (EXCLUDED.player_name, EXCLUDED.position, EXCLUDED.country, EXCLUDED.is_current);
  DELETE FROM team_player_history d WHERE d.team_id = target_team
    AND NOT EXISTS (SELECT 1 FROM (
      SELECT tp.player_id FROM team_player tp WHERE tp.team_id = target_team
      UNION SELECT ps.player_id FROM player_stat ps WHERE ps.team_id = target_team
    ) hs WHERE hs.player_id = d.player_id);
END $$;

CREATE OR REPLACE FUNCTION refresh_team_profiles(batch_size integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp
SET statement_timeout = '20s' SET lock_timeout = '2s' AS $$
DECLARE
  v_local_day date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_previous_day date;
  item record;
  processed integer := 0;
BEGIN
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
  END LOOP;
  RETURN processed;
END $$;

REVOKE ALL ON FUNCTION enqueue_team_profile(uuid), enqueue_team_profiles_for_phase(uuid),
  enqueue_team_profiles_for_championship(uuid), mark_team_profile_dirty(),
  refresh_one_team_profile(uuid), refresh_team_profiles(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_team_profile(uuid), enqueue_team_profiles_for_phase(uuid),
  enqueue_team_profiles_for_championship(uuid), refresh_one_team_profile(uuid),
  refresh_team_profiles(integer) TO service;

-- This migration-owned marker makes the retained-volume pass complete and
-- prevents a replay from rescanning the archive. Fresh installs have no teams
-- yet; the source triggers enqueue seed rows after this migration commits.
DO $$
DECLARE target_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team_profile_backfill WHERE id) THEN
    FOR target_id IN SELECT id FROM team ORDER BY id LOOP
      PERFORM refresh_one_team_profile(target_id);
    END LOOP;
    INSERT INTO team_profile_backfill (id) VALUES (true);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
