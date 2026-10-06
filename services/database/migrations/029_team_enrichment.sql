-- Additional team details, discussion, roster metrics and historical views.
-- The source schema owns field declarations; these ALTERs also make retained
-- volumes converge before the corresponding functions and imports run.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

ALTER TABLE team ADD COLUMN IF NOT EXISTS latitude double precision
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE team ADD COLUMN IF NOT EXISTS longitude double precision
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
ALTER TABLE player_game ADD COLUMN IF NOT EXISTS off_rating double precision;
ALTER TABLE player_game ADD COLUMN IF NOT EXISTS def_rating double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS off_rating double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS def_rating double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS contribution double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS contribution_per90 double precision;
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS goals_per90 double precision;
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS off_rating double precision;
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS def_rating double precision;
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS contribution double precision;
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS contribution_per90 double precision;
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS goals_per90 double precision;
-- Stored search keys follow the existing archive convention. This local retained
-- migration bounds the table rewrite with lock_timeout and statement_timeout.
-- squawk-ignore adding-field-with-default
ALTER TABLE team_roster ADD COLUMN IF NOT EXISTS search_key text COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(player_name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
ALTER TABLE team_game ADD COLUMN IF NOT EXISTS category_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='team_game'::regclass AND conname='team_game_category_id_fkey') THEN
    ALTER TABLE team_game ADD CONSTRAINT team_game_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
