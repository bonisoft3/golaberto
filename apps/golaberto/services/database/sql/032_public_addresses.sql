-- Stable public addresses are allocated once; source UUIDs remain the identity.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE TABLE IF NOT EXISTS public_address (
  id portable_string PRIMARY KEY,
  kind portable_string NOT NULL CHECK (kind IN ('team','championship','game','group','player','stadium','referee')),
  record_id uuid NOT NULL,
  slug portable_string NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL,
  CONSTRAINT uq_public_address_record UNIQUE (kind,record_id),
  CONSTRAINT uq_public_address_slug UNIQUE (kind,slug)
);
CALL rls_protect('public_address');
DROP POLICY IF EXISTS public_address_app_user_select ON public_address;
CREATE POLICY public_address_app_user_select ON public_address FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS public_address_service_all ON public_address;
CREATE POLICY public_address_service_all ON public_address FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON public_address FROM PUBLIC,anon,app_user;
GRANT SELECT ON public_address TO anon,app_user,electric;
GRANT SELECT,INSERT,UPDATE,DELETE ON public_address TO service;
DROP TRIGGER IF EXISTS restamp_txid ON public_address;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON public_address
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE public_address REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
    WHERE pubname='electric_publication_default' AND schemaname='public' AND tablename='public_address') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE public_address;
  END IF;
END $$;
-- tier: any

