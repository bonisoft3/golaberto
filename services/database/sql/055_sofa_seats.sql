-- The SofaScore reducers' seats and the shape check their view constraints
-- call, as 004 to 008 make them: a database whose baseline predates them gets
-- them here, before the actors step installs the reducers' triggers on them
-- (plugins/pronto/docs/schema-change-admission.md, what a live directory
-- carries). A fresh database finds everything in place.
BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
CREATE OR REPLACE FUNCTION public.portable_shape_valid(value json, shape jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
-- A value against the shape its column's constraint states, as derive-cel
-- read it (cel-emit.ts shapeTree): the kind at each level, a record's fields
-- (none stated: open), a list's items and cap, a string's length or set, an
-- integer's range. The same walk hybrid-runtime.js makes over a step's values.
DECLARE
  kind text := shape->>'kind';
  item json;
  key text;
  n numeric;
BEGIN
  CASE kind
    WHEN 'boolean' THEN RETURN json_typeof(value) = 'boolean';
    WHEN 'string' THEN
      IF json_typeof(value) <> 'string' THEN RETURN false; END IF;
      IF shape ? 'enumValues' THEN RETURN (shape->'enumValues') ? (value #>> '{}'); END IF;
      RETURN char_length(value #>> '{}') <= (shape->>'sizeMax')::int;
    WHEN 'integer' THEN
      IF json_typeof(value) <> 'number' THEN RETURN false; END IF;
      n := (value #>> '{}')::numeric;
      IF n <> trunc(n) THEN RETURN false; END IF;
      IF shape ? 'intMin' AND n < (shape->>'intMin')::numeric THEN RETURN false; END IF;
      IF shape ? 'intMax' AND n > (shape->>'intMax')::numeric THEN RETURN false; END IF;
      RETURN true;
    WHEN 'array' THEN
      IF json_typeof(value) <> 'array' THEN RETURN false; END IF;
      IF json_array_length(value) > (shape->>'maxItems')::int THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(value) LOOP
        IF public.portable_shape_valid(item, shape->'items') IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'object' THEN
      IF json_typeof(value) <> 'object' THEN RETURN false; END IF;
      IF NOT (shape ? 'fields') THEN RETURN true; END IF;
      FOR key IN SELECT json_object_keys(value) LOOP
        IF NOT ((shape->'fields') ? key) THEN RETURN false; END IF;
      END LOOP;
      FOR key IN SELECT jsonb_object_keys(shape->'fields') LOOP
        IF value->key IS NULL THEN RETURN false; END IF;
        IF public.portable_shape_valid(value->key, shape->'fields'->key) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE TABLE IF NOT EXISTS sofa_resource_seat (
  "id" TEXT PRIMARY KEY CHECK (char_length(id) <= 64),
  "instance_id" uuid NOT NULL,
  "actor" uuid NOT NULL,
  "seat" TEXT NOT NULL CHECK (char_length(seat) <= 16),
  "revision" BIGINT NOT NULL,
  "phase" TEXT NOT NULL CHECK (char_length(phase) <= 16),
  "view" json NOT NULL CONSTRAINT "sofa_resource_seat_view_type" CHECK ("view" IS NULL OR public.portable_json_valid("view") IS TRUE) CHECK (public.portable_shape_valid(view, '{"kind":"object","fields":{"checks":{"kind":"integer","intMin":0,"intMax":1000000},"complete":{"kind":"boolean"},"complete_checks":{"kind":"integer","intMin":0,"intMax":1000000},"due":{"kind":"integer","intMin":0,"intMax":9007199254740991},"failures":{"kind":"integer","intMin":0,"intMax":1000000},"family":{"kind":"string","enumValues":["rounds","round","event","lineups","incidents"]},"phase":{"kind":"string","enumValues":["due","acquiring","idle","backoff","review","done","answered","refused"]},"settled":{"kind":"boolean"},"status":{"kind":"integer","intMin":0,"intMax":999}}}'::jsonb)),
  "txid" BIGINT DEFAULT pg_current_xact_id()::text::bigint,
  "scope_id" TEXT GENERATED ALWAYS AS ('user:' || "actor") STORED NOT NULL
);
CALL rls_protect('sofa_resource_seat');
ALTER TABLE sofa_resource_seat ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sofa_resource_seat_app_user_select ON sofa_resource_seat;
CREATE POLICY sofa_resource_seat_app_user_select ON sofa_resource_seat FOR SELECT TO app_user USING (sofa_resource_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_resource_seat_app_user_insert ON sofa_resource_seat;
CREATE POLICY sofa_resource_seat_app_user_insert ON sofa_resource_seat FOR INSERT TO app_user WITH CHECK (sofa_resource_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_resource_seat_app_user_update ON sofa_resource_seat;
CREATE POLICY sofa_resource_seat_app_user_update ON sofa_resource_seat FOR UPDATE TO app_user USING (sofa_resource_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_resource_seat_app_user_delete ON sofa_resource_seat;
CREATE POLICY sofa_resource_seat_app_user_delete ON sofa_resource_seat FOR DELETE TO app_user USING (sofa_resource_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_resource_seat_service_all ON sofa_resource_seat;
CREATE POLICY sofa_resource_seat_service_all ON sofa_resource_seat FOR ALL TO service USING (true) WITH CHECK (true);
DROP TRIGGER IF EXISTS restamp_txid ON sofa_resource_seat;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON sofa_resource_seat
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
CREATE OR REPLACE TRIGGER mark_txn BEFORE INSERT OR UPDATE OR DELETE ON sofa_resource_seat
  FOR EACH STATEMENT EXECUTE FUNCTION mecha.mark_txn();
-- tier: container
ALTER TABLE sofa_resource_seat REPLICA IDENTITY FULL;
-- tier: any
CREATE TABLE IF NOT EXISTS sofa_provider_seat (
  "id" TEXT PRIMARY KEY CHECK (char_length(id) <= 64),
  "instance_id" uuid NOT NULL,
  "actor" uuid NOT NULL,
  "seat" TEXT NOT NULL CHECK (char_length(seat) <= 16),
  "revision" BIGINT NOT NULL,
  "phase" TEXT NOT NULL CHECK (char_length(phase) <= 16),
  "view" json NOT NULL CONSTRAINT "sofa_provider_seat_view_type" CHECK ("view" IS NULL OR public.portable_json_valid("view") IS TRUE) CHECK (public.portable_shape_valid(view, '{"kind":"object","fields":{"phase":{"kind":"string","enumValues":["open","paused","blocked","judged"]},"reason":{"kind":"string","sizeMax":32},"until":{"kind":"integer","intMin":0,"intMax":9007199254740991}}}'::jsonb)),
  "txid" BIGINT DEFAULT pg_current_xact_id()::text::bigint,
  "scope_id" TEXT GENERATED ALWAYS AS ('user:' || "actor") STORED NOT NULL
);
CALL rls_protect('sofa_provider_seat');
ALTER TABLE sofa_provider_seat ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sofa_provider_seat_app_user_select ON sofa_provider_seat;
CREATE POLICY sofa_provider_seat_app_user_select ON sofa_provider_seat FOR SELECT TO app_user USING (sofa_provider_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_provider_seat_app_user_insert ON sofa_provider_seat;
CREATE POLICY sofa_provider_seat_app_user_insert ON sofa_provider_seat FOR INSERT TO app_user WITH CHECK (sofa_provider_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_provider_seat_app_user_update ON sofa_provider_seat;
CREATE POLICY sofa_provider_seat_app_user_update ON sofa_provider_seat FOR UPDATE TO app_user USING (sofa_provider_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_provider_seat_app_user_delete ON sofa_provider_seat;
CREATE POLICY sofa_provider_seat_app_user_delete ON sofa_provider_seat FOR DELETE TO app_user USING (sofa_provider_seat.actor = auth_uid());
DROP POLICY IF EXISTS sofa_provider_seat_service_all ON sofa_provider_seat;
CREATE POLICY sofa_provider_seat_service_all ON sofa_provider_seat FOR ALL TO service USING (true) WITH CHECK (true);
DROP TRIGGER IF EXISTS restamp_txid ON sofa_provider_seat;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON sofa_provider_seat
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
CREATE OR REPLACE TRIGGER mark_txn BEFORE INSERT OR UPDATE OR DELETE ON sofa_provider_seat
  FOR EACH STATEMENT EXECUTE FUNCTION mecha.mark_txn();
-- tier: container
ALTER TABLE sofa_provider_seat REPLICA IDENTITY FULL;
-- tier: any
COMMIT;
