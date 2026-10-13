-- Page reads served from maintained rows or bounded plans rather than
-- recomputed per request.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- PostgREST runs each read as a prepared statement, and after five runs a
-- connection may keep its generic plan. There `category_key LIKE $3` has no
-- selectivity, so a player's games were planned from every championship
-- (0.5-0.8 s) instead of from the player's own rows. Each appearance now finds
-- its game by key behind a fence the planner cannot reorder around.
CREATE OR REPLACE VIEW player_appearance WITH (security_invoker=true) AS
SELECT a.id,a.player_id,a.game_id,a.side,a.on_minute,a.off_minute,a.yellow,a.red,a.bench,
  g.day,g.day_display,g.kickoff,g.kickoff_local,g.played,g.played::text AS played_key,g.slug AS game_slug,
  g.phase_id,g.phase_name,g.championship_id,g.championship_name,g.championship_slug,
  g.category_id,g.category_key,g.round,g.round_key,g.week,g.week_key,
  CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END AS team_id,
  CASE WHEN a.side='home' THEN g.home_name ELSE g.away_name END AS team_name,
  CASE WHEN a.side='home' THEN g.home_slug ELSE g.away_slug END AS team_slug,
  g.home_id,g.away_id,g.home_name,g.away_name,g.home_country,g.away_country,g.show_country,
  g.home_score,g.away_score,g.home_aet,g.away_aet,g.home_pen,g.away_pen,
  duration.minutes,a.off_rating,a.def_rating,metric.contribution,
  CASE WHEN duration.minutes>0 THEN metric.contribution*90/duration.minutes END AS contribution_per90,
  scored.goals,scored.penalties,scored.own_goals,
  CASE WHEN duration.minutes>0 THEN scored.goals*90.0/duration.minutes END::double precision AS goals_per90,
  NULL::bigint AS txid,'public:'::text AS scope_id,
  g.home_logo_key,g.away_logo_key
FROM player_game a
CROSS JOIN LATERAL (SELECT * FROM game_archive g WHERE g.id=a.game_id OFFSET 0) g
CROSS JOIN LATERAL (SELECT CASE WHEN NOT g.played OR a.bench THEN 0
  ELSE greatest(0,coalesce(a.off_minute,greatest(a.on_minute,90))-a.on_minute) END AS minutes) duration
CROSS JOIN LATERAL (SELECT CASE WHEN a.off_rating IS NOT NULL OR a.def_rating IS NOT NULL
  THEN coalesce(a.off_rating,0)+coalesce(a.def_rating,0) END AS contribution) metric
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE NOT own_goal)::integer AS goals,
    count(*) FILTER (WHERE penalty AND NOT own_goal)::integer AS penalties,
    count(*) FILTER (WHERE own_goal)::integer AS own_goals
  FROM goal WHERE player_id=a.player_id AND game_id=a.game_id
) scored;

