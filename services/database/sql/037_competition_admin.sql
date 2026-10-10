SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

ALTER TABLE zone ADD COLUMN IF NOT EXISTS positions text NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION competition_zone_positions(raw text) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public,pg_temp AS $$
DECLARE result integer[];
BEGIN
  IF raw='' THEN RETURN ARRAY[]::integer[]; END IF;
  IF length(raw)>4999 OR raw !~ '^[1-9][0-9]{0,3}(,[1-9][0-9]{0,3})*$' THEN
    RAISE EXCEPTION 'zone positions must be comma-separated positive integers' USING ERRCODE='23514';
  END IF;
  result:=string_to_array(raw,',')::integer[];
  IF EXISTS(SELECT 1 FROM unnest(result) p WHERE p>1000)
    OR cardinality(result)<>(SELECT count(DISTINCT p) FROM unnest(result) p) THEN
    RAISE EXCEPTION 'zone positions must be unique and at most 1000' USING ERRCODE='23514';
  END IF;
  RETURN ARRAY(SELECT p FROM unnest(result) p ORDER BY p);
END $$;
CREATE OR REPLACE FUNCTION competition_stamp_zone() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  NEW.positions:=array_to_string(competition_zone_positions(NEW.positions),',');
  NEW.color:=lower(NEW.color);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS competition_stamp_zone ON zone;
CREATE TRIGGER competition_stamp_zone BEFORE INSERT OR UPDATE ON zone
  FOR EACH ROW EXECUTE FUNCTION competition_stamp_zone();
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_positions_check;
ALTER TABLE zone ADD CONSTRAINT zone_positions_check CHECK (
  positions=array_to_string(competition_zone_positions(positions),',')) NOT VALID;
UPDATE zone SET color=lower(color) WHERE color<>lower(color);

DO $$ DECLARE target text; field text; writable text; all_columns text; BEGIN
  FOREACH target IN ARRAY ARRAY['championship','phase','stage_group','team_group','zone'] LOOP
    FOREACH field IN ARRAY ARRAY['created_by','updated_by'] LOOP
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I uuid',target,field);
      IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target::regclass
        AND conname=target||'_'||field||'_fkey' AND confdeltype<>'n') THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target,target||'_'||field||'_fkey');
      END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=target::regclass
        AND conname=target||'_'||field||'_fkey') THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES app_user(id) ON DELETE SET NULL',
          target,target||'_'||field||'_fkey',field);
      END IF;
    END LOOP;
    writable:=CASE target
      WHEN 'championship' THEN 'name,category_id,region,region_name,begins,ends,point_win,point_draw,point_loss,show_country,featured'
      WHEN 'phase' THEN 'championship_id,name,position,sort,bonus_points,bonus_points_threshold'
      WHEN 'stage_group' THEN 'phase_id,name,position'
      WHEN 'team_group' THEN 'group_id,team_id,add_sub,bias,comment'
      WHEN 'zone' THEN 'group_id,name,color,first,last,positions' END;
    SELECT string_agg(quote_ident(attname),',') INTO all_columns FROM pg_attribute
      WHERE attrelid=target::regclass AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON %I FROM PUBLIC,anon,app_user',target);
    EXECUTE format('REVOKE INSERT(%s),UPDATE(%s) ON %I FROM PUBLIC,anon,app_user',all_columns,all_columns,target);
    EXECUTE format('GRANT INSERT(id,%s),UPDATE(%s),DELETE ON %I TO app_user',writable,writable,target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',target||'_editor_insert',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO app_user WITH CHECK (is_editor())',target||'_editor_insert',target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',target||'_editor_update',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO app_user USING (true) WITH CHECK (is_editor())',target||'_editor_update',target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',target||'_editor_delete',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO app_user USING (true)',target||'_editor_delete',target);
    EXECUTE format('DROP TRIGGER IF EXISTS editing_stamp_actor ON %I',target);
    EXECUTE format('CREATE TRIGGER editing_stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION editing_stamp_actor()',target);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION competition_guard_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE occupied boolean:=false;
