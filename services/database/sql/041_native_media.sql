BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE SCHEMA IF NOT EXISTS golaberto_upload;
REVOKE ALL ON SCHEMA golaberto_upload FROM PUBLIC, anon, app_user, electric;
GRANT USAGE ON SCHEMA golaberto_upload TO service;
CREATE TABLE IF NOT EXISTS golaberto_upload.object (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,12}$'),
  owner_id uuid REFERENCES public.app_user(id) ON DELETE SET NULL,
  etag text NOT NULL CHECK (etag ~ '^[0-9a-f]{64}$'),
  medium bytea NOT NULL CHECK (octet_length(medium) BETWEEN 1 AND 65536),
  thumb bytea NOT NULL CHECK (octet_length(thumb) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attached_kind text CHECK (attached_kind IN ('avatar','logo')),
  attached_subject uuid,
  CHECK ((attached_kind IS NULL) = (attached_subject IS NULL)),
  CHECK (attached_kind IS NOT NULL OR owner_id IS NOT NULL),
  UNIQUE (attached_kind, attached_subject) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS upload_pending_owner ON golaberto_upload.object(owner_id,created_at) WHERE attached_kind IS NULL;
REVOKE ALL ON golaberto_upload.object FROM PUBLIC, anon, app_user, electric;
GRANT SELECT, INSERT, UPDATE, DELETE ON golaberto_upload.object TO service;
CREATE TABLE IF NOT EXISTS golaberto_upload.key_registry (
  key text PRIMARY KEY,
  published boolean NOT NULL DEFAULT false
);
INSERT INTO golaberto_upload.key_registry(key,published)
  SELECT key,attached_kind IS NOT NULL FROM golaberto_upload.object ON CONFLICT(key) DO NOTHING;
REVOKE ALL ON golaberto_upload.key_registry FROM PUBLIC,anon,app_user,electric,service;
GRANT INSERT(key) ON golaberto_upload.key_registry TO service;
CREATE OR REPLACE FUNCTION golaberto_upload.reserve_public_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM golaberto_upload.key_registry WHERE key=OLD.key AND NOT published;
  ELSIF OLD.attached_kind IS NULL AND NEW.attached_kind IS NOT NULL THEN
    UPDATE golaberto_upload.key_registry SET published=true WHERE key=NEW.key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload key reservation is absent'; END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS upload_public_key ON golaberto_upload.object;
CREATE TRIGGER upload_public_key AFTER UPDATE OR DELETE ON golaberto_upload.object
  FOR EACH ROW EXECUTE FUNCTION golaberto_upload.reserve_public_key();
CREATE OR REPLACE FUNCTION golaberto_upload.stage(actor uuid, object_key text, digest text, medium_bytes bytea, thumb_bytes bytea) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  existing golaberto_upload.object%ROWTYPE;
  pending_limit CONSTANT integer := 4;
  pending_ttl CONSTANT interval := interval '24 hours';
BEGIN
  PERFORM 1 FROM public.app_user WHERE id=actor FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || actor,0));
  DELETE FROM golaberto_upload.object WHERE owner_id=actor AND attached_kind IS NULL AND created_at < clock_timestamp()-pending_ttl;
  SELECT * INTO existing FROM golaberto_upload.object WHERE key=object_key FOR UPDATE;
  IF FOUND THEN
    IF existing.owner_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Upload owner required' USING ERRCODE='42501'; END IF;
    IF existing.etag IS DISTINCT FROM digest THEN RAISE EXCEPTION 'Upload key is immutable' USING ERRCODE='23505'; END IF;
    RETURN;
  END IF;
  INSERT INTO golaberto_upload.key_registry(key) VALUES(object_key);
  IF (SELECT count(*) FROM golaberto_upload.object WHERE owner_id=actor AND attached_kind IS NULL) >= pending_limit THEN
    RAISE EXCEPTION 'Pending upload limit reached' USING ERRCODE='54000';
  END IF;
  INSERT INTO golaberto_upload.object(key,owner_id,etag,medium,thumb) VALUES(object_key,actor,digest,medium_bytes,thumb_bytes);
  INSERT INTO public.user_pending_upload(id,app_user_id,created_at,expires_at)
    SELECT key,owner_id,created_at,created_at+pending_ttl FROM golaberto_upload.object WHERE key=object_key;