-- Running totals over the batch grid replace a self-join per batch, and the
-- head-to-head points are summed only for a ladder that ranks by them.
CREATE OR REPLACE FUNCTION compute_team_campaign_rows(target_group uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public,pg_temp AS $fn$
  WITH group_rule AS (
    SELECT sg.id AS group_id,p.id AS phase_id,p.sort,p.bonus_points,p.bonus_points_threshold,
      c.point_win,c.point_draw,c.point_loss,
      'head'=ANY(string_to_array(p.sort,',')) AS by_head
    FROM stage_group sg JOIN phase p ON p.id=sg.phase_id JOIN championship c ON c.id=p.championship_id
    WHERE sg.id=target_group
  ), members AS (
    SELECT tg.team_id,t.name,tg.add_sub,tg.bias,
      count(*) OVER ()::integer AS group_size
    FROM team_group tg JOIN team t ON t.id=tg.team_id
    WHERE tg.group_id=target_group
  ), chronological AS (
    SELECT g.id,g.day,g.kickoff,g.home_id,g.away_id,g.home_score,g.away_score,
      g.home_aet,g.away_aet,g.home_pen,g.away_pen,
      CASE WHEN g.round IS NULL THEN 'd:'||g.day::text ELSE 'r:'||g.round::text END AS batch_key
    FROM game g JOIN group_rule r ON r.phase_id=g.phase_id
    WHERE g.played AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
      AND (EXISTS(SELECT 1 FROM members m WHERE m.team_id=g.home_id)
        OR EXISTS(SELECT 1 FROM members m WHERE m.team_id=g.away_id))
  ), numbered AS (
    SELECT c.*,sum(changed) OVER(ORDER BY day,kickoff NULLS FIRST,id ROWS UNBOUNDED PRECEDING) AS batch_no
    FROM (SELECT c.*,(lag(batch_key) OVER(ORDER BY day,kickoff NULLS FIRST,id) IS DISTINCT FROM batch_key)::integer AS changed
      FROM chronological c) c
  ), batches AS (
    SELECT batch_no,max(day) AS day FROM numbered GROUP BY batch_no
  ), sides AS (
    SELECT g.batch_no,g.id AS game_id,g.day,g.kickoff,m.team_id,
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
        THEN r.point_win+CASE WHEN r.bonus_points>0
          AND (CASE WHEN g.home_id=m.team_id THEN g.home_score-g.away_score ELSE g.away_score-g.home_score END)>=r.bonus_points_threshold
          THEN r.bonus_points ELSE 0 END
        WHEN g.home_score=g.away_score THEN r.point_draw ELSE r.point_loss END AS earned_points
    FROM numbered g JOIN members m ON m.team_id IN (g.home_id,g.away_id) CROSS JOIN group_rule r
  ), per_batch AS (
    SELECT team_id,batch_no,sum(earned_points) AS points,count(*) AS played,
      count(*) FILTER(WHERE result='w') AS wins,count(*) FILTER(WHERE result='d') AS draws,
      count(*) FILTER(WHERE result='l') AS losses,
      sum(goals_for) AS goals_for,sum(goals_against) AS goals_against,sum(goals_away) AS goals_away,
      sum(goals_aet) AS goals_aet,sum(goals_pen) AS goals_pen
    FROM sides GROUP BY team_id,batch_no
  ), campaigns AS (
    -- Running totals over the batch grid: a team without a game in a batch
    -- carries its previous totals into it.
    SELECT b.batch_no,m.team_id,m.name,m.bias,m.add_sub,m.group_size,
      coalesce(sum(s.points) OVER w,0)+m.add_sub AS points,
      coalesce(sum(s.played) OVER w,0)::integer AS played,
      coalesce(sum(s.wins) OVER w,0)::integer AS wins,
      coalesce(sum(s.goals_for) OVER w,0)::integer AS goals_for,
      coalesce(sum(s.goals_against) OVER w,0)::integer AS goals_against,
      coalesce(sum(s.goals_away) OVER w,0)::integer AS goals_away,
      coalesce(sum(s.goals_aet) OVER w,0)::integer AS goals_aet,
      coalesce(sum(s.goals_pen) OVER w,0)::integer AS goals_pen
    FROM batches b CROSS JOIN members m
    LEFT JOIN per_batch s ON s.team_id=m.team_id AND s.batch_no=b.batch_no
    WINDOW w AS (PARTITION BY m.team_id ORDER BY b.batch_no ROWS UNBOUNDED PRECEDING)
  ), pair_batch AS (
    -- Points a team took from each opponent, only for a ladder that ranks by
    -- head-to-head.
    SELECT s.team_id,s.opponent_id,s.batch_no,sum(s.earned_points) AS points
    FROM sides s WHERE (SELECT by_head FROM group_rule)
    GROUP BY s.team_id,s.opponent_id,s.batch_no
  ), peers AS (
    -- Each team's rivals level on points in a batch, only for a ladder that
    -- ranks by head-to-head.
    SELECT c.batch_no,c.team_id,p.team_id AS peer_id
    FROM campaigns c JOIN campaigns p ON p.batch_no=c.batch_no AND p.points=c.points AND p.team_id<>c.team_id
    WHERE (SELECT by_head FROM group_rule)
  ), head_points AS (
    SELECT pr.batch_no,pr.team_id,count(DISTINCT pr.peer_id)::integer AS count,sum(pb.points) AS points
    FROM peers pr LEFT JOIN pair_batch pb ON pb.team_id=pr.team_id AND pb.opponent_id=pr.peer_id AND pb.batch_no<=pr.batch_no
    GROUP BY pr.batch_no,pr.team_id
  ), headed AS (
    SELECT c.*,CASE WHEN NOT (SELECT by_head FROM group_rule) THEN 0
      WHEN c.group_size<=2 OR coalesce(h.count,0)=c.group_size-1 THEN 0
      ELSE coalesce(h.points,0)+c.add_sub END AS head
    FROM campaigns c LEFT JOIN head_points h ON h.batch_no=c.batch_no AND h.team_id=c.team_id
  ), keyed AS (
    SELECT h.batch_no,h.team_id,h.points,(
      SELECT string_agg(CASE key WHEN 'name' THEN h.name::text COLLATE "C"
        ELSE lpad((9000000000000::bigint-round(value*1000000)::bigint)::text,13,'0') END,
        chr(31) ORDER BY ordinal)
      FROM unnest(string_to_array((SELECT sort FROM group_rule),',')) WITH ORDINALITY AS rule(key,ordinal)
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
  ), ranked AS MATERIALIZED (
    SELECT k.*,row_number() OVER(PARTITION BY k.batch_no ORDER BY k.sort_key COLLATE "C",k.team_id)::integer AS position
    FROM keyed k
  ), played_sequence AS (
    SELECT s.*,row_number() OVER(PARTITION BY s.team_id ORDER BY s.batch_no,s.day,s.kickoff NULLS FIRST,s.game_id)::integer AS sequence
    FROM sides s
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('team_id',p.team_id,'game_id',p.game_id,'sequence',p.sequence,
    'day',p.day,'points',r.points,'position',r.position,'result',p.result)
    ORDER BY p.team_id,p.sequence),'[]'::jsonb)
  FROM played_sequence p JOIN ranked r ON r.batch_no=p.batch_no AND r.team_id=p.team_id
$fn$;
REVOKE EXECUTE ON FUNCTION compute_team_campaign_rows(uuid) FROM app_user;

-- Campaign history becomes a maintained table again, refreshed per group by
-- the team-chart queue's drain: computed on read it cost a large group's page
-- a ranking of every round, three times.
DROP FUNCTION IF EXISTS game(team_campaign_point);
DROP FUNCTION IF EXISTS team(team_campaign_point);
DO $$ DECLARE alias record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.team_campaign_point') AND relkind='v') THEN
    -- pgroll's version schemas alias the relation; other dependents must fail.
    IF to_regclass('pgroll.migrations') IS NOT NULL THEN
      FOR alias IN
        SELECT n.nspname,c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
        WHERE m.schema='public' AND c.relname='team_campaign_point' AND c.relkind='v'
      LOOP
        EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname);
      END LOOP;
    END IF;
    DROP VIEW team_campaign_point;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS team_campaign_point (
  "id" text PRIMARY KEY,
  "group_id" uuid NOT NULL REFERENCES stage_group(id) ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  "game_id" uuid NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  "sequence" integer NOT NULL CHECK (sequence >= 1),
  "day" date NOT NULL CONSTRAINT "team_campaign_point_day_type" CHECK ("day" IS NULL OR public.portable_date_valid("day") IS TRUE),
  "points" integer NOT NULL,
  "position" integer NOT NULL CHECK (position >= 1),
  "result" text NOT NULL CHECK (result IN ('w', 'd', 'l')),
  "txid" BIGINT DEFAULT pg_current_xact_id()::text::bigint,
  "scope_id" TEXT GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CREATE INDEX IF NOT EXISTS team_campaign_point_group_team_sequence_idx
  ON team_campaign_point (group_id,team_id,sequence);
CREATE INDEX IF NOT EXISTS team_campaign_point_game_idx ON team_campaign_point (game_id);
CALL rls_protect('team_campaign_point');
DROP POLICY IF EXISTS team_campaign_point_app_user_select ON team_campaign_point;
CREATE POLICY team_campaign_point_app_user_select ON team_campaign_point FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_campaign_point_service_all ON team_campaign_point;
CREATE POLICY team_campaign_point_service_all ON team_campaign_point FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON team_campaign_point FROM anon;
GRANT SELECT ON team_campaign_point TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_campaign_point TO service;
DROP TRIGGER IF EXISTS restamp_txid ON team_campaign_point;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_campaign_point
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();

CREATE OR REPLACE FUNCTION refresh_team_campaign_points(target_group uuid) RETURNS integer
LANGUAGE sql SET search_path=public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
  WITH fresh AS (
    SELECT target_group::text||':'||item.team_id::text||':'||item.game_id::text AS id,item.*
    FROM jsonb_to_recordset(compute_team_campaign_rows(target_group)) AS item(
      team_id uuid,game_id uuid,sequence integer,day date,points integer,position integer,result text)
  ), written AS (
    INSERT INTO team_campaign_point AS d(id,group_id,team_id,game_id,sequence,day,points,position,result)
    SELECT id,target_group,team_id,game_id,sequence,day,points,position,result FROM fresh
    ON CONFLICT(id) DO UPDATE SET sequence=EXCLUDED.sequence,day=EXCLUDED.day,points=EXCLUDED.points,
      position=EXCLUDED.position,result=EXCLUDED.result
    WHERE (d.sequence,d.day,d.points,d.position,d.result)
      IS DISTINCT FROM (EXCLUDED.sequence,EXCLUDED.day,EXCLUDED.points,EXCLUDED.position,EXCLUDED.result)
    RETURNING 1
  ), removed AS (
    DELETE FROM team_campaign_point d WHERE d.group_id=target_group
      AND NOT EXISTS (SELECT 1 FROM fresh f WHERE f.id=d.id)
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM written)+(SELECT count(*) FROM removed))::integer
$$;

