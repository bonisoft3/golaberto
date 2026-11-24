SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The baseline's guest tests, each restated over a live database as
-- 011_comment_writes's public.signed_in().
CREATE OR REPLACE FUNCTION public.signed_in() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(c ? 'sub' AND c ->> 'acr' IS DISTINCT FROM '0' AND c ->> 'guest' IS DISTINCT FROM 'true', false)
  FROM (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS c) claims
$$;

CREATE OR REPLACE FUNCTION is_editor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.signed_in()
    AND EXISTS (SELECT 1 FROM public.editor WHERE app_user_id = auth_uid())
$$;

CREATE OR REPLACE FUNCTION community_stamp_biography() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user IN ('app_user','anon') AND
    (NEW.app_user_id IS DISTINCT FROM auth_uid() OR
      NOT public.signed_in()) THEN
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

CREATE OR REPLACE FUNCTION community_comment_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user IN ('app_user','anon') AND
    (OLD.app_user_id IS DISTINCT FROM auth_uid() OR
      NOT public.signed_in()) THEN
    RAISE EXCEPTION 'only a signed-in author removes their comment' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $$;

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
  IF NOT public.signed_in() OR actor IS NULL THEN
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

CREATE OR REPLACE FUNCTION golaberto_upload.pending_delete_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid := NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::json->>'sub','')::uuid;
BEGIN
  IF current_setting('role',true)='app_user' THEN
    IF actor IS NULL OR NOT public.signed_in() THEN
      RAISE EXCEPTION 'Signed-in account required' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || actor,0));
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION golaberto_upload.cancel_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid := NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::json->>'sub','')::uuid;
BEGIN
  IF current_setting('role',true)='app_user' THEN
    IF actor IS DISTINCT FROM OLD.app_user_id OR NOT public.signed_in() THEN
      RAISE EXCEPTION 'Pending upload owner required' USING ERRCODE='42501';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('golaberto-upload:' || OLD.app_user_id,0));
  DELETE FROM golaberto_upload.object WHERE key=OLD.id AND owner_id=OLD.app_user_id AND attached_kind IS NULL;
  RETURN OLD;
END $$;

DROP POLICY IF EXISTS comment_author_insert ON comment;
CREATE POLICY comment_author_insert ON comment FOR INSERT TO app_user
  WITH CHECK (app_user_id = auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS team_comment_author_insert ON team_comment;
CREATE POLICY team_comment_author_insert ON team_comment FOR INSERT TO app_user
  WITH CHECK (app_user_id = auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS user_biography_author_insert ON user_biography;
CREATE POLICY user_biography_author_insert ON user_biography FOR INSERT TO app_user
  WITH CHECK (app_user_id=auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS user_biography_author_update ON user_biography;
CREATE POLICY user_biography_author_update ON user_biography FOR UPDATE TO app_user USING (true)
  WITH CHECK (app_user_id=auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS avatar_owner_insert ON public.user_avatar;
CREATE POLICY avatar_owner_insert ON public.user_avatar FOR INSERT TO app_user WITH CHECK(id=public.auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS avatar_owner_update ON public.user_avatar;
CREATE POLICY avatar_owner_update ON public.user_avatar FOR UPDATE TO app_user USING(true) WITH CHECK(id=public.auth_uid() AND public.signed_in());
DROP POLICY IF EXISTS pending_account_guard ON public.user_pending_upload;
CREATE POLICY pending_account_guard ON public.user_pending_upload AS RESTRICTIVE FOR ALL TO app_user
  USING(app_user_id=public.auth_uid() AND public.signed_in())
  WITH CHECK(app_user_id=public.auth_uid() AND public.signed_in());

CREATE OR REPLACE VIEW community_access WITH (security_invoker=true) AS
SELECT 'profile:'||u.id::text AS id,u.id AS record_id,'profile'::text AS kind,p.id AS biography_id,
 NULL::bigint AS txid,'public:'::text AS scope_id,a.id AS avatar_id
FROM app_user u LEFT JOIN user_biography p ON p.app_user_id=u.id LEFT JOIN user_avatar a ON a.id=u.id
WHERE u.id=auth_uid() AND public.signed_in()
UNION ALL SELECT 'comment:'||c.id::text,c.id,'comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM comment c WHERE c.app_user_id=auth_uid() AND public.signed_in()
UNION ALL SELECT 'team_comment:'||c.id::text,c.id,'team_comment',NULL::uuid,NULL::bigint,'public:',NULL::uuid
FROM team_comment c WHERE c.app_user_id=auth_uid() AND public.signed_in();