END $$;
CREATE TABLE IF NOT EXISTS public.user_avatar (
  id uuid PRIMARY KEY DEFAULT public.auth_uid() REFERENCES public.app_user(id) ON DELETE CASCADE,
  avatar_key text REFERENCES golaberto_upload.object(key),
  scope_id text GENERATED ALWAYS AS ('public:'::text) STORED,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint
);
ALTER TABLE public.team ADD COLUMN IF NOT EXISTS logo_key text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.team'::regclass AND conname='team_logo_key_fkey'
  ) THEN
    ALTER TABLE public.team ADD CONSTRAINT team_logo_key_fkey
      FOREIGN KEY (logo_key) REFERENCES golaberto_upload.object(key) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.team VALIDATE CONSTRAINT team_logo_key_fkey;
ALTER TABLE public.user_avatar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_avatar FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_avatar FROM PUBLIC,anon,app_user,electric;
GRANT SELECT ON public.user_avatar TO anon,app_user,service;
GRANT INSERT(id,avatar_key), UPDATE(avatar_key), DELETE ON public.user_avatar TO app_user;
GRANT SELECT(logo_key),INSERT(logo_key),UPDATE(logo_key) ON public.team TO app_user;
GRANT SELECT(logo_key) ON public.team TO anon;
DROP POLICY IF EXISTS avatar_public_read ON public.user_avatar;
CREATE POLICY avatar_public_read ON public.user_avatar FOR SELECT TO anon,app_user USING(true);
DROP POLICY IF EXISTS avatar_owner_insert ON public.user_avatar;
CREATE POLICY avatar_owner_insert ON public.user_avatar FOR INSERT TO app_user WITH CHECK(id=public.auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false');
DROP POLICY IF EXISTS avatar_owner_update ON public.user_avatar;
CREATE POLICY avatar_owner_update ON public.user_avatar FOR UPDATE TO app_user USING(true) WITH CHECK(id=public.auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false');
DROP POLICY IF EXISTS avatar_delete ON public.user_avatar;
CREATE POLICY avatar_delete ON public.user_avatar FOR DELETE TO app_user USING(true);
CREATE OR REPLACE FUNCTION golaberto_upload.attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  actor uuid := NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::json->>'sub','')::uuid;
  media_kind text := CASE TG_TABLE_NAME WHEN 'user_avatar' THEN 'avatar' ELSE 'logo' END;
  subject uuid := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  prior_key text;
  next_key text;
  stored golaberto_upload.object%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN prior_key := to_jsonb(OLD)->>CASE media_kind WHEN 'avatar' THEN 'avatar_key' ELSE 'logo_key' END; END IF;
  IF TG_OP<>'DELETE' THEN next_key := to_jsonb(NEW)->>CASE media_kind WHEN 'avatar' THEN 'avatar_key' ELSE 'logo_key' END; END IF;
  IF TG_WHEN='AFTER' THEN
    IF prior_key IS DISTINCT FROM next_key AND prior_key IS NOT NULL THEN
      DELETE FROM golaberto_upload.object WHERE key=prior_key AND attached_kind=media_kind AND attached_subject=subject;
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP='DELETE' AND current_setting('role',true)<>'app_user' THEN RETURN OLD; END IF;
  IF TG_OP<>'DELETE' AND next_key IS NULL AND prior_key IS NULL AND TG_TABLE_NAME='team' THEN RETURN NEW; END IF;
  IF NULLIF(current_setting('request.jwt.claims',true),'')::json->>'guest' IS DISTINCT FROM 'false' OR actor IS NULL THEN
    RAISE EXCEPTION 'Signed-in account required' USING ERRCODE='42501';
  END IF;
  IF (media_kind='avatar' AND actor<>subject) OR (media_kind='logo' AND NOT public.is_editor()) THEN
    RAISE EXCEPTION 'Attachment permission denied' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF next_key IS NOT DISTINCT FROM prior_key THEN RETURN NEW; END IF;
  IF next_key IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || actor,0));
  SELECT * INTO stored FROM golaberto_upload.object WHERE key=next_key FOR UPDATE;
  IF NOT FOUND OR stored.owner_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'Owned upload required' USING ERRCODE='42501';
  END IF;
  IF stored.attached_kind IS NOT NULL THEN RAISE EXCEPTION 'Upload is already attached' USING ERRCODE='23514'; END IF;
  IF stored.created_at < clock_timestamp()-interval '24 hours' THEN RAISE EXCEPTION 'Upload expired' USING ERRCODE='23514'; END IF;
  UPDATE golaberto_upload.object SET attached_kind=media_kind,attached_subject=subject WHERE key=next_key;
  DELETE FROM public.user_pending_upload WHERE id=next_key;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS avatar_bind_before ON public.user_avatar;