BEGIN
  IF current_user='app_user' THEN
    IF is_editor() IS NOT TRUE THEN
      RAISE EXCEPTION 'only a signed-in editor removes competition records' USING ERRCODE='42501';
    END IF;
    CASE TG_TABLE_NAME
      WHEN 'championship' THEN occupied:=EXISTS(SELECT 1 FROM phase WHERE championship_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team_player WHERE championship_id=OLD.id);
      WHEN 'phase' THEN occupied:=EXISTS(SELECT 1 FROM stage_group WHERE phase_id=OLD.id)
        OR EXISTS(SELECT 1 FROM game WHERE phase_id=OLD.id);
      WHEN 'stage_group' THEN occupied:=EXISTS(SELECT 1 FROM team_group WHERE group_id=OLD.id)
        OR EXISTS(SELECT 1 FROM zone WHERE group_id=OLD.id);
      ELSE NULL;
    END CASE;
    IF occupied THEN RAISE EXCEPTION '% has dependent archive records',TG_TABLE_NAME USING ERRCODE='23503'; END IF;
  END IF;
  RETURN OLD;
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['championship','phase','stage_group','team_group','zone'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS competition_guard_delete ON %I',target);
    EXECUTE format('CREATE TRIGGER competition_guard_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION competition_guard_delete()',target);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS phase_clone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL DEFAULT auth_uid() REFERENCES app_user(id) ON DELETE CASCADE,
  source_phase_id uuid NOT NULL,
  target_championship_id uuid NOT NULL DEFAULT gen_random_uuid(),
  target_phase_id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  begins date NOT NULL,
  ends date NOT NULL CHECK(ends>=begins),
  created_at timestamptz NOT NULL DEFAULT now(),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('user:'||app_user_id::text) STORED NOT NULL
);
ALTER TABLE phase_clone ALTER COLUMN target_championship_id SET DEFAULT gen_random_uuid();
ALTER TABLE phase_clone ALTER COLUMN target_phase_id SET DEFAULT gen_random_uuid();
CALL rls_protect('phase_clone');
REVOKE ALL ON phase_clone FROM PUBLIC,anon,app_user;
GRANT SELECT ON phase_clone TO app_user,service,electric;
GRANT INSERT(id,source_phase_id,target_championship_id,target_phase_id,name,begins,ends) ON phase_clone TO app_user;
DROP POLICY IF EXISTS phase_clone_app_user_select ON phase_clone;
CREATE POLICY phase_clone_app_user_select ON phase_clone FOR SELECT TO app_user USING(app_user_id=auth_uid());
DROP POLICY IF EXISTS phase_clone_app_user_insert ON phase_clone;
DROP POLICY IF EXISTS phase_clone_app_user_update ON phase_clone;
DROP POLICY IF EXISTS phase_clone_app_user_delete ON phase_clone;
DROP POLICY IF EXISTS phase_clone_editor_insert ON phase_clone;
CREATE POLICY phase_clone_editor_insert ON phase_clone FOR INSERT TO app_user
  WITH CHECK(is_editor() AND app_user_id=auth_uid());
CREATE OR REPLACE FUNCTION competition_clone_phase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source phase; season championship; original stage_group; new_group uuid; actor uuid:=auth_uid();
BEGIN
  IF is_editor() IS NOT TRUE OR NEW.app_user_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'only a signed-in editor clones a phase' USING ERRCODE='42501';
  END IF;
  SELECT * INTO source FROM phase WHERE id=NEW.source_phase_id FOR SHARE;
  IF source.id IS NULL THEN RAISE EXCEPTION 'clone phase was not found' USING ERRCODE='23503'; END IF;
  SELECT * INTO season FROM championship WHERE id=source.championship_id FOR SHARE;
  INSERT INTO championship(id,name,category_id,region,region_name,begins,ends,point_win,point_draw,point_loss,show_country,created_by,updated_by)
    VALUES(NEW.target_championship_id,NEW.name,season.category_id,season.region,season.region_name,NEW.begins,NEW.ends,
      season.point_win,season.point_draw,season.point_loss,season.show_country,actor,actor);
  INSERT INTO phase(id,championship_id,name,position,sort,bonus_points,bonus_points_threshold,created_by,updated_by)
    VALUES(NEW.target_phase_id,NEW.target_championship_id,source.name,1,source.sort,
      source.bonus_points,source.bonus_points_threshold,actor,actor);
  FOR original IN SELECT * FROM stage_group WHERE phase_id=source.id ORDER BY id FOR SHARE LOOP
    new_group:=gen_random_uuid();
    INSERT INTO stage_group(id,phase_id,name,position,created_by,updated_by)
      VALUES(new_group,NEW.target_phase_id,original.name,original.position,actor,actor);
    INSERT INTO zone(group_id,name,color,first,last,positions,created_by,updated_by)
      SELECT new_group,name,color,first,last,positions,actor,actor FROM zone WHERE group_id=original.id;
    INSERT INTO team_group(group_id,team_id,add_sub,bias,comment,created_by,updated_by)
      SELECT new_group,team_id,add_sub,bias,comment,actor,actor FROM team_group WHERE group_id=original.id;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS competition_clone_phase ON phase_clone;
CREATE TRIGGER competition_clone_phase AFTER INSERT ON phase_clone
  FOR EACH ROW EXECUTE FUNCTION competition_clone_phase();

-- An in-flight recount cannot republish a member removed after its read.
ALTER TABLE standing DROP CONSTRAINT IF EXISTS standing_membership_fkey;
ALTER TABLE standing ADD CONSTRAINT standing_membership_fkey
  FOREIGN KEY (group_id,team_id) REFERENCES team_group(group_id,team_id)
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
DELETE FROM standing s WHERE NOT EXISTS (
  SELECT 1 FROM team_group m WHERE m.group_id=s.group_id AND m.team_id=s.team_id);

