SET lock_timeout='5s';
SET statement_timeout='60s';
BEGIN;

CREATE TABLE IF NOT EXISTS user_biography (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL DEFAULT auth_uid() UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
  display_name text CHECK (char_length(display_name)<=100),
  location text CHECK (char_length(location)<=100),
  about_me text CHECK (char_length(about_me)<=2000),
  updated_at portable_timestamp NOT NULL DEFAULT now(),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('user_biography');

CREATE OR REPLACE FUNCTION community_stamp_biography() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user IN ('app_user','anon') AND
    (NEW.app_user_id IS DISTINCT FROM auth_uid() OR
      coalesce(current_setting('request.jwt.claims',true)::json->>'guest','')<>'false') THEN
    RAISE EXCEPTION 'only a signed-in author edits their biography' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.app_user_id) IS DISTINCT FROM (OLD.id,OLD.app_user_id) THEN
    RAISE EXCEPTION 'biography ownership is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' OR current_user IN ('app_user','anon') THEN
    NEW.updated_at:=now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS community_biography_stamp ON user_biography;
CREATE TRIGGER community_biography_stamp BEFORE INSERT OR UPDATE ON user_biography
  FOR EACH ROW EXECUTE FUNCTION community_stamp_biography();

CREATE TABLE IF NOT EXISTS game_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  actor_id uuid,
  actor_handle text,
  game_slug text,
  game_day date,
  home_name text NOT NULL,
  away_name text NOT NULL,
  championship_name text NOT NULL,
  changes_json text NOT NULL CHECK (jsonb_typeof(changes_json::jsonb)='object' AND changes_json::jsonb<>'{}'::jsonb),
  created_at portable_timestamp NOT NULL DEFAULT now(),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('game_change');