CREATE TRIGGER avatar_bind_before BEFORE INSERT OR UPDATE OR DELETE ON public.user_avatar FOR EACH ROW EXECUTE FUNCTION golaberto_upload.attachment();
DROP TRIGGER IF EXISTS avatar_cleanup_after ON public.user_avatar;
CREATE TRIGGER avatar_cleanup_after AFTER UPDATE OR DELETE ON public.user_avatar FOR EACH ROW EXECUTE FUNCTION golaberto_upload.attachment();
DROP TRIGGER IF EXISTS logo_bind_before ON public.team;
CREATE TRIGGER logo_bind_before BEFORE INSERT OR UPDATE OF logo_key OR DELETE ON public.team FOR EACH ROW EXECUTE FUNCTION golaberto_upload.attachment();
DROP TRIGGER IF EXISTS logo_cleanup_after ON public.team;
CREATE TRIGGER logo_cleanup_after AFTER UPDATE OF logo_key OR DELETE ON public.team FOR EACH ROW EXECUTE FUNCTION golaberto_upload.attachment();
CREATE OR REPLACE FUNCTION golaberto_upload.account_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || OLD.id,0));
  DELETE FROM golaberto_upload.object WHERE owner_id=OLD.id AND attached_kind IS NULL;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS media_account_cleanup ON public.app_user;
CREATE TRIGGER media_account_cleanup BEFORE DELETE ON public.app_user FOR EACH ROW EXECUTE FUNCTION golaberto_upload.account_cleanup();

CREATE TABLE IF NOT EXISTS public.user_pending_upload (
  id text PRIMARY KEY REFERENCES golaberto_upload.object(key) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  scope_id text GENERATED ALWAYS AS ('user:'::text || app_user_id) STORED,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint
);
DO $$
DECLARE wanted record; existing record; source_column smallint;
BEGIN
  FOR wanted IN SELECT * FROM (VALUES
    ('public.user_avatar','id','public.app_user','id','c','CASCADE','user_avatar_owner_fk'),
    ('public.user_avatar','avatar_key','golaberto_upload.object','key','a','NO ACTION','user_avatar_image_fk'),
    ('public.team','logo_key','golaberto_upload.object','key','a','NO ACTION','team_logo_image_fk'),
    ('public.user_pending_upload','id','golaberto_upload.object','key','c','CASCADE','pending_image_fk'),
    ('public.user_pending_upload','app_user_id','public.app_user','id','c','CASCADE','pending_owner_fk')
  ) AS f(source_table,source_field,target_table,target_field,delete_code,delete_action,constraint_name)
  LOOP
    SELECT attnum INTO STRICT source_column FROM pg_attribute WHERE attrelid=wanted.source_table::regclass AND attname=wanted.source_field;
    SELECT conname,confdeltype INTO existing FROM pg_constraint
      WHERE conrelid=wanted.source_table::regclass AND confrelid=wanted.target_table::regclass
      AND contype='f' AND conkey=ARRAY[source_column];
    IF FOUND AND existing.confdeltype::text=wanted.delete_code THEN CONTINUE; END IF;
    IF FOUND THEN EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',wanted.source_table,existing.conname); END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(%I) ON DELETE %s',
      wanted.source_table,wanted.constraint_name,wanted.source_field,wanted.target_table,wanted.target_field,wanted.delete_action);
  END LOOP;
END $$;
ALTER TABLE public.user_pending_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_pending_upload FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_pending_upload FROM PUBLIC,anon,app_user,electric;
GRANT SELECT,DELETE ON public.user_pending_upload TO app_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_pending_upload TO service;
DROP POLICY IF EXISTS pending_owner_read ON public.user_pending_upload;
CREATE POLICY pending_owner_read ON public.user_pending_upload FOR SELECT TO app_user USING(app_user_id=public.auth_uid());
DROP POLICY IF EXISTS pending_owner_delete ON public.user_pending_upload;
CREATE POLICY pending_owner_delete ON public.user_pending_upload FOR DELETE TO app_user USING(app_user_id=public.auth_uid());
DROP POLICY IF EXISTS pending_account_guard ON public.user_pending_upload;
CREATE POLICY pending_account_guard ON public.user_pending_upload AS RESTRICTIVE FOR ALL TO app_user
  USING(app_user_id=public.auth_uid() AND NULLIF(current_setting('request.jwt.claims',true),'')::json->>'guest'='false')
  WITH CHECK(app_user_id=public.auth_uid() AND NULLIF(current_setting('request.jwt.claims',true),'')::json->>'guest'='false');