-- NFKD removes Latin accents without an extension. These letters do not
-- decompose to ASCII, so give them the archive's familiar Latin equivalents.
CREATE OR REPLACE FUNCTION public_address_base(label text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = public,pg_temp AS $$
  SELECT trim(BOTH '-' FROM regexp_replace(
    regexp_replace(normalize(
      translate(replace(replace(replace(replace(lower(label),
        'ß','ss'),'æ','ae'),'œ','oe'),'þ','th'),'øłđðı','olddi'), NFKD),
      U&'[\0300-\036f]', '', 'g'), '[^a-z0-9]+', '-', 'g'))
$$;

CREATE OR REPLACE FUNCTION allocate_public_address(address_kind text, source_id uuid, label text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE
  address_id text := address_kind || ':' || source_id::text;
  base text;
  candidate text;
  allocated text;
  suffix bigint := 1;
BEGIN
  SELECT slug INTO allocated FROM public_address WHERE id=address_id;
  IF FOUND THEN RETURN allocated; END IF;
  base := COALESCE(NULLIF(public_address_base(label),''),address_kind);
  -- UUID-shaped names must not shadow the backward-compatible UUID route.
  IF base ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
    base := address_kind || '-' || base;
  END IF;
  LOOP
    candidate := base || CASE WHEN suffix=1 THEN '' ELSE '-' || suffix::text END;
    INSERT INTO public_address(id,kind,record_id,slug)
      VALUES(address_id,address_kind,source_id,candidate)
      ON CONFLICT DO NOTHING RETURNING slug INTO allocated;
    IF FOUND THEN RETURN allocated; END IF;
    -- Concurrent attempts for one record converge; a slug collision retries
    -- under the unique index, including collisions with literal numeric names.
    SELECT slug INTO allocated FROM public_address WHERE id=address_id;
    IF FOUND THEN RETURN allocated; END IF;
    suffix := suffix+1;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION stamp_public_address() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE
  address_kind text := TG_ARGV[0];
  label text;
BEGIN
  IF EXISTS(SELECT 1 FROM public_address WHERE id=address_kind || ':' || NEW.id::text) THEN
    RETURN NULL;
  END IF;
  CASE address_kind
    WHEN 'championship' THEN
      SELECT concat_ws(' ',NEW.region_name,NEW.name,NEW.season,c.name) INTO label
        FROM (SELECT 1) one LEFT JOIN category c ON c.id=NEW.category_id;
    WHEN 'group' THEN
      SELECT concat_ws(' ',c.region_name,c.name,c.season,cat.name,p.name,NEW.name) INTO label
        FROM phase p JOIN championship c ON c.id=p.championship_id
        LEFT JOIN category cat ON cat.id=c.category_id WHERE p.id=NEW.phase_id;
    WHEN 'game' THEN
      SELECT to_char(NEW.day,'YYYY-MM-DD') || ' ' || h.name || ' ' || a.name INTO label
        FROM team h CROSS JOIN team a WHERE h.id=NEW.home_id AND a.id=NEW.away_id;
    ELSE label := NEW.name;
  END CASE;
  PERFORM allocate_public_address(address_kind,NEW.id,label);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public_address_base(text),allocate_public_address(text,uuid,text),stamp_public_address()
  FROM PUBLIC,anon,app_user;

-- UPDATE covers importers using ON CONFLICT and missing pre-upgrade mappings.
-- There is intentionally no DELETE trigger: removed records reserve their
-- addresses so an old bookmark can never be reassigned to a different record.
DO $$ DECLARE source_table text; address_kind text; BEGIN
  FOR source_table,address_kind IN SELECT * FROM (VALUES
    ('team','team'),('championship','championship'),('game','game'),
    ('stage_group','group'),('player','player'),('stadium','stadium'),('referee','referee')) sources LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS public_address_stamp ON %I',source_table);
    EXECUTE format('CREATE TRIGGER public_address_stamp AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_public_address(%L)',source_table,address_kind);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public_address_backfill (version text PRIMARY KEY);
REVOKE ALL ON public_address_backfill FROM PUBLIC,anon,app_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON public_address_backfill TO service;
DO $$ DECLARE missing record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM public_address_backfill WHERE version='032') THEN
    -- Most archive names are distinct. Allocate those in one bulk statement;
    -- only collisions need the suffix allocator. Ordering fixes the winner on
    -- fresh installs, while existing allocations always take precedence.
    CREATE TEMP TABLE public_address_candidates ON COMMIT DROP AS
      SELECT kind,record_id,CASE WHEN base ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN kind || '-' || base ELSE COALESCE(NULLIF(base,''),kind) END AS base
      FROM (
        SELECT kind,record_id,public_address_base(label) AS base FROM (
          SELECT 'team'::text AS kind,id AS record_id,name::text AS label FROM team
          UNION ALL SELECT 'player',id,name FROM player
          UNION ALL SELECT 'stadium',id,name FROM stadium
          UNION ALL SELECT 'referee',id,name FROM referee
          UNION ALL SELECT 'championship',c.id,concat_ws(' ',c.region_name,c.name,c.season,cat.name)
            FROM championship c LEFT JOIN category cat ON cat.id=c.category_id
          UNION ALL SELECT 'group',g.id,concat_ws(' ',c.region_name,c.name,c.season,cat.name,p.name,g.name)
            FROM stage_group g JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
            LEFT JOIN category cat ON cat.id=c.category_id
          UNION ALL SELECT 'game',g.id,to_char(g.day,'YYYY-MM-DD') || ' ' || h.name || ' ' || a.name
            FROM game g JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
        ) sources
        WHERE NOT EXISTS(SELECT 1 FROM public_address a WHERE a.id=sources.kind || ':' || sources.record_id::text)
      ) normalized;
    INSERT INTO public_address(id,kind,record_id,slug)
      SELECT kind || ':' || record_id::text,kind,record_id,base
      FROM (SELECT DISTINCT ON (kind,base) * FROM public_address_candidates ORDER BY kind,base,record_id) winners
      ON CONFLICT DO NOTHING;
    -- Batch ordinary duplicate names too; only conflicts with existing
    -- reservations or literal names such as "United 2" need individual retry.
    INSERT INTO public_address(id,kind,record_id,slug)
      SELECT kind || ':' || record_id::text,kind,record_id,base || '-' || suffix::text
      FROM (SELECT c.*,row_number() OVER (PARTITION BY kind,base ORDER BY record_id) AS suffix
        FROM public_address_candidates c) numbered
      WHERE suffix>1
      ON CONFLICT DO NOTHING;
    FOR missing IN SELECT c.* FROM public_address_candidates c
      WHERE NOT EXISTS(SELECT 1 FROM public_address a WHERE a.id=c.kind || ':' || c.record_id::text)
      ORDER BY c.kind,c.base,c.record_id LOOP
      PERFORM allocate_public_address(missing.kind,missing.record_id,missing.base);
    END LOOP;
    DROP TABLE public_address_candidates;
    INSERT INTO public_address_backfill(version) VALUES('032') ON CONFLICT DO NOTHING;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