-- Snapshots outlive the game and account; foreign-key cascades would rewrite history.
CREATE UNIQUE INDEX IF NOT EXISTS game_change_game_version_idx ON game_change(game_id,version);
CREATE INDEX IF NOT EXISTS game_change_actor_recent_idx ON game_change(actor_id,created_at DESC,id);
-- Atomic pgroll completion cannot build concurrently; lock timeout bounds waits.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS comment_author_read_idx ON comment(app_user_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_comment_author_read_idx ON team_comment(app_user_id);

CREATE SCHEMA IF NOT EXISTS golaberto_history;
REVOKE ALL ON SCHEMA golaberto_history FROM PUBLIC,anon,app_user,electric;
CREATE TABLE IF NOT EXISTS golaberto_history.version_floor (
  game_id uuid PRIMARY KEY,
  version integer NOT NULL CHECK(version>0)
);
REVOKE ALL ON golaberto_history.version_floor FROM PUBLIC,anon,app_user,electric,service;

-- A change is shown as readers saw it when it was made: references resolve to
-- their names and dates print as the archive prints them, so a later rename
-- cannot rewrite history and a byline never reads as a raw identifier.
CREATE OR REPLACE FUNCTION community_change_value(field text,value jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(value) IS DISTINCT FROM 'string' THEN value
    WHEN field='phase_id' THEN to_jsonb((SELECT name FROM phase WHERE id=(value#>>'{}')::uuid))
    WHEN field IN ('home_id','away_id') THEN to_jsonb((SELECT name FROM team WHERE id=(value#>>'{}')::uuid))
    WHEN field='stadium_id' THEN to_jsonb((SELECT name FROM stadium WHERE id=(value#>>'{}')::uuid))
    WHEN field='referee_id' THEN to_jsonb((SELECT name FROM referee WHERE id=(value#>>'{}')::uuid))
    WHEN field='day' THEN to_jsonb(to_char((value#>>'{}')::date,'DD/MM/YYYY'))
    WHEN field='kickoff' THEN to_jsonb(to_char((value#>>'{}')::timestamptz AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
    ELSE value END $$;
CREATE OR REPLACE FUNCTION community_change_display(changes jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(f.key,jsonb_build_object(
    'before',coalesce(community_change_value(f.key,f.value->'before'),'null'::jsonb),
    'after',coalesce(community_change_value(f.key,f.value->'after'),'null'::jsonb))),'{}'::jsonb)
  FROM jsonb_each(changes) f $$;

CREATE OR REPLACE FUNCTION community_game_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  before_row jsonb:=to_jsonb(OLD);
  after_row jsonb:=to_jsonb(NEW);
  changes jsonb:='{}'::jsonb;
  field text;
  actor uuid;
  byline text;
BEGIN
  FOREACH field IN ARRAY ARRAY['phase_id','round','day','kickoff','home_id','away_id','home_field',
    'played','home_score','away_score','home_aet','away_aet','home_pen','away_pen','stadium_id','referee_id','attendance'] LOOP
    IF before_row->field IS DISTINCT FROM after_row->field THEN
      changes:=changes||jsonb_build_object(field,jsonb_build_object('before',before_row->field,'after',after_row->field));
    END IF;
  END LOOP;
  IF changes='{}'::jsonb THEN RETURN NULL; END IF;
  IF current_setting('role')='app_user' THEN
    IF is_editor() IS NOT TRUE THEN
      RAISE EXCEPTION 'only a signed-in editor records a game correction' USING ERRCODE='42501';
    END IF;
    actor:=auth_uid();
    SELECT handle INTO byline FROM app_user WHERE id=actor;
    IF byline IS NULL THEN RAISE EXCEPTION 'game correction actor is absent' USING ERRCODE='42501'; END IF;
  END IF;
  INSERT INTO game_change(game_id,version,actor_id,actor_handle,game_slug,game_day,
    home_name,away_name,championship_name,changes_json)
  SELECT NEW.id,greatest(coalesce((SELECT max(version) FROM game_change WHERE game_id=NEW.id),0),
    coalesce((SELECT version FROM golaberto_history.version_floor WHERE game_id=NEW.id),0))+1,
    actor,byline,NEW.slug,NEW.day,h.name,a.name,c.full_name,community_change_display(changes)::text
  FROM team h,team a,phase p JOIN championship c ON c.id=p.championship_id
  WHERE h.id=NEW.home_id AND a.id=NEW.away_id AND p.id=NEW.phase_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'game correction context is absent'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS community_game_change ON game;
CREATE TRIGGER community_game_change AFTER UPDATE ON game FOR EACH ROW EXECUTE FUNCTION community_game_change();

CREATE OR REPLACE FUNCTION community_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'game change history is append-only' USING ERRCODE='42501';
END $$;
DROP TRIGGER IF EXISTS community_history_immutable ON game_change;
CREATE TRIGGER community_history_immutable BEFORE UPDATE OR DELETE ON game_change
  FOR EACH ROW EXECUTE FUNCTION community_history_immutable();

-- DELETE has no WITH CHECK; an explicit refusal keeps the author's UI from acknowledging a no-op.
CREATE OR REPLACE FUNCTION community_comment_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user IN ('app_user','anon') AND
    (OLD.app_user_id IS DISTINCT FROM auth_uid() OR
      coalesce(current_setting('request.jwt.claims',true)::json->>'guest','')<>'false') THEN
    RAISE EXCEPTION 'only a signed-in author removes their comment' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $$;
DO $$ DECLARE target text; policy record; columns text; BEGIN
  FOREACH target IN ARRAY ARRAY['user_biography','game_change'] LOOP
    FOR policy IN SELECT polname FROM pg_policy WHERE polrelid=target::regclass AND polname<>'tenancy' LOOP
      EXECUTE format('DROP POLICY %I ON %I',policy.polname,target);
    END LOOP;
    SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_attribute
      WHERE attrelid=target::regclass AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,app_user,service,electric',target);
    EXECUTE format('REVOKE INSERT(%s),UPDATE(%s) ON %I FROM PUBLIC,anon,app_user,service,electric',columns,columns,target);
    EXECUTE format('GRANT SELECT ON %I TO app_user,service',target);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_user USING (true)',target||'_public_read',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['comment','team_comment'] LOOP
    FOR policy IN SELECT polname FROM pg_policy WHERE polrelid=target::regclass AND polcmd='d' LOOP
      EXECUTE format('DROP POLICY %I ON %I',policy.polname,target);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO app_user USING (true)',target||'_author_delete',target);
    EXECUTE format('DROP TRIGGER IF EXISTS community_comment_delete ON %I',target);
    EXECUTE format('CREATE TRIGGER community_comment_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION community_comment_delete()',target);
    EXECUTE format('REVOKE DELETE ON %I FROM PUBLIC,anon',target);
    EXECUTE format('GRANT DELETE ON %I TO app_user',target);
  END LOOP;
END $$;

GRANT INSERT(id,app_user_id,display_name,location,about_me),UPDATE(display_name,location,about_me) ON user_biography TO app_user;
GRANT INSERT,UPDATE,DELETE ON user_biography TO service;
CREATE POLICY user_biography_author_insert ON user_biography FOR INSERT TO app_user
  WITH CHECK (app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false');
CREATE POLICY user_biography_author_update ON user_biography FOR UPDATE TO app_user USING (true)
  WITH CHECK (app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false');

DO $$ DECLARE alias record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.user_directory') AND relkind='r') THEN
    IF EXISTS (SELECT 1 FROM user_directory) THEN RAISE EXCEPTION 'user_directory placeholder contains rows'; END IF;
    IF to_regclass('pgroll.migrations') IS NOT NULL THEN
      FOR alias IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
        WHERE m.schema='public' AND c.relname='user_directory' AND c.relkind='v'
      LOOP EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname); END LOOP;
    END IF;
    DROP TABLE user_directory;
  END IF;
END $$;
CREATE OR REPLACE VIEW user_directory WITH (security_invoker=true) AS
SELECT u.id,u.handle,coalesce(nullif(trim(p.display_name),''),u.handle) AS display_name,
  p.location,p.about_me,u.created_at AS joined_at,p.id AS biography_id,
  (SELECT count(*) FROM comment c WHERE c.app_user_id=u.id)+
    (SELECT count(*) FROM team_comment c WHERE c.app_user_id=u.id) AS comment_count,
  (SELECT count(*) FROM game_change c WHERE c.actor_id=u.id) AS edit_count,
  (SELECT max(c.created_at) FROM game_change c WHERE c.actor_id=u.id) AS last_edit_at,
  replace(replace(replace(coalesce(p.display_name,'')||' '||u.handle||' '||coalesce(p.location,''),
    'ı','i'),'þ','th'),'Þ','th') COLLATE golaberto_search AS search_key,
  NULL::bigint AS txid,'public:'::text AS scope_id,NULL::uuid AS avatar_id,
  to_char(u.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS joined_on,NULL::text AS avatar_key
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id;
REVOKE ALL ON user_directory FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON user_directory TO app_user,service;
REVOKE ALL ON FUNCTION community_stamp_biography(),community_game_change(),community_history_immutable(),community_comment_delete(),
  community_change_value(text,jsonb),community_change_display(jsonb)
  FROM PUBLIC,anon,app_user,service,electric;

NOTIFY pgrst,'reload schema';
COMMIT;
SET lock_timeout='5s';
SET statement_timeout='60s';
BEGIN;
DO $$ DECLARE alias record; BEGIN
  IF EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.community_access') AND relkind='r') THEN
    IF EXISTS(SELECT 1 FROM community_access) THEN RAISE EXCEPTION 'community_access placeholder contains rows'; END IF;
    IF to_regclass('pgroll.migrations') IS NOT NULL THEN
      FOR alias IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
        WHERE m.schema='public' AND c.relname='community_access' AND c.relkind='v'
      LOOP EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname); END LOOP;
    END IF;
    DROP TABLE community_access;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS game_change_slug_recent_idx ON game_change(game_slug,created_at DESC,id);
CREATE OR REPLACE VIEW community_access WITH (security_invoker=true) AS
SELECT 'profile:'||u.id::text AS id,u.id AS record_id,'profile'::text AS kind,p.id AS biography_id,
  NULL::bigint AS txid,'public:'::text AS scope_id,NULL::uuid AS avatar_id
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id
WHERE u.id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false'
UNION ALL
SELECT 'comment:'||c.id::text,c.id,'comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM comment c WHERE c.app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false'
UNION ALL
SELECT 'team_comment:'||c.id::text,c.id,'team_comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM team_comment c WHERE c.app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false';
REVOKE ALL ON community_access FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON community_access TO anon,app_user,service;
CREATE OR REPLACE FUNCTION user_biography(user_directory) RETURNS SETOF user_biography
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
 SELECT p.* FROM user_biography p WHERE p.app_user_id=$1.id
$$;
CREATE OR REPLACE FUNCTION user_biography(community_access) RETURNS SETOF user_biography
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
 SELECT p.* FROM user_biography p WHERE p.id=$1.biography_id AND $1.kind='profile'
$$;
REVOKE ALL ON FUNCTION user_biography(user_directory),user_biography(community_access) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_biography(user_directory),user_biography(community_access) TO anon,app_user,service;
NOTIFY pgrst,'reload schema';
COMMIT;