CREATE OR REPLACE FUNCTION golaberto_upload.pending_delete_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid := NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::json->>'sub','')::uuid;
BEGIN
  IF current_setting('role',true)='app_user' THEN
    IF actor IS NULL OR NULLIF(current_setting('request.jwt.claims',true),'')::json->>'guest' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'Signed-in account required' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || actor,0));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS upload_cancel_lock ON public.user_pending_upload;
CREATE TRIGGER upload_cancel_lock BEFORE DELETE ON public.user_pending_upload FOR EACH STATEMENT EXECUTE FUNCTION golaberto_upload.pending_delete_lock();
CREATE OR REPLACE FUNCTION golaberto_upload.cancel_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid := NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::json->>'sub','')::uuid;
BEGIN
  IF current_setting('role',true)='app_user' THEN
    IF actor IS DISTINCT FROM OLD.app_user_id OR NULLIF(current_setting('request.jwt.claims',true),'')::json->>'guest' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'Pending upload owner required' USING ERRCODE='42501';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || OLD.app_user_id,0));
  DELETE FROM golaberto_upload.object WHERE key=OLD.id AND owner_id=OLD.app_user_id AND attached_kind IS NULL;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS upload_cancel ON public.user_pending_upload;
CREATE TRIGGER upload_cancel AFTER DELETE ON public.user_pending_upload FOR EACH ROW EXECUTE FUNCTION golaberto_upload.cancel_pending();

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA golaberto_upload FROM PUBLIC,anon,app_user,electric;
GRANT EXECUTE ON FUNCTION golaberto_upload.stage(uuid,text,text,bytea,bytea) TO service;
CREATE OR REPLACE VIEW community_access WITH (security_invoker=true) AS
SELECT 'profile:'||u.id::text AS id,u.id AS record_id,'profile'::text AS kind,p.id AS biography_id,
 NULL::bigint AS txid,'public:'::text AS scope_id,a.id AS avatar_id
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id LEFT JOIN user_avatar a ON a.id=u.id
WHERE u.id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false'
UNION ALL SELECT 'comment:'||c.id::text,c.id,'comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM comment c WHERE c.app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false'
UNION ALL SELECT 'team_comment:'||c.id::text,c.id,'team_comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM team_comment c WHERE c.app_user_id=auth_uid() AND current_setting('request.jwt.claims',true)::json->>'guest'='false';
CREATE OR REPLACE VIEW user_directory WITH (security_invoker=true) AS
SELECT u.id,u.handle,coalesce(nullif(trim(p.display_name),''),u.handle) AS display_name,
  p.location,p.about_me,u.created_at AS joined_at,p.id AS biography_id,
  (SELECT count(*) FROM comment c WHERE c.app_user_id=u.id)+
    (SELECT count(*) FROM team_comment c WHERE c.app_user_id=u.id) AS comment_count,
  (SELECT count(*) FROM game_change c WHERE c.actor_id=u.id) AS edit_count,
  (SELECT max(c.created_at) FROM game_change c WHERE c.actor_id=u.id) AS last_edit_at,
  replace(replace(replace(coalesce(p.display_name,'')||' '||u.handle||' '||coalesce(p.location,''),
    'ı','i'),'þ','th'),'Þ','th') COLLATE golaberto_search AS search_key,
  NULL::bigint AS txid,'public:'::text AS scope_id,a.id AS avatar_id,
  to_char(u.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS joined_on,a.avatar_key
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id LEFT JOIN user_avatar a ON a.id=u.id;
DROP FUNCTION IF EXISTS user_avatar(user_directory);
CREATE OR REPLACE FUNCTION user_avatar(community_access) RETURNS SETOF user_avatar
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$ SELECT a.* FROM user_avatar a WHERE a.id=$1.avatar_id AND $1.kind='profile' $$;
REVOKE ALL ON FUNCTION user_avatar(community_access) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_avatar(community_access) TO anon,app_user,service;
NOTIFY pgrst,'reload schema';
COMMIT;