-- The team-chart queue's drain and the capture hook call this one entry point.
CREATE OR REPLACE FUNCTION refresh_team_odds_charts(target_group uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='30s' SET lock_timeout='2s' AS $$
DECLARE changed integer;
BEGIN
  INSERT INTO team_odds_chart AS d(id,group_id,team_id,zone_id,series_json)
  SELECT g.id::text||':'||m.team_id::text||':'||z.id::text,g.id,m.team_id,z.id,
    build_team_odds_series(g.id,m.team_id,z.first,z.last,z.positions)::text
  FROM stage_group g JOIN team_group m ON m.group_id=g.id JOIN zone z ON z.group_id=g.id WHERE g.id=target_group
  ON CONFLICT(id) DO UPDATE SET series_json=EXCLUDED.series_json WHERE d.series_json IS DISTINCT FROM EXCLUDED.series_json;
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM team_odds_chart d WHERE d.group_id=target_group AND NOT EXISTS (
    SELECT 1 FROM team_group m JOIN zone z ON z.group_id=m.group_id
    WHERE m.group_id=d.group_id AND m.team_id=d.team_id AND z.id=d.zone_id);
  RETURN changed+refresh_team_odds_progress(target_group)+refresh_team_campaign_points(target_group);
END $$;

-- A campaign follows every result in its group, recorded odds or not, and
-- the rules that rank it.
CREATE OR REPLACE FUNCTION mark_team_odds_game_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty(group_id,revision)
  SELECT sg.id,nextval('team_odds_chart_revision_seq')
  FROM stage_group sg WHERE EXISTS (
    SELECT 1 FROM team_group m WHERE m.group_id=sg.id AND (
      (TG_OP<>'INSERT' AND sg.phase_id=OLD.phase_id AND m.team_id IN (OLD.home_id,OLD.away_id)) OR
      (TG_OP<>'DELETE' AND sg.phase_id=NEW.phase_id AND m.team_id IN (NEW.home_id,NEW.away_id))))
  ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_game_update ON game;
CREATE TRIGGER team_odds_game_update AFTER UPDATE ON game FOR EACH ROW
  WHEN ((OLD.phase_id,OLD.home_id,OLD.away_id,OLD.round,OLD.day,OLD.kickoff,OLD.played,OLD.home_score,OLD.away_score,
      OLD.home_aet,OLD.away_aet,OLD.home_pen,OLD.away_pen,OLD.slug)
    IS DISTINCT FROM (NEW.phase_id,NEW.home_id,NEW.away_id,NEW.round,NEW.day,NEW.kickoff,NEW.played,NEW.home_score,NEW.away_score,
      NEW.home_aet,NEW.away_aet,NEW.home_pen,NEW.away_pen,NEW.slug))
  EXECUTE FUNCTION mark_team_odds_game_dirty();

CREATE OR REPLACE FUNCTION mark_team_odds_rule_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO team_odds_chart_dirty(group_id,revision)
  SELECT sg.id,nextval('team_odds_chart_revision_seq')
  FROM stage_group sg JOIN phase p ON p.id=sg.phase_id
  WHERE CASE TG_TABLE_NAME WHEN 'phase' THEN p.id=NEW.id ELSE p.championship_id=NEW.id END
  ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS team_odds_phase_rule_update ON phase;
CREATE TRIGGER team_odds_phase_rule_update AFTER UPDATE ON phase FOR EACH ROW
  WHEN ((OLD.sort,OLD.bonus_points,OLD.bonus_points_threshold) IS DISTINCT FROM (NEW.sort,NEW.bonus_points,NEW.bonus_points_threshold))
  EXECUTE FUNCTION mark_team_odds_rule_dirty();
DROP TRIGGER IF EXISTS team_odds_championship_rule_update ON championship;
CREATE TRIGGER team_odds_championship_rule_update AFTER UPDATE ON championship FOR EACH ROW
  WHEN ((OLD.point_win,OLD.point_draw,OLD.point_loss) IS DISTINCT FROM (NEW.point_win,NEW.point_draw,NEW.point_loss))
  EXECUTE FUNCTION mark_team_odds_rule_dirty();

REVOKE ALL ON FUNCTION refresh_team_campaign_points(uuid),mark_team_odds_rule_dirty() FROM PUBLIC,anon,app_user;
GRANT EXECUTE ON FUNCTION refresh_team_campaign_points(uuid) TO service;

-- Every group's history, once; the queue keeps it from here.
INSERT INTO team_campaign_point(id,group_id,team_id,game_id,sequence,day,points,position,result)
SELECT sg.id::text||':'||item.team_id::text||':'||item.game_id::text,sg.id,item.team_id,item.game_id,
  item.sequence,item.day,item.points,item.position,item.result
FROM stage_group sg CROSS JOIN LATERAL jsonb_to_recordset(compute_team_campaign_rows(sg.id)) AS item(
  team_id uuid,game_id uuid,sequence integer,day date,points integer,position integer,result text)
ON CONFLICT(id) DO NOTHING;

-- A user's counts were three scans of comments and edits per listed user; a
-- prolific editor's 45,000 edits cost the user directory a quarter second.
CREATE TABLE IF NOT EXISTS user_activity (
  app_user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  comment_count bigint NOT NULL,
  edit_count bigint NOT NULL,
  last_edit_at timestamptz
);
REVOKE ALL ON user_activity FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON user_activity TO anon,app_user,service;

CREATE OR REPLACE FUNCTION refresh_user_activity(targets uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  INSERT INTO user_activity AS a(app_user_id,comment_count,edit_count,last_edit_at)
  SELECT u.id,
    (SELECT count(*) FROM comment c WHERE c.app_user_id=u.id)+(SELECT count(*) FROM team_comment c WHERE c.app_user_id=u.id),
    (SELECT count(*) FROM game_change c WHERE c.actor_id=u.id),
    (SELECT max(c.created_at) FROM game_change c WHERE c.actor_id=u.id)
  FROM app_user u WHERE u.id=ANY(targets)
  ON CONFLICT(app_user_id) DO UPDATE SET comment_count=EXCLUDED.comment_count,
    edit_count=EXCLUDED.edit_count,last_edit_at=EXCLUDED.last_edit_at
  WHERE (a.comment_count,a.edit_count,a.last_edit_at)
    IS DISTINCT FROM (EXCLUDED.comment_count,EXCLUDED.edit_count,EXCLUDED.last_edit_at)
$$;
CREATE OR REPLACE FUNCTION mark_user_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE author text := CASE TG_TABLE_NAME WHEN 'game_change' THEN 'actor_id' ELSE 'app_user_id' END; targets uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    EXECUTE format('SELECT array_agg(DISTINCT %I) FROM new_rows WHERE %I IS NOT NULL',author,author) INTO targets;
  ELSIF TG_OP='DELETE' THEN
    EXECUTE format('SELECT array_agg(DISTINCT %I) FROM old_rows WHERE %I IS NOT NULL',author,author) INTO targets;
  ELSE
    EXECUTE format('SELECT array_agg(DISTINCT u) FROM (SELECT %I u FROM old_rows UNION SELECT %I FROM new_rows) s WHERE u IS NOT NULL',author,author) INTO targets;
  END IF;
  IF targets IS NOT NULL THEN PERFORM refresh_user_activity(targets); END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['comment','team_comment','game_change'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS user_activity_insert ON %I',target);
    EXECUTE format('CREATE TRIGGER user_activity_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_user_activity()',target);
    EXECUTE format('DROP TRIGGER IF EXISTS user_activity_update ON %I',target);
    EXECUTE format('CREATE TRIGGER user_activity_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_user_activity()',target);
    EXECUTE format('DROP TRIGGER IF EXISTS user_activity_delete ON %I',target);
    EXECUTE format('CREATE TRIGGER user_activity_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_user_activity()',target);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION refresh_user_activity(uuid[]),mark_user_activity() FROM PUBLIC,anon,app_user;
SELECT refresh_user_activity(array_agg(id)) FROM app_user;

CREATE OR REPLACE VIEW user_directory WITH (security_invoker=true) AS
SELECT u.id,u.handle,coalesce(nullif(trim(p.display_name),''),u.handle) AS display_name,
  p.location,p.about_me,u.created_at AS joined_at,p.id AS biography_id,
  coalesce(s.comment_count,0) AS comment_count,
  coalesce(s.edit_count,0) AS edit_count,
  s.last_edit_at,
  replace(replace(replace(coalesce(p.display_name,'')||' '||u.handle||' '||coalesce(p.location,''),
    'ı','i'),'þ','th'),'Þ','th') COLLATE golaberto_search AS search_key,
  NULL::bigint AS txid,'public:'::text AS scope_id,a.id AS avatar_id,
  to_char(u.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS joined_on,a.avatar_key
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id LEFT JOIN user_avatar a ON a.id=u.id
  LEFT JOIN user_activity s ON s.app_user_id=u.id;

NOTIFY pgrst,'reload schema';
COMMIT;
