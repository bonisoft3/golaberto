SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE OR REPLACE FUNCTION readable_address_base(label text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = public,pg_temp AS $$
  SELECT trim(BOTH '-' FROM regexp_replace(
    regexp_replace(normalize(
      translate(replace(replace(replace(replace(lower(label),
        'ß','ss'),'æ','ae'),'œ','oe'),'þ','th'),'øłđðı','olddi'), NFKD),
      U&'[\0300-\036f]', '', 'g'), '[^a-z0-9]+', '-', 'g'))
$$;

CREATE OR REPLACE FUNCTION stamp_readable_address() RETURNS trigger
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$
DECLARE
  label text;
  base text;
  candidate text;
  occupied boolean;
  suffix bigint := 1;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'championship' THEN
      label := concat_ws('-', NEW.region_name, NEW.name, extract(year FROM NEW.begins));
    WHEN 'game' THEN
      SELECT concat_ws('-', NEW.day, home.name, away.name) INTO label
        FROM team home CROSS JOIN team away
        WHERE home.id = NEW.home_id AND away.id = NEW.away_id;
    WHEN 'stage_group' THEN
      SELECT concat_ws('-', championship.slug, phase.name, NEW.name) INTO label
        FROM phase JOIN championship ON championship.id = phase.championship_id
        WHERE phase.id = NEW.phase_id;
    ELSE label := NEW.name;
  END CASE;
  base := coalesce(nullif(readable_address_base(label), ''), TG_TABLE_NAME);
  -- A literal name ending in a number can collide with another name's suffix.
  -- Serialize allocation per table, including those cross-base collisions.
  PERFORM pg_advisory_xact_lock(31031, TG_RELID::int);
  LOOP
    candidate := base || CASE WHEN suffix = 1 THEN '' ELSE '-' || suffix::text END;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE slug = $1 AND id <> $2)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO occupied USING candidate, NEW.id;
    EXIT WHEN NOT occupied;
    suffix := suffix + 1;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END $$;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['team','championship','game','stage_group','player','stadium','referee'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS slug text', target);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (slug)', target || '_slug_key', target);
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_readable_address ON %I', target);
    EXECUTE format('CREATE TRIGGER stamp_readable_address BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_readable_address()', target);
    EXECUTE format('UPDATE %I SET slug = NULL WHERE slug IS NULL OR slug = ''''', target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN slug SET NOT NULL', target);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(target) AND conname = target || '_slug_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (slug ~ ''^[a-z0-9]+(-[a-z0-9]+)*$'')', target, target || '_slug_check');
    END IF;
  END LOOP;
END $$;

COMMIT;