ALTER TABLE team_game ADD COLUMN IF NOT EXISTS phase_key text;
ALTER TABLE team_game ADD COLUMN IF NOT EXISTS category_key text;
-- Same bounded stored-key migration for the deduplicated player history.
-- squawk-ignore adding-field-with-default
ALTER TABLE team_player_history ADD COLUMN IF NOT EXISTS search_key text COLLATE golaberto_search GENERATED ALWAYS AS (replace(replace(replace(player_name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;

-- TeamRoster is a projection on retained installs whose 028 profile function
-- predates these fields. Stamp metrics from PlayerStat on every roster write,
-- and synchronize source metric changes without rebuilding other profile data.
CREATE OR REPLACE FUNCTION stamp_team_roster_metrics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  SELECT ps.off_rating,ps.def_rating,ps.contribution,ps.contribution_per90,ps.goals_per90
    INTO NEW.off_rating,NEW.def_rating,NEW.contribution,NEW.contribution_per90,NEW.goals_per90
  FROM player_stat ps
  WHERE ps.team_id=NEW.team_id AND ps.championship_id=NEW.championship_id AND ps.player_id=NEW.player_id
  ORDER BY ps.id LIMIT 1;
  IF NOT FOUND THEN
    NEW.off_rating:=NULL; NEW.def_rating:=NULL; NEW.contribution:=NULL;
    NEW.contribution_per90:=NULL; NEW.goals_per90:=NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync_team_roster_metrics_from_player_stat() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE team_roster SET off_rating=NULL,def_rating=NULL,contribution=NULL,
      contribution_per90=NULL,goals_per90=NULL
    WHERE team_id=OLD.team_id AND championship_id=OLD.championship_id AND player_id=OLD.player_id
      AND (off_rating,def_rating,contribution,contribution_per90,goals_per90)
        IS DISTINCT FROM (NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision);
    RETURN NULL;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.team_id,OLD.championship_id,OLD.player_id)
    IS DISTINCT FROM (NEW.team_id,NEW.championship_id,NEW.player_id) THEN
    UPDATE team_roster SET off_rating=NULL,def_rating=NULL,contribution=NULL,
      contribution_per90=NULL,goals_per90=NULL
    WHERE team_id=OLD.team_id AND championship_id=OLD.championship_id AND player_id=OLD.player_id
      AND (off_rating,def_rating,contribution,contribution_per90,goals_per90)
        IS DISTINCT FROM (NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision);
  END IF;
  UPDATE team_roster SET off_rating=NEW.off_rating,def_rating=NEW.def_rating,
    contribution=NEW.contribution,contribution_per90=NEW.contribution_per90,goals_per90=NEW.goals_per90
  WHERE team_id=NEW.team_id AND championship_id=NEW.championship_id AND player_id=NEW.player_id
    AND (off_rating,def_rating,contribution,contribution_per90,goals_per90)
      IS DISTINCT FROM (NEW.off_rating,NEW.def_rating,NEW.contribution,NEW.contribution_per90,NEW.goals_per90);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS team_roster_metric_stamp ON team_roster;
CREATE TRIGGER team_roster_metric_stamp BEFORE INSERT OR UPDATE ON team_roster
  FOR EACH ROW EXECUTE FUNCTION stamp_team_roster_metrics();
DROP TRIGGER IF EXISTS team_roster_metrics_from_player_stat_insert ON player_stat;
DROP TRIGGER IF EXISTS team_roster_metrics_from_player_stat_update ON player_stat;
DROP TRIGGER IF EXISTS team_roster_metrics_from_player_stat_delete ON player_stat;
CREATE TRIGGER team_roster_metrics_from_player_stat_insert AFTER INSERT ON player_stat
  FOR EACH ROW EXECUTE FUNCTION sync_team_roster_metrics_from_player_stat();
CREATE TRIGGER team_roster_metrics_from_player_stat_update AFTER UPDATE OF team_id,championship_id,player_id,
  minutes,goals,off_rating,def_rating,contribution,contribution_per90,goals_per90 ON player_stat
  FOR EACH ROW EXECUTE FUNCTION sync_team_roster_metrics_from_player_stat();
CREATE TRIGGER team_roster_metrics_from_player_stat_delete AFTER DELETE ON player_stat
  FOR EACH ROW EXECUTE FUNCTION sync_team_roster_metrics_from_player_stat();
REVOKE ALL ON FUNCTION stamp_team_roster_metrics(),sync_team_roster_metrics_from_player_stat() FROM PUBLIC,anon,app_user;

-- Reconcile only these appended metrics for rows the old 028 backfill created.
UPDATE team_roster r SET off_rating=ps.off_rating,def_rating=ps.def_rating,
  contribution=ps.contribution,contribution_per90=ps.contribution_per90,goals_per90=ps.goals_per90
FROM player_stat ps WHERE ps.team_id=r.team_id AND ps.championship_id=r.championship_id AND ps.player_id=r.player_id
  AND (r.off_rating,r.def_rating,r.contribution,r.contribution_per90,r.goals_per90)
    IS DISTINCT FROM (ps.off_rating,ps.def_rating,ps.contribution,ps.contribution_per90,ps.goals_per90);
UPDATE team_roster r SET off_rating=NULL,def_rating=NULL,contribution=NULL,contribution_per90=NULL,goals_per90=NULL
WHERE (r.off_rating,r.def_rating,r.contribution,r.contribution_per90,r.goals_per90)
    IS DISTINCT FROM (NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision,NULL::double precision)
  AND NOT EXISTS (SELECT 1 FROM player_stat ps WHERE ps.team_id=r.team_id
    AND ps.championship_id=r.championship_id AND ps.player_id=r.player_id);

-- Fresh generated columns and retained columns converge on the same ICU
-- primary-strength collation; the emitter does not declare SQL collations.
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['team_roster','team_player_history'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=target::regclass
      AND attname='search_key' AND attcollation <> 'golaberto_search'::regcollation) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN search_key TYPE text COLLATE golaberto_search',target);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION stamp_team_game_filter_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  SELECT g.phase_id::text, c.category_id, coalesce(c.category_id::text, 'professional')
    INTO NEW.phase_key, NEW.category_id, NEW.category_key
  FROM game g JOIN phase p ON p.id=g.phase_id
    JOIN championship c ON c.id=p.championship_id
  WHERE g.id=NEW.game_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS team_game_filter_keys ON team_game;
CREATE TRIGGER team_game_filter_keys BEFORE INSERT OR UPDATE OF game_id, championship_id
  ON team_game FOR EACH ROW EXECUTE FUNCTION stamp_team_game_filter_keys();
-- Recompute existing archive rows through the same trigger used for refreshes.
UPDATE team_game SET game_id=game_id;
-- Existing team/day and championship/team indexes bound these filtered reads.

CREATE TABLE IF NOT EXISTS team_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  app_user_id uuid DEFAULT auth_uid() NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (
    char_length(regexp_replace(body, '^[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g')) > 0
    AND char_length(body) <= 1000
  ),
  created_at portable_timestamp DEFAULT now() NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('team_comment');
DROP POLICY IF EXISTS team_comment_app_user_select ON team_comment;
CREATE POLICY team_comment_app_user_select ON team_comment FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_comment_author_insert ON team_comment;
CREATE POLICY team_comment_author_insert ON team_comment FOR INSERT TO app_user
  WITH CHECK (
    app_user_id = auth_uid()
    AND current_setting('request.jwt.claims', true)::json ->> 'guest' = 'false'
  );
DROP POLICY IF EXISTS team_comment_author_delete ON team_comment;
CREATE POLICY team_comment_author_delete ON team_comment FOR DELETE TO app_user
  USING (app_user_id = auth_uid());
DROP POLICY IF EXISTS team_comment_service_all ON team_comment;
CREATE POLICY team_comment_service_all ON team_comment FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON team_comment TO anon, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_comment TO service;
GRANT SELECT ON team_comment TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_comment;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_comment
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_comment REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_comment') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_comment;
  END IF;
END $$;
-- tier: any

-- Fresh initdb already runs 030 before the retained-volume runner replays 029.
-- Do not recreate or alter the campaign cache after it has become a read view.
DO $campaign_cache$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.team_campaign_point') AND relkind='v') THEN
CREATE TABLE IF NOT EXISTS team_campaign_point (
  id text PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  day date NOT NULL,
  points integer NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  result text NOT NULL CHECK (result IN ('w', 'd', 'l')),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (group_id, team_id, game_id),
  CHECK (id = group_id::text || ':' || team_id::text || ':' || game_id::text)
);
-- Public reads are team and sequence bounded; refresh replaces one group at a time.
CREATE INDEX IF NOT EXISTS team_campaign_point_group_team_sequence_idx
  ON team_campaign_point (group_id, team_id, sequence);
CREATE INDEX IF NOT EXISTS team_campaign_point_team_day_idx
  ON team_campaign_point (team_id, day, sequence);
CALL rls_protect('team_campaign_point');
DROP POLICY IF EXISTS team_campaign_point_app_user_select ON team_campaign_point;
CREATE POLICY team_campaign_point_app_user_select ON team_campaign_point FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_campaign_point_service_all ON team_campaign_point;
CREATE POLICY team_campaign_point_service_all ON team_campaign_point FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_campaign_point FROM anon;
GRANT SELECT ON team_campaign_point TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_campaign_point TO service;
GRANT SELECT ON team_campaign_point TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_campaign_point;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_campaign_point
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_campaign_point REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_campaign_point') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_campaign_point;
  END IF;
END $$;
-- tier: any

  END IF;
END $campaign_cache$;

CREATE TABLE IF NOT EXISTS team_odds_history (
  id text PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  recorded_on date NOT NULL,
  captured_at timestamptz,
  position integer NOT NULL CHECK (position >= 1),
  percent double precision NOT NULL CHECK (percent >= 0 AND percent <= 100),
  source text NOT NULL CHECK (source IN ('imported', 'computed')),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (group_id, team_id, recorded_on, position),
  CHECK (id = group_id::text || ':' || team_id::text || ':' || recorded_on::text || ':' || position::text)
);
CREATE INDEX IF NOT EXISTS team_odds_history_group_team_day_idx
  ON team_odds_history (group_id, team_id, recorded_on, position);
CREATE INDEX IF NOT EXISTS team_odds_history_team_day_idx
  ON team_odds_history (team_id, recorded_on DESC, position);
CALL rls_protect('team_odds_history');
DROP POLICY IF EXISTS team_odds_history_app_user_select ON team_odds_history;
CREATE POLICY team_odds_history_app_user_select ON team_odds_history FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_odds_history_service_all ON team_odds_history;
CREATE POLICY team_odds_history_service_all ON team_odds_history FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_odds_history FROM anon;
GRANT SELECT ON team_odds_history TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_odds_history TO service;
GRANT SELECT ON team_odds_history TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_odds_history;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_odds_history
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_odds_history REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_odds_history') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_odds_history;
  END IF;
END $$;
-- tier: any

-- Exactly one group is replaced per call. The delete and upsert share the
-- transaction, so readers never see a partially refreshed campaign.
DO $campaign_replace$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.team_campaign_point') AND relkind='v') THEN
CREATE OR REPLACE FUNCTION replace_team_campaign_points(target_group uuid, rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF jsonb_typeof(rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array';
  END IF;
  DELETE FROM team_campaign_point WHERE group_id = target_group;
  INSERT INTO team_campaign_point (id, group_id, team_id, game_id, sequence, day, points, position, result)
  SELECT target_group::text || ':' || item.team_id::text || ':' || item.game_id::text,
    target_group, item.team_id, item.game_id, item.sequence, item.day, item.points, item.position, item.result
  FROM jsonb_to_recordset(rows) AS item(
    team_id uuid, game_id uuid, sequence integer, day date,
    points integer, position integer, result text
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION replace_team_campaign_points(uuid, jsonb) FROM PUBLIC, anon, app_user;
GRANT EXECUTE ON FUNCTION replace_team_campaign_points(uuid, jsonb) TO service;

  END IF;
END $campaign_replace$;

-- Campaign history uses the same phase ladder and points rules as standings:
-- all games sharing a round settle together; rows without round metadata fall
-- back to same-day batches. Rank each whole batch before attaching its table
-- position to each team's game in that batch.
CREATE OR REPLACE FUNCTION compute_team_campaign_rows(target_group uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public,pg_temp AS $$
  WITH group_rule AS (
    SELECT sg.id AS group_id,p.id AS phase_id,p.sort,p.bonus_points,p.bonus_points_threshold,
      c.point_win,c.point_draw,c.point_loss
    FROM stage_group sg JOIN phase p ON p.id=sg.phase_id JOIN championship c ON c.id=p.championship_id
    WHERE sg.id=target_group
  ), members AS (
    SELECT tg.group_id,tg.team_id,t.name,tg.add_sub,tg.bias,r.sort,r.bonus_points,
      r.bonus_points_threshold,r.point_win,r.point_draw,r.point_loss,
      count(*) OVER (PARTITION BY tg.group_id)::integer AS group_size
    FROM team_group tg JOIN team t ON t.id=tg.team_id JOIN group_rule r USING(group_id)
  ), chronological AS (
    SELECT g.id,g.round,g.day,g.kickoff,g.home_id,g.away_id,g.home_score,g.away_score,
      g.home_aet,g.away_aet,g.home_pen,g.away_pen,
      CASE WHEN g.round IS NULL THEN 'd:'||g.day::text ELSE 'r:'||g.round::text END AS batch_key
    FROM game g JOIN group_rule r ON r.phase_id=g.phase_id
    WHERE g.played AND (g.home_score IS NOT NULL AND g.away_score IS NOT NULL)
      AND (EXISTS(SELECT 1 FROM members m WHERE m.team_id=g.home_id)
        OR EXISTS(SELECT 1 FROM members m WHERE m.team_id=g.away_id))
  ), prior_batch AS (
    SELECT c.*,lag(batch_key) OVER(ORDER BY day,kickoff NULLS FIRST,id) AS previous_key
    FROM chronological c
  ), numbered AS (
    SELECT p.*,sum((p.previous_key IS DISTINCT FROM p.batch_key)::integer)
      OVER(ORDER BY day,kickoff NULLS FIRST,id ROWS UNBOUNDED PRECEDING) AS batch_no
    FROM prior_batch p
  ), batches AS (
    SELECT batch_no,max(day) AS day FROM numbered GROUP BY batch_no
  ), sides AS (
    SELECT g.batch_no,g.id AS game_id,g.day,g.kickoff,m.group_id,m.team_id,m.name,
      m.add_sub,m.bias,m.group_size,m.sort,m.bonus_points,m.bonus_points_threshold,
      m.point_win,m.point_draw,m.point_loss,
      CASE WHEN g.home_id=m.team_id THEN g.away_id ELSE g.home_id END AS opponent_id,
      CASE WHEN g.home_id=m.team_id THEN g.home_score ELSE g.away_score END AS goals_for,
      CASE WHEN g.home_id=m.team_id THEN g.away_score ELSE g.home_score END AS goals_against,
      CASE WHEN g.home_id=m.team_id THEN 0 ELSE g.away_score END AS goals_away,
      CASE WHEN g.home_id=m.team_id THEN coalesce(g.home_aet,0) ELSE coalesce(g.away_aet,0) END AS goals_aet,
      CASE WHEN g.home_id=m.team_id THEN coalesce(g.home_pen,0) ELSE coalesce(g.away_pen,0) END AS goals_pen,
      CASE WHEN g.home_score=g.away_score THEN 'd'
        WHEN (g.home_score>g.away_score)=(g.home_id=m.team_id) THEN 'w' ELSE 'l' END AS result,
      CASE WHEN (g.home_id=m.team_id AND g.home_score>g.away_score)
          OR (g.away_id=m.team_id AND g.away_score>g.home_score)
        THEN m.point_win+CASE WHEN m.bonus_points>0
          AND (CASE WHEN g.home_id=m.team_id THEN g.home_score-g.away_score ELSE g.away_score-g.home_score END)>=m.bonus_points_threshold
          THEN m.bonus_points ELSE 0 END
        WHEN g.home_score=g.away_score THEN m.point_draw ELSE m.point_loss END AS earned_points
    FROM numbered g JOIN members m ON m.team_id IN (g.home_id,g.away_id)
  ), campaigns AS (
    SELECT b.batch_no,b.day,m.group_id,m.team_id,m.name,m.add_sub,m.bias,m.group_size,m.sort,
      m.point_win,m.point_draw,m.point_loss,
      coalesce(sum(s.earned_points),0)+m.add_sub AS points,
      count(s.game_id)::integer AS played,
      count(*) FILTER(WHERE s.result='w')::integer AS wins,
      count(*) FILTER(WHERE s.result='d')::integer AS draws,
      count(*) FILTER(WHERE s.result='l')::integer AS losses,
      coalesce(sum(s.goals_for),0)::integer AS goals_for,
      coalesce(sum(s.goals_against),0)::integer AS goals_against,
      coalesce(sum(s.goals_away),0)::integer AS goals_away,
      coalesce(sum(s.goals_aet),0)::integer AS goals_aet,
      coalesce(sum(s.goals_pen),0)::integer AS goals_pen
    FROM batches b CROSS JOIN members m
    LEFT JOIN sides s ON s.team_id=m.team_id AND s.batch_no<=b.batch_no
    GROUP BY b.batch_no,b.day,m.group_id,m.team_id,m.name,m.add_sub,m.bias,m.group_size,m.sort,
      m.point_win,m.point_draw,m.point_loss
  ), headed AS (
    SELECT c.*,CASE WHEN c.group_size<=2 OR peers.count=c.group_size-1 THEN 0
      ELSE coalesce(head.points,0)+c.add_sub END AS head
    FROM campaigns c
    CROSS JOIN LATERAL (
      SELECT array_agg(p.team_id) AS ids,count(*)::integer AS count
      FROM campaigns p WHERE p.batch_no=c.batch_no AND p.points=c.points AND p.team_id<>c.team_id
    ) peers
    CROSS JOIN LATERAL (
      SELECT sum(s.earned_points) AS points FROM sides s
      WHERE s.team_id=c.team_id AND s.batch_no<=c.batch_no AND s.opponent_id=ANY(coalesce(peers.ids,'{}'::uuid[]))
    ) head
  ), keyed AS (
    SELECT h.*,(
      SELECT string_agg(CASE key WHEN 'name' THEN h.name::text COLLATE "C"
        ELSE lpad((9000000000000::bigint-round(value*1000000)::bigint)::text,13,'0') END,
        chr(31) ORDER BY ordinal)
      FROM unnest(string_to_array(h.sort,',')) WITH ORDINALITY AS rule(key,ordinal)
      CROSS JOIN LATERAL (SELECT CASE rule.key
        WHEN 'pt' THEN h.points::double precision WHEN 'w' THEN h.wins::double precision
        WHEN 'gd' THEN (h.goals_for-h.goals_against)::double precision WHEN 'gf' THEN h.goals_for::double precision
        WHEN 'g_average' THEN CASE WHEN h.goals_against=0 AND h.goals_for>0 THEN 1000+h.goals_for
          ELSE h.goals_for/(h.goals_against+0.0000001) END
        WHEN 'gp' THEN h.goals_pen::double precision WHEN 'g_aet' THEN h.goals_aet::double precision
        WHEN 'head' THEN h.head::double precision WHEN 'g_away' THEN h.goals_away::double precision
        WHEN 'bias' THEN h.bias::double precision ELSE 0 END AS value) measure
    ) AS sort_key
    FROM headed h
  ), ranked AS (
    SELECT h.*,row_number() OVER(PARTITION BY h.batch_no ORDER BY h.sort_key COLLATE "C",h.team_id)::integer AS position
    FROM keyed h
  ), played_sequence AS (
    SELECT s.*,row_number() OVER(PARTITION BY s.team_id ORDER BY s.batch_no,s.day,s.kickoff NULLS FIRST,s.game_id)::integer AS sequence
    FROM sides s
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('team_id',p.team_id,'game_id',p.game_id,'sequence',p.sequence,
    'day',p.day,'points',r.points,'position',r.position,'result',p.result)
    ORDER BY p.team_id,p.sequence),'[]'::jsonb)
  FROM played_sequence p JOIN ranked r ON r.batch_no=p.batch_no AND r.team_id=p.team_id
$$;

REVOKE ALL ON FUNCTION compute_team_campaign_rows(uuid) FROM PUBLIC,anon,app_user;

DO $campaign_refresh$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.team_campaign_point') AND relkind='v') THEN
CREATE OR REPLACE FUNCTION refresh_team_campaign_group(target_group uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  RETURN replace_team_campaign_points(target_group,compute_team_campaign_rows(target_group));
END $$;
REVOKE ALL ON FUNCTION refresh_team_campaign_group(uuid) FROM PUBLIC,anon,app_user;
GRANT EXECUTE ON FUNCTION refresh_team_campaign_group(uuid) TO service;

  END IF;
END $campaign_refresh$;

CREATE TABLE IF NOT EXISTS team_roster_total (
  id text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  championship_id uuid NOT NULL REFERENCES championship(id) ON DELETE CASCADE,
  championship_name text NOT NULL,
  played integer NOT NULL CHECK (played >= 0),
  started integer NOT NULL CHECK (started >= 0),
  came_on integer NOT NULL CHECK (came_on >= 0),
  bench integer NOT NULL CHECK (bench >= 0),
  minutes integer NOT NULL CHECK (minutes >= 0),
  goals integer NOT NULL CHECK (goals >= 0),
  penalties integer NOT NULL CHECK (penalties >= 0),
  own_goals integer NOT NULL CHECK (own_goals >= 0),
  yellow integer NOT NULL CHECK (yellow >= 0),
  red integer NOT NULL CHECK (red >= 0),
  off_rating double precision,
  def_rating double precision,
  contribution double precision,
  contribution_per90 double precision,
  goals_per90 double precision,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (team_id, championship_id),
  CHECK (id = championship_id::text || ':' || team_id::text)
);
CREATE INDEX IF NOT EXISTS team_roster_total_team_championship_idx
  ON team_roster_total (team_id, championship_id);
CALL rls_protect('team_roster_total');
DROP POLICY IF EXISTS team_roster_total_app_user_select ON team_roster_total;
CREATE POLICY team_roster_total_app_user_select ON team_roster_total FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_roster_total_service_all ON team_roster_total;
CREATE POLICY team_roster_total_service_all ON team_roster_total FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_roster_total FROM anon;
GRANT SELECT ON team_roster_total TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_roster_total TO service;
GRANT SELECT ON team_roster_total TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_roster_total;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_roster_total
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_roster_total REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_roster_total') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_roster_total;
  END IF;
END $$;
-- tier: any

CREATE TABLE IF NOT EXISTS team_rating_chart (
  id text PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('1m','3m','6m','1y','5y','all')),
  series_json text NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (team_id, period),
  CHECK (id = team_id::text || ':' || period)
);
CREATE INDEX IF NOT EXISTS team_rating_chart_team_period_idx ON team_rating_chart (team_id,period);
CALL rls_protect('team_rating_chart');
DROP POLICY IF EXISTS team_rating_chart_app_user_select ON team_rating_chart;
CREATE POLICY team_rating_chart_app_user_select ON team_rating_chart FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_rating_chart_service_all ON team_rating_chart;
CREATE POLICY team_rating_chart_service_all ON team_rating_chart FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_rating_chart FROM anon;
GRANT SELECT ON team_rating_chart TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_rating_chart TO service;
GRANT SELECT ON team_rating_chart TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_rating_chart;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_rating_chart
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_rating_chart REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_rating_chart') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_rating_chart;
  END IF;
END $$;
-- tier: any

CREATE TABLE IF NOT EXISTS team_odds_chart (
  id text PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES zone(id) ON DELETE CASCADE,
  series_json text NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  UNIQUE (group_id,team_id,zone_id),
  CHECK (id = group_id::text || ':' || team_id::text || ':' || zone_id::text)
);
CREATE INDEX IF NOT EXISTS team_odds_chart_group_team_zone_idx
  ON team_odds_chart (group_id,team_id,zone_id);
CALL rls_protect('team_odds_chart');
DROP POLICY IF EXISTS team_odds_chart_app_user_select ON team_odds_chart;
CREATE POLICY team_odds_chart_app_user_select ON team_odds_chart FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_odds_chart_service_all ON team_odds_chart;
CREATE POLICY team_odds_chart_service_all ON team_odds_chart FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_odds_chart FROM anon;
GRANT SELECT ON team_odds_chart TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_odds_chart TO service;
GRANT SELECT ON team_odds_chart TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_odds_chart;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_odds_chart
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE team_odds_chart REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_odds_chart') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_odds_chart;
  END IF;
END $$;
-- tier: any

-- The existing team/date/id index also serves chart range reads.

-- Refresh projections are queued by source-table changes and drained in small
-- service-only batches. Projection tables stay off CDC.
CREATE SEQUENCE IF NOT EXISTS team_roster_total_revision_seq;
CREATE TABLE IF NOT EXISTS team_roster_total_dirty (team_id uuid PRIMARY KEY, revision bigint NOT NULL);
CREATE SEQUENCE IF NOT EXISTS team_rating_chart_revision_seq;
CREATE TABLE IF NOT EXISTS team_rating_chart_dirty (team_id uuid PRIMARY KEY, revision bigint NOT NULL);
CREATE SEQUENCE IF NOT EXISTS team_odds_chart_revision_seq;
CREATE TABLE IF NOT EXISTS team_odds_chart_dirty (group_id uuid PRIMARY KEY, revision bigint NOT NULL);
CREATE TABLE IF NOT EXISTS team_rating_chart_clock (id boolean PRIMARY KEY DEFAULT true CHECK (id), utc_day date NOT NULL);
INSERT INTO team_rating_chart_clock(id,utc_day) VALUES(true,(now() AT TIME ZONE 'UTC')::date)
ON CONFLICT(id) DO NOTHING;
REVOKE ALL ON team_roster_total_dirty,team_rating_chart_dirty,team_odds_chart_dirty FROM PUBLIC,anon,app_user,electric;
REVOKE ALL ON team_rating_chart_clock FROM PUBLIC,anon,app_user,electric;
GRANT SELECT,INSERT,UPDATE,DELETE ON team_roster_total_dirty,team_rating_chart_dirty,team_odds_chart_dirty TO service;
GRANT SELECT,INSERT,UPDATE,DELETE ON team_rating_chart_clock TO service;
GRANT USAGE,SELECT ON SEQUENCE team_roster_total_revision_seq,team_rating_chart_revision_seq,team_odds_chart_revision_seq TO service;

CREATE OR REPLACE FUNCTION enqueue_team_roster_total(target_team uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public,pg_temp AS $$
  INSERT INTO team_roster_total_dirty VALUES (target_team,nextval('team_roster_total_revision_seq'))
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
$$;
CREATE OR REPLACE FUNCTION mark_team_roster_total_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_roster_total_dirty SELECT team_id,nextval('team_roster_total_revision_seq') FROM new_roster_rows GROUP BY team_id
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_roster_total_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_roster_total_dirty SELECT team_id,nextval('team_roster_total_revision_seq') FROM (
    SELECT team_id FROM old_roster_rows UNION SELECT team_id FROM new_roster_rows
  ) changed GROUP BY team_id ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_roster_total_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_roster_total_dirty SELECT team_id,nextval('team_roster_total_revision_seq') FROM old_roster_rows GROUP BY team_id
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_roster_total_dirty ON team_roster;
DROP TRIGGER IF EXISTS team_roster_total_dirty_insert ON team_roster;
DROP TRIGGER IF EXISTS team_roster_total_dirty_update ON team_roster;
DROP TRIGGER IF EXISTS team_roster_total_dirty_delete ON team_roster;
CREATE TRIGGER team_roster_total_dirty_insert AFTER INSERT ON team_roster
  REFERENCING NEW TABLE AS new_roster_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_roster_total_insert();
CREATE TRIGGER team_roster_total_dirty_update AFTER UPDATE ON team_roster
  REFERENCING OLD TABLE AS old_roster_rows NEW TABLE AS new_roster_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_roster_total_update();
CREATE TRIGGER team_roster_total_dirty_delete AFTER DELETE ON team_roster
  REFERENCING OLD TABLE AS old_roster_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_roster_total_delete();

CREATE OR REPLACE FUNCTION enqueue_team_rating_chart(target_team uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public,pg_temp AS $$
  INSERT INTO team_rating_chart_dirty VALUES (target_team,nextval('team_rating_chart_revision_seq'))
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
$$;
CREATE OR REPLACE FUNCTION mark_team_rating_chart_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_rating_chart_dirty SELECT team_id,nextval('team_rating_chart_revision_seq') FROM new_team_ratings GROUP BY team_id
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_rating_chart_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_rating_chart_dirty SELECT team_id,nextval('team_rating_chart_revision_seq') FROM (
    SELECT team_id FROM old_team_ratings UNION SELECT team_id FROM new_team_ratings
  ) changed GROUP BY team_id ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_rating_chart_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_rating_chart_dirty SELECT team_id,nextval('team_rating_chart_revision_seq') FROM old_team_ratings GROUP BY team_id
  ON CONFLICT (team_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_rating_chart_dirty ON team_rating;
DROP TRIGGER IF EXISTS team_rating_chart_dirty_insert ON team_rating;
DROP TRIGGER IF EXISTS team_rating_chart_dirty_update ON team_rating;
DROP TRIGGER IF EXISTS team_rating_chart_dirty_delete ON team_rating;
CREATE TRIGGER team_rating_chart_dirty_insert AFTER INSERT ON team_rating
  REFERENCING NEW TABLE AS new_team_ratings FOR EACH STATEMENT EXECUTE FUNCTION mark_team_rating_chart_insert();
CREATE TRIGGER team_rating_chart_dirty_update AFTER UPDATE ON team_rating
  REFERENCING OLD TABLE AS old_team_ratings NEW TABLE AS new_team_ratings FOR EACH STATEMENT EXECUTE FUNCTION mark_team_rating_chart_update();
CREATE TRIGGER team_rating_chart_dirty_delete AFTER DELETE ON team_rating
  REFERENCING OLD TABLE AS old_team_ratings FOR EACH STATEMENT EXECUTE FUNCTION mark_team_rating_chart_delete();

CREATE OR REPLACE FUNCTION enqueue_team_odds_chart(target_group uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public,pg_temp AS $$
  INSERT INTO team_odds_chart_dirty VALUES (target_group,nextval('team_odds_chart_revision_seq'))
  ON CONFLICT (group_id) DO UPDATE SET revision=EXCLUDED.revision;
$$;
CREATE OR REPLACE FUNCTION mark_team_odds_history_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty SELECT group_id,nextval('team_odds_chart_revision_seq') FROM new_odds_rows GROUP BY group_id
  ON CONFLICT (group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_odds_history_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty SELECT group_id,nextval('team_odds_chart_revision_seq') FROM (
    SELECT group_id FROM old_odds_rows UNION SELECT group_id FROM new_odds_rows
  ) changed GROUP BY group_id ON CONFLICT (group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION mark_team_odds_history_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty SELECT group_id,nextval('team_odds_chart_revision_seq') FROM old_odds_rows GROUP BY group_id
  ON CONFLICT (group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_history_dirty ON team_odds_history;
DROP TRIGGER IF EXISTS team_odds_history_dirty_insert ON team_odds_history;
DROP TRIGGER IF EXISTS team_odds_history_dirty_update ON team_odds_history;
DROP TRIGGER IF EXISTS team_odds_history_dirty_delete ON team_odds_history;
CREATE TRIGGER team_odds_history_dirty_insert AFTER INSERT ON team_odds_history
  REFERENCING NEW TABLE AS new_odds_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_odds_history_insert();
CREATE TRIGGER team_odds_history_dirty_update AFTER UPDATE ON team_odds_history
  REFERENCING OLD TABLE AS old_odds_rows NEW TABLE AS new_odds_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_odds_history_update();
CREATE TRIGGER team_odds_history_dirty_delete AFTER DELETE ON team_odds_history
  REFERENCING OLD TABLE AS old_odds_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_team_odds_history_delete();
CREATE OR REPLACE FUNCTION mark_team_odds_zone_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM enqueue_team_odds_chart(OLD.group_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP='INSERT' OR NEW.group_id IS DISTINCT FROM OLD.group_id) THEN
    PERFORM enqueue_team_odds_chart(NEW.group_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_zone_dirty ON zone;
CREATE TRIGGER team_odds_zone_dirty AFTER INSERT OR UPDATE OR DELETE ON zone
  FOR EACH ROW EXECUTE FUNCTION mark_team_odds_zone_dirty();
CREATE OR REPLACE FUNCTION mark_team_odds_members_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM enqueue_team_odds_chart(OLD.group_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP='INSERT' OR NEW.group_id IS DISTINCT FROM OLD.group_id) THEN
    PERFORM enqueue_team_odds_chart(NEW.group_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_members_dirty ON team_group;
CREATE TRIGGER team_odds_members_dirty AFTER INSERT OR UPDATE OR DELETE ON team_group
  FOR EACH ROW EXECUTE FUNCTION mark_team_odds_members_dirty();

CREATE OR REPLACE FUNCTION sample_team_series(points jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public,pg_temp AS $$
  WITH source AS (
    SELECT (p->>'x')::bigint AS x,(p->>'y')::double precision AS y,p->>'label' AS label,
      row_number() OVER (ORDER BY (p->>'x')::bigint) AS rn,count(*) OVER () AS n
    FROM jsonb_array_elements(points) p
  ), picked AS (
    SELECT x,y,label FROM source WHERE n<=600
    UNION
    SELECT x,y,label FROM source WHERE n>600 AND rn IN (1,n)
    UNION
    SELECT x,y,label FROM (
      SELECT x,y,label,
        floor((rn-2)::numeric * 299 / greatest(1,n-2))::integer AS bucket,
        row_number() OVER (PARTITION BY floor((rn-2)::numeric * 299 / greatest(1,n-2)) ORDER BY y ASC,x) AS low_rank,
        row_number() OVER (PARTITION BY floor((rn-2)::numeric * 299 / greatest(1,n-2)) ORDER BY y DESC,x) AS high_rank
      FROM source WHERE n>600 AND rn>1 AND rn<n
    ) extremes WHERE low_rank=1 OR high_rank=1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('x',x,'y',y,'label',label) ORDER BY x),'[]'::jsonb) FROM picked
$$;

CREATE OR REPLACE FUNCTION build_team_rating_series(target_team uuid, cutoff date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public,pg_temp AS $$
  SELECT jsonb_build_object('kind','line','series',jsonb_build_array(jsonb_build_object(
    'label','Rating','points',sample_team_series(coalesce(jsonb_agg(jsonb_build_object(
      'x',(extract(epoch FROM (measure_date::timestamp AT TIME ZONE 'UTC'))*1000)::bigint,
      'y',rating,'label',to_char(measure_date,'YYYY-MM-DD')) ORDER BY measure_date),'[]'::jsonb)))))
  FROM team_rating WHERE team_id=target_team AND (cutoff IS NULL OR measure_date>=cutoff)
$$;

CREATE OR REPLACE FUNCTION refresh_one_team_rating_chart(target_team uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
DECLARE p record; data jsonb; today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Rating sources and dirty queue rows can outlive a deleted team. Remove
  -- any stale projection and let the bounded queue consume this orphan.
  IF NOT EXISTS (SELECT 1 FROM team WHERE id=target_team) THEN
    DELETE FROM team_rating_chart WHERE team_id=target_team;
    RETURN;
  END IF;
  FOR p IN SELECT * FROM (VALUES ('1m',today-interval '1 month'),('3m',today-interval '3 months'),
    ('6m',today-interval '6 months'),('1y',today-interval '1 year'),('5y',today-interval '5 years'),('all',NULL::timestamp)) v(period,cutoff)
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
DECLARE item record; processed integer:=0; today date := (now() AT TIME ZONE 'UTC')::date; previous_day date;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715029,1) THEN RETURN 0; END IF;
  SELECT utc_day INTO previous_day FROM team_rating_chart_clock WHERE id;
  IF previous_day IS DISTINCT FROM today THEN
    INSERT INTO team_rating_chart_dirty(team_id,revision)
    SELECT id,nextval('team_rating_chart_revision_seq') FROM team
    ON CONFLICT(team_id) DO UPDATE SET revision=EXCLUDED.revision;
    UPDATE team_rating_chart_clock SET utc_day=today WHERE id;
  END IF;
  FOR item IN SELECT team_id,revision FROM team_rating_chart_dirty ORDER BY revision,team_id LIMIT greatest(1,least(batch_size,100)) LOOP
    PERFORM refresh_one_team_rating_chart(item.team_id);
    DELETE FROM team_rating_chart_dirty WHERE team_id=item.team_id AND revision=item.revision;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;

CREATE OR REPLACE FUNCTION build_team_odds_series(target_group uuid,target_team uuid,first_position integer,last_position integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public,pg_temp AS $$
  WITH daily AS (
    SELECT recorded_on,sum(percent) AS percent FROM team_odds_history
    WHERE group_id=target_group AND team_id=target_team AND position BETWEEN first_position AND last_position
    GROUP BY recorded_on
    HAVING count(*)=last_position-first_position+1
  ), points AS (
    SELECT jsonb_agg(jsonb_build_object('x',(extract(epoch FROM (recorded_on::timestamp AT TIME ZONE 'UTC'))*1000)::bigint,
      'y',least(100,greatest(0,percent)),'label',to_char(recorded_on,'YYYY-MM-DD')) ORDER BY recorded_on) AS values
    FROM daily
  )
  SELECT jsonb_build_object('kind','line','yMin',0,'yMax',100,'series',jsonb_build_array(jsonb_build_object(
    'label','Position reach','points',sample_team_series(coalesce(values,'[]'::jsonb))))) FROM points
$$;

CREATE OR REPLACE FUNCTION refresh_team_odds_charts(target_group uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE item record; changed integer:=0; one_changed integer;
BEGIN
  INSERT INTO team_odds_chart AS d(id,group_id,team_id,zone_id,series_json)
  SELECT g.id::text||':'||m.team_id::text||':'||z.id::text,g.id,m.team_id,z.id,
    build_team_odds_series(g.id,m.team_id,z.first,z.last)::text
  FROM stage_group g JOIN team_group m ON m.group_id=g.id JOIN zone z ON z.group_id=g.id
  WHERE g.id=target_group
  ON CONFLICT(id) DO UPDATE SET series_json=EXCLUDED.series_json
  WHERE d.series_json IS DISTINCT FROM EXCLUDED.series_json;
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM team_odds_chart d WHERE d.group_id=target_group AND NOT EXISTS (
    SELECT 1 FROM team_group m JOIN zone z ON z.group_id=m.group_id
    WHERE m.group_id=d.group_id AND m.team_id=d.team_id AND z.id=d.zone_id
  );
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION refresh_team_odds_chart_queue(batch_size integer DEFAULT 20) RETURNS integer
LANGUAGE plpgsql SET search_path = public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE item record; processed integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715029,2) THEN RETURN 0; END IF;
  FOR item IN SELECT group_id,revision FROM team_odds_chart_dirty ORDER BY revision,group_id LIMIT greatest(1,least(batch_size,100)) LOOP
    PERFORM refresh_team_odds_charts(item.group_id);
    DELETE FROM team_odds_chart_dirty WHERE group_id=item.group_id AND revision=item.revision;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;

-- Called only by the odds computation's post-commit hook. The live computation
-- has already replaced every sink before this transaction starts; validate
-- each requested group as a complete N-by-N position matrix before recording
-- a single cell. Imported legacy snapshots are never copied through this path.
CREATE OR REPLACE FUNCTION capture_team_odds_history() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp
SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE captured_time timestamptz := clock_timestamp(); captured integer; target_group uuid;
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
  WHERE (target.captured_at,target.percent,target.source)
    IS DISTINCT FROM (EXCLUDED.captured_at,EXCLUDED.percent,'computed');
  GET DIAGNOSTICS captured=ROW_COUNT;

  FOR target_group IN SELECT group_id FROM _computed_odds_groups ORDER BY group_id LOOP
    PERFORM refresh_team_odds_charts(target_group);
  END LOOP;
  RETURN captured;
END $$;

CREATE OR REPLACE FUNCTION refresh_one_team_roster_total(target_team uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
BEGIN
  INSERT INTO team_roster_total AS d(id,team_id,championship_id,championship_name,played,started,came_on,bench,minutes,
    goals,penalties,own_goals,yellow,red,off_rating,def_rating,contribution,contribution_per90,goals_per90)
  SELECT r.championship_id::text||':'||target_team::text,target_team,r.championship_id,r.championship_name,
    sum(r.played)::integer,sum(r.started)::integer,sum(r.came_on)::integer,sum(r.bench)::integer,sum(r.minutes)::integer,
    sum(r.goals)::integer,sum(r.penalties)::integer,sum(r.own_goals)::integer,sum(r.yellow)::integer,sum(r.red)::integer,
    sum(r.off_rating),sum(r.def_rating),sum(r.contribution),
    CASE WHEN sum(r.minutes)>0 THEN sum(r.contribution)*90/sum(r.minutes) END,
    CASE WHEN sum(r.minutes)>0 THEN sum(r.goals)*90.0/sum(r.minutes) END
  FROM team_roster r WHERE r.team_id=target_team GROUP BY r.championship_id,r.championship_name
  ON CONFLICT(id) DO UPDATE SET championship_name=EXCLUDED.championship_name,played=EXCLUDED.played,
    started=EXCLUDED.started,came_on=EXCLUDED.came_on,bench=EXCLUDED.bench,minutes=EXCLUDED.minutes,
    goals=EXCLUDED.goals,penalties=EXCLUDED.penalties,own_goals=EXCLUDED.own_goals,yellow=EXCLUDED.yellow,red=EXCLUDED.red,
    off_rating=EXCLUDED.off_rating,def_rating=EXCLUDED.def_rating,contribution=EXCLUDED.contribution,
    contribution_per90=EXCLUDED.contribution_per90,goals_per90=EXCLUDED.goals_per90
  WHERE (d.championship_name,d.played,d.started,d.came_on,d.bench,d.minutes,d.goals,d.penalties,d.own_goals,d.yellow,d.red,
    d.off_rating,d.def_rating,d.contribution,d.contribution_per90,d.goals_per90)
    IS DISTINCT FROM (EXCLUDED.championship_name,EXCLUDED.played,EXCLUDED.started,EXCLUDED.came_on,EXCLUDED.bench,
    EXCLUDED.minutes,EXCLUDED.goals,EXCLUDED.penalties,EXCLUDED.own_goals,EXCLUDED.yellow,EXCLUDED.red,
    EXCLUDED.off_rating,EXCLUDED.def_rating,EXCLUDED.contribution,EXCLUDED.contribution_per90,EXCLUDED.goals_per90);
  DELETE FROM team_roster_total WHERE team_id=target_team AND NOT EXISTS (
    SELECT 1 FROM team_roster r WHERE r.team_id=target_team AND r.championship_id=team_roster_total.championship_id
  );
END $$;

CREATE OR REPLACE FUNCTION refresh_team_roster_totals(batch_size integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SET search_path = public,pg_temp SET statement_timeout='20s' SET lock_timeout='2s' AS $$
DECLARE item record; processed integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715029,3) THEN RETURN 0; END IF;
  FOR item IN SELECT team_id,revision FROM team_roster_total_dirty ORDER BY revision,team_id LIMIT greatest(1,least(batch_size,200)) LOOP
    PERFORM refresh_one_team_roster_total(item.team_id);
    DELETE FROM team_roster_total_dirty WHERE team_id=item.team_id AND revision=item.revision;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;

-- Rating-only appearance updates coalesce by player and championship. This
-- queue is durable and outside CDC; other appearance changes keep the normal
-- absolute player-stat recount. Revisions protect updates arriving mid-refresh.
CREATE SEQUENCE IF NOT EXISTS player_metric_revision_seq;
CREATE TABLE IF NOT EXISTS player_metric_dirty (
  player_id uuid NOT NULL, championship_id uuid NOT NULL, revision bigint NOT NULL,
  PRIMARY KEY(player_id,championship_id)
);
CREATE INDEX IF NOT EXISTS player_metric_dirty_revision_idx ON player_metric_dirty(revision,player_id,championship_id);
REVOKE ALL ON player_metric_dirty FROM PUBLIC,anon,app_user,electric;
GRANT SELECT,INSERT,UPDATE,DELETE ON player_metric_dirty TO service;
GRANT USAGE,SELECT ON SEQUENCE player_metric_revision_seq TO service;

CREATE OR REPLACE FUNCTION mark_player_metric_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT player_id,game_id FROM (
      SELECT CASE WHEN TG_OP<>'INSERT' THEN OLD.player_id END AS player_id,
        CASE WHEN TG_OP<>'INSERT' THEN OLD.game_id END AS game_id
      UNION SELECT CASE WHEN TG_OP<>'DELETE' THEN NEW.player_id END,
        CASE WHEN TG_OP<>'DELETE' THEN NEW.game_id END
    ) rows WHERE player_id IS NOT NULL
  LOOP
    INSERT INTO player_metric_dirty(player_id,championship_id,revision)
    SELECT affected.player_id,p.championship_id,nextval('player_metric_revision_seq')
    FROM game g JOIN phase p ON p.id=g.phase_id WHERE g.id=affected.game_id
    ON CONFLICT(player_id,championship_id) DO UPDATE SET revision=EXCLUDED.revision;
    IF NOT FOUND THEN
      -- A cascade may already have removed the parent game. Retained stats
      -- still name the seasons whose removed appearance totals must be cleared.
      INSERT INTO player_metric_dirty(player_id,championship_id,revision)
      SELECT affected.player_id,championship_id,nextval('player_metric_revision_seq')
      FROM (SELECT DISTINCT championship_id FROM player_stat WHERE player_id=affected.player_id) seasons
      ON CONFLICT(player_id,championship_id) DO UPDATE SET revision=EXCLUDED.revision;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS player_metric_dirty_update ON player_game;
DROP TRIGGER IF EXISTS player_metric_dirty_insert_delete ON player_game;
CREATE TRIGGER player_metric_dirty_insert_delete AFTER INSERT OR DELETE ON player_game FOR EACH ROW
  EXECUTE FUNCTION mark_player_metric_dirty();
CREATE TRIGGER player_metric_dirty_update AFTER UPDATE ON player_game FOR EACH ROW
  WHEN ((OLD.player_id,OLD.game_id,OLD.side,OLD.off_rating,OLD.def_rating)
    IS DISTINCT FROM (NEW.player_id,NEW.game_id,NEW.side,NEW.off_rating,NEW.def_rating))
  EXECUTE FUNCTION mark_player_metric_dirty();

CREATE OR REPLACE FUNCTION mark_game_player_metric_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO player_metric_dirty(player_id,championship_id,revision)
  SELECT affected.player_id,affected.championship_id,nextval('player_metric_revision_seq')
  FROM (SELECT DISTINCT pg.player_id,p.championship_id FROM player_game pg
    CROSS JOIN phase p WHERE pg.game_id=NEW.id AND p.id IN (OLD.phase_id,NEW.phase_id)) affected
  ON CONFLICT(player_id,championship_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS game_player_metric_update ON game;
CREATE TRIGGER game_player_metric_update AFTER UPDATE ON game FOR EACH ROW
  WHEN ((OLD.phase_id,OLD.home_id,OLD.away_id) IS DISTINCT FROM (NEW.phase_id,NEW.home_id,NEW.away_id))
  EXECUTE FUNCTION mark_game_player_metric_dirty();

CREATE OR REPLACE FUNCTION mark_player_stat_metric_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO player_metric_dirty VALUES (NEW.player_id,NEW.championship_id,nextval('player_metric_revision_seq'))
  ON CONFLICT(player_id,championship_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS player_stat_metric_insert ON player_stat;
DROP TRIGGER IF EXISTS player_stat_metric_update ON player_stat;
CREATE TRIGGER player_stat_metric_insert AFTER INSERT ON player_stat FOR EACH ROW
  EXECUTE FUNCTION mark_player_stat_metric_dirty();
CREATE TRIGGER player_stat_metric_update AFTER UPDATE ON player_stat FOR EACH ROW
  WHEN ((OLD.player_id,OLD.championship_id,OLD.team_id,OLD.minutes,OLD.goals)
    IS DISTINCT FROM (NEW.player_id,NEW.championship_id,NEW.team_id,NEW.minutes,NEW.goals))
  EXECUTE FUNCTION mark_player_stat_metric_dirty();

-- Metrics are copied directly into matching roster rows by the sync trigger.
-- Rebuilding the whole profile is only needed for other PlayerStat changes.
DROP TRIGGER IF EXISTS team_profile_dirty_player_stat ON player_stat;
DROP TRIGGER IF EXISTS team_profile_dirty_player_stat_update ON player_stat;
CREATE TRIGGER team_profile_dirty_player_stat AFTER INSERT OR DELETE ON player_stat
  FOR EACH ROW EXECUTE FUNCTION mark_team_profile_dirty();
CREATE TRIGGER team_profile_dirty_player_stat_update AFTER UPDATE ON player_stat FOR EACH ROW
  WHEN ((to_jsonb(OLD)-ARRAY['off_rating','def_rating','contribution','contribution_per90','goals_per90','txid'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['off_rating','def_rating','contribution','contribution_per90','goals_per90','txid']))
  EXECUTE FUNCTION mark_team_profile_dirty();

CREATE OR REPLACE FUNCTION refresh_player_metric_queue(batch_size integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='20s' SET lock_timeout='2s' AS $$
DECLARE item record; processed integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715029,4) THEN RETURN 0; END IF;
  FOR item IN SELECT player_id,championship_id,revision FROM player_metric_dirty
    ORDER BY revision,player_id,championship_id LIMIT greatest(1,least(batch_size,1000)) LOOP
    WITH ratings AS (
      SELECT CASE WHEN pg.side='home' THEN g.home_id ELSE g.away_id END AS team_id,
        sum(pg.off_rating)::double precision AS offense,sum(pg.def_rating)::double precision AS defense
      FROM player_game pg JOIN game g ON g.id=pg.game_id JOIN phase p ON p.id=g.phase_id
      WHERE pg.player_id=item.player_id AND p.championship_id=item.championship_id
      GROUP BY 1
    ), metrics AS (
      SELECT ps.id,r.offense,r.defense,
        CASE WHEN r.offense IS NOT NULL OR r.defense IS NOT NULL
          THEN coalesce(r.offense,0)+coalesce(r.defense,0) END AS contribution,
        ps.minutes,ps.goals FROM player_stat ps LEFT JOIN ratings r ON r.team_id=ps.team_id
      WHERE ps.player_id=item.player_id AND ps.championship_id=item.championship_id
    )
    UPDATE player_stat ps SET off_rating=m.offense,def_rating=m.defense,contribution=m.contribution,
      contribution_per90=CASE WHEN m.minutes>0 THEN m.contribution*90/m.minutes END,
      goals_per90=CASE WHEN m.minutes>0 THEN m.goals*90.0/m.minutes END
    FROM metrics m WHERE ps.id=m.id AND
      (ps.off_rating,ps.def_rating,ps.contribution,ps.contribution_per90,ps.goals_per90) IS DISTINCT FROM
      (m.offense,m.defense,m.contribution,CASE WHEN m.minutes>0 THEN m.contribution*90/m.minutes END,
        CASE WHEN m.minutes>0 THEN m.goals*90.0/m.minutes END);
    DELETE FROM player_metric_dirty WHERE player_id=item.player_id
      AND championship_id=item.championship_id AND revision=item.revision;
    processed:=processed+1;
  END LOOP;
  RETURN processed;
END $$;
REVOKE ALL ON FUNCTION mark_player_metric_dirty(),mark_game_player_metric_dirty(),mark_player_stat_metric_dirty(),refresh_player_metric_queue(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_player_metric_queue(integer) TO service;

CREATE OR REPLACE FUNCTION refresh_team_enrichment(roster_batch integer DEFAULT 50,
  rating_batch integer DEFAULT 10,odds_batch integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp
SET statement_timeout='25s' SET lock_timeout='2s' AS $$
DECLARE roster_count integer; rating_count integer; odds_count integer; metric_count integer;
BEGIN
  metric_count:=refresh_player_metric_queue(roster_batch);
  roster_count:=refresh_team_roster_totals(roster_batch);
  rating_count:=refresh_team_rating_charts(rating_batch);
  odds_count:=refresh_team_odds_chart_queue(odds_batch);
  RETURN jsonb_build_object('roster_totals',roster_count,'rating_charts',rating_count,'odds_charts',odds_count,'player_metrics',metric_count);
END $$;

REVOKE ALL ON FUNCTION stamp_team_game_filter_keys(),mark_team_roster_total_insert(),mark_team_roster_total_update(),
  mark_team_roster_total_delete(),mark_team_rating_chart_insert(),mark_team_rating_chart_update(),
  mark_team_rating_chart_delete(),mark_team_odds_history_insert(),mark_team_odds_history_update(),
  mark_team_odds_history_delete(),mark_team_odds_zone_dirty(),mark_team_odds_members_dirty(),enqueue_team_roster_total(uuid),
  enqueue_team_rating_chart(uuid),enqueue_team_odds_chart(uuid),sample_team_series(jsonb),
  build_team_rating_series(uuid,date),refresh_one_team_rating_chart(uuid),refresh_team_rating_charts(integer),
  build_team_odds_series(uuid,uuid,integer,integer),refresh_team_odds_charts(uuid),refresh_team_odds_chart_queue(integer),
  capture_team_odds_history(),
  refresh_one_team_roster_total(uuid),refresh_team_roster_totals(integer),refresh_team_enrichment(integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_team_rating_charts(integer),refresh_team_odds_charts(uuid),
  refresh_team_odds_chart_queue(integer),refresh_team_roster_totals(integer),refresh_team_enrichment(integer,integer,integer),
  capture_team_odds_history() TO service;

-- New/retained installs compute their chart and aggregate projections in
-- bounded batches after source rows have arrived.
INSERT INTO team_rating_chart_dirty(team_id,revision)
SELECT id,nextval('team_rating_chart_revision_seq') FROM team
ON CONFLICT(team_id) DO NOTHING;
INSERT INTO team_roster_total_dirty(team_id,revision)
SELECT id,nextval('team_roster_total_revision_seq') FROM team
ON CONFLICT(team_id) DO NOTHING;
INSERT INTO team_odds_chart_dirty(group_id,revision)
SELECT id,nextval('team_odds_chart_revision_seq') FROM stage_group
ON CONFLICT(group_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