-- Old scopes lose rows before CDC recounts both sides of a structural edit.
CREATE OR REPLACE FUNCTION competition_invalidate_group(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM standing WHERE group_id=target;
  DELETE FROM team_chance WHERE group_id=target;
  DELETE FROM zone_chance WHERE group_id=target;
  DELETE FROM position_chance WHERE group_id=target;
END $$;
CREATE OR REPLACE FUNCTION competition_invalidate_structure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; phases uuid[]; groups uuid[]; players uuid[];
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'game' THEN
      IF TG_OP='UPDATE' AND (OLD.phase_id,OLD.home_id,OLD.away_id) IS NOT DISTINCT FROM (NEW.phase_id,NEW.home_id,NEW.away_id) THEN RETURN NULL; END IF;
      phases:=array_append(phases,OLD.phase_id);
      IF TG_OP<>'DELETE' THEN phases:=array_append(phases,NEW.phase_id); END IF;
      SELECT array_agg(DISTINCT player_id) INTO players FROM (
        SELECT player_id FROM player_game WHERE game_id=coalesce(NEW.id,OLD.id)
        UNION SELECT player_id FROM goal WHERE game_id=coalesce(NEW.id,OLD.id)) p;
    WHEN 'phase' THEN
      IF TG_OP='UPDATE' AND OLD.championship_id IS NOT DISTINCT FROM NEW.championship_id THEN RETURN NULL; END IF;
      phases:=ARRAY[coalesce(NEW.id,OLD.id)];
      SELECT array_agg(DISTINCT player_id) INTO players FROM (
        SELECT a.player_id FROM player_game a JOIN game g ON g.id=a.game_id WHERE g.phase_id=ANY(phases)
        UNION SELECT a.player_id FROM goal a JOIN game g ON g.id=a.game_id WHERE g.phase_id=ANY(phases)) p;
    WHEN 'stage_group' THEN
      -- Only the group itself: a group's table is its members', and the
      -- recount a group event starts covers that group alone.
      IF TG_OP='UPDATE' AND OLD.phase_id IS NOT DISTINCT FROM NEW.phase_id THEN RETURN NULL; END IF;
      groups:=ARRAY[coalesce(NEW.id,OLD.id)];
    WHEN 'team_group','zone' THEN
      groups:=array_append(groups,OLD.group_id);
      IF TG_OP<>'DELETE' THEN groups:=array_append(groups,NEW.group_id); END IF;
  END CASE;
  FOR target IN SELECT DISTINCT id FROM stage_group WHERE id=ANY(groups) OR phase_id=ANY(phases) LOOP
    PERFORM competition_invalidate_group(target);
  END LOOP;
  IF TG_TABLE_NAME IN ('team_group','zone') THEN
    UPDATE stage_group SET txid=pg_current_xact_id()::text::bigint WHERE id=OLD.group_id;
  END IF;
  IF TG_TABLE_NAME='game' THEN
    UPDATE phase SET txid=pg_current_xact_id()::text::bigint WHERE id=OLD.phase_id;
  END IF;
  IF cardinality(players)>0 THEN
    DELETE FROM player_stat WHERE player_id=ANY(players);
    UPDATE player SET txid=pg_current_xact_id()::text::bigint WHERE id=ANY(players);
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['game','phase','stage_group','team_group','zone'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS competition_invalidate_structure ON %I',target);
    -- Not on INSERT: a new row leaves nothing stale, the absolute recount
    -- upserts it, and clearing would only empty readers' tables meanwhile.
    EXECUTE format('CREATE TRIGGER competition_invalidate_structure AFTER UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION competition_invalidate_structure()',target);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION build_team_odds_series(target_group uuid,target_team uuid,first_position integer,last_position integer,sparse_positions text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH selected AS (
    SELECT p FROM unnest(CASE WHEN sparse_positions<>'' THEN competition_zone_positions(sparse_positions)
      ELSE ARRAY(SELECT generate_series(first_position,last_position)) END) p
  ), daily AS (
    SELECT recorded_on,sum(percent) AS percent FROM team_odds_history
    WHERE group_id=target_group AND team_id=target_team AND position IN (SELECT p FROM selected)
    GROUP BY recorded_on HAVING count(*)=(SELECT count(*) FROM selected)
  ), points AS (
    SELECT jsonb_agg(jsonb_build_object('x',(extract(epoch FROM (recorded_on::timestamp AT TIME ZONE 'UTC'))*1000)::bigint,
      'y',least(100,greatest(0,percent)),'label',to_char(recorded_on,'YYYY-MM-DD')) ORDER BY recorded_on) AS values FROM daily
  ) SELECT jsonb_build_object('kind','line','yMin',0,'yMax',100,'series',jsonb_build_array(jsonb_build_object(
    'label','Position reach','points',sample_team_series(coalesce(values,'[]'::jsonb))))) FROM points
$$;
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
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION competition_stamp_zone(),competition_guard_delete(),competition_clone_phase(),
  competition_invalidate_group(uuid),competition_invalidate_structure() FROM PUBLIC,anon,app_user;
-- tier: container
ALTER TABLE phase_clone REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='electric_publication_default')
    AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default'
      AND schemaname='public' AND tablename='phase_clone') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE phase_clone;
  END IF;
END $$;
-- tier: any
NOTIFY pgrst,'reload schema';
COMMIT;
ALTER TABLE zone VALIDATE CONSTRAINT zone_positions_check;
ALTER TABLE standing VALIDATE CONSTRAINT standing_membership_fkey;
