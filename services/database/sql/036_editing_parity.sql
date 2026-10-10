SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

DO $$ DECLARE target text; field text; BEGIN
  FOREACH target IN ARRAY ARRAY['player','team','stadium','referee','game','goal','player_game','team_player'] LOOP
    FOREACH field IN ARRAY ARRAY['created_by','updated_by'] LOOP
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I uuid',target,field);
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=target::regclass
          AND conname=target||'_'||field||'_fkey' AND confdeltype<>'n') THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target,target||'_'||field||'_fkey');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=target::regclass
          AND conname=target||'_'||field||'_fkey') THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES app_user(id) ON DELETE SET NULL',
          target,target||'_'||field||'_fkey',field);
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION editing_stamp_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user='app_user' THEN
    IF is_editor() IS NOT TRUE THEN
      RAISE EXCEPTION 'only a signed-in editor edits archive records' USING ERRCODE='42501';
    END IF;
    IF TG_OP='INSERT' THEN NEW.created_by:=auth_uid(); ELSE NEW.created_by:=OLD.created_by; END IF;
    NEW.updated_by:=auth_uid();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION editing_guard_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE occupied boolean:=false;
BEGIN
  IF current_user='app_user' THEN
    IF is_editor() IS NOT TRUE THEN
      RAISE EXCEPTION 'only a signed-in editor removes archive records' USING ERRCODE='42501';
    END IF;
    CASE TG_TABLE_NAME
      WHEN 'player' THEN occupied:=EXISTS(SELECT 1 FROM goal WHERE player_id=OLD.id)
        OR EXISTS(SELECT 1 FROM player_game WHERE player_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team_player WHERE player_id=OLD.id);
      WHEN 'team' THEN occupied:=EXISTS(SELECT 1 FROM game WHERE home_id=OLD.id OR away_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team_player WHERE team_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team_group WHERE team_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team_comment WHERE team_id=OLD.id);
      WHEN 'stadium' THEN occupied:=EXISTS(SELECT 1 FROM game WHERE stadium_id=OLD.id)
        OR EXISTS(SELECT 1 FROM team WHERE stadium_id=OLD.id);
      WHEN 'referee' THEN occupied:=EXISTS(SELECT 1 FROM game WHERE referee_id=OLD.id);
      WHEN 'game' THEN occupied:=EXISTS(SELECT 1 FROM goal WHERE game_id=OLD.id)
        OR EXISTS(SELECT 1 FROM player_game WHERE game_id=OLD.id)
        OR EXISTS(SELECT 1 FROM comment WHERE game_id=OLD.id);
      ELSE NULL;
    END CASE;
    IF occupied THEN RAISE EXCEPTION '% has dependent archive records',TG_TABLE_NAME USING ERRCODE='23503'; END IF;
  END IF;
  RETURN OLD;
END $$;

-- A registration's removal owns only its team and championship history.
CREATE OR REPLACE FUNCTION editing_remove_registration_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF is_editor() IS NOT TRUE AND current_setting('role')='app_user' THEN
    RAISE EXCEPTION 'only a signed-in editor removes registrations' USING ERRCODE='42501';
  END IF;
  DELETE FROM goal g USING game m,phase p WHERE g.player_id=OLD.player_id
    AND m.id=g.game_id AND p.id=m.phase_id AND p.championship_id=OLD.championship_id
    AND CASE WHEN (g.side='home')<>g.own_goal THEN m.home_id ELSE m.away_id END=OLD.team_id;
  DELETE FROM player_game a USING game m,phase p WHERE a.player_id=OLD.player_id
    AND m.id=a.game_id AND p.id=m.phase_id AND p.championship_id=OLD.championship_id
    AND CASE WHEN a.side='home' THEN m.home_id ELSE m.away_id END=OLD.team_id;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS editing_registration_delete ON team_player;
CREATE TRIGGER editing_registration_delete BEFORE DELETE ON team_player
  FOR EACH ROW EXECUTE FUNCTION editing_remove_registration_history();
DROP TRIGGER IF EXISTS editing_registration_update ON team_player;
CREATE TRIGGER editing_registration_update BEFORE UPDATE OF player_id,team_id,championship_id ON team_player
  FOR EACH ROW WHEN (OLD.player_id IS DISTINCT FROM NEW.player_id OR OLD.team_id IS DISTINCT FROM NEW.team_id
    OR OLD.championship_id IS DISTINCT FROM NEW.championship_id)
  EXECUTE FUNCTION editing_remove_registration_history();

DO $$ DECLARE target text; writable text; all_columns text; BEGIN
  FOREACH target IN ARRAY ARRAY['player','team','stadium','referee','game','goal','player_game','team_player'] LOOP
    writable:=CASE target
      WHEN 'player' THEN 'name,full_name,birth,country,height,position'
      WHEN 'team' THEN 'name,full_name,city,country,foundation,stadium_id,team_type'
      WHEN 'stadium' THEN 'name,full_name,city,country'
      WHEN 'referee' THEN 'name,location'
      WHEN 'game' THEN 'phase_id,round,day,kickoff,home_id,away_id,home_field,played,home_score,away_score,home_aet,away_aet,home_pen,away_pen,stadium_id,referee_id,attendance'
      WHEN 'goal' THEN 'game_id,player_id,side,minute,penalty,own_goal,aet'
      WHEN 'player_game' THEN 'game_id,player_id,side,on_minute,off_minute,yellow,red,bench,day'
      WHEN 'team_player' THEN 'championship_id,team_id,player_id' END;
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
    EXECUTE format('DROP TRIGGER IF EXISTS editing_guard_delete ON %I',target);
    EXECUTE format('CREATE TRIGGER editing_guard_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION editing_guard_delete()',target);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS player_merge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL DEFAULT auth_uid() REFERENCES app_user(id) ON DELETE CASCADE,
  target_player_id uuid NOT NULL,
  source_player_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('user:'||app_user_id::text) STORED NOT NULL,
  CHECK (target_player_id<>source_player_id)
);
CALL rls_protect('player_merge');
REVOKE ALL ON player_merge FROM PUBLIC,anon,app_user;
GRANT SELECT ON player_merge TO app_user,service,electric;
GRANT INSERT(id,target_player_id,source_player_id) ON player_merge TO app_user;
DROP POLICY IF EXISTS player_merge_app_user_select ON player_merge;
CREATE POLICY player_merge_app_user_select ON player_merge FOR SELECT TO app_user USING (app_user_id=auth_uid());
DROP POLICY IF EXISTS player_merge_editor_insert ON player_merge;
CREATE POLICY player_merge_editor_insert ON player_merge FOR INSERT TO app_user
  WITH CHECK (is_editor() AND app_user_id=auth_uid());
DROP POLICY IF EXISTS player_merge_app_user_insert ON player_merge;
DROP POLICY IF EXISTS player_merge_app_user_update ON player_merge;
DROP POLICY IF EXISTS player_merge_app_user_delete ON player_merge;

CREATE OR REPLACE FUNCTION editing_merge_player() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target player; source player; actor uuid:=auth_uid();
BEGIN
  IF is_editor() IS NOT TRUE OR NEW.app_user_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'only a signed-in editor merges players' USING ERRCODE='42501';
  END IF;
  IF NEW.target_player_id=NEW.source_player_id THEN
    RAISE EXCEPTION 'merge needs two distinct players' USING ERRCODE='23514';
  END IF;
  -- Consistent row locking makes opposite-direction requests serialize.
  PERFORM id FROM player WHERE id IN (NEW.target_player_id,NEW.source_player_id) ORDER BY id FOR UPDATE;
  SELECT * INTO target FROM player WHERE id=NEW.target_player_id;
  SELECT * INTO source FROM player WHERE id=NEW.source_player_id;
  IF target.id IS NULL OR source.id IS NULL THEN
    RAISE EXCEPTION 'merge player was not found' USING ERRCODE='23503';
  END IF;
  IF EXISTS (SELECT 1 FROM player_game a JOIN player_game b ON b.game_id=a.game_id
      WHERE a.player_id=source.id AND b.player_id=target.id) THEN
    RAISE EXCEPTION 'merge players overlap in a game squad' USING ERRCODE='23505';
  END IF;
  UPDATE goal SET player_id=target.id,updated_by=actor WHERE player_id=source.id;
  UPDATE player_game SET player_id=target.id,updated_by=actor WHERE player_id=source.id;
  DELETE FROM team_player a USING team_player b WHERE a.player_id=source.id AND b.player_id=target.id
    AND a.team_id=b.team_id AND a.championship_id=b.championship_id;
  UPDATE team_player SET player_id=target.id,updated_by=actor WHERE player_id=source.id;
  UPDATE player SET full_name=coalesce(nullif(target.full_name,''),source.full_name),
    birth=coalesce(target.birth,source.birth),country=coalesce(nullif(target.country,''),source.country),
    height=coalesce(target.height,source.height),position=coalesce(nullif(target.position,''),source.position),
    updated_by=actor WHERE id=target.id;
  DELETE FROM player WHERE id=source.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS editing_merge_player ON player_merge;
-- POST retries use ON CONFLICT DO NOTHING; only an inserted command executes.
CREATE TRIGGER editing_merge_player AFTER INSERT ON player_merge
  FOR EACH ROW EXECUTE FUNCTION editing_merge_player();
REVOKE ALL ON FUNCTION editing_stamp_actor(),editing_guard_delete(),editing_remove_registration_history(),editing_merge_player()
  FROM PUBLIC,anon,app_user;

-- tier: container
ALTER TABLE player_merge REPLICA IDENTITY FULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='electric_publication_default')
      AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default'
        AND schemaname='public' AND tablename='player_merge') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE player_merge;
  END IF;
END $$;
-- tier: any

NOTIFY pgrst,'reload schema';
COMMIT;
