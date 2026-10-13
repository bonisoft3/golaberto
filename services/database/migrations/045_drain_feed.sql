-- The drains wake on their queues' change events. Conduit keys an event by a
-- single-column primary key and refuses to start over a table with a
-- composite one, so the player metric queue takes a generated key; the pair
-- stays unique, as the enqueues' ON CONFLICT names it.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- A queue holds only pending work: the rewrite and the index builds below
-- cover a handful of rows.
-- squawk-ignore adding-field-with-default
ALTER TABLE player_metric_dirty ADD COLUMN IF NOT EXISTS queue_key text GENERATED ALWAYS AS
  (player_id::text || ':' || championship_id::text) STORED NOT NULL;
ALTER TABLE player_metric_dirty DROP CONSTRAINT IF EXISTS player_metric_dirty_pkey;
ALTER TABLE player_metric_dirty DROP CONSTRAINT IF EXISTS player_metric_dirty_pair;
-- squawk-ignore disallowed-unique-constraint, constraint-missing-not-valid
ALTER TABLE player_metric_dirty ADD CONSTRAINT player_metric_dirty_pair UNIQUE (player_id, championship_id);
-- squawk-ignore constraint-missing-not-valid, adding-serial-primary-key-field
ALTER TABLE player_metric_dirty ADD CONSTRAINT player_metric_dirty_pkey PRIMARY KEY (queue_key);

-- DayTick, the table the midnight schedules write, reaches a volume older than
-- it here; a fresh one has it from the generated baseline, whose table,
-- policy and trigger these restate.
CREATE TABLE IF NOT EXISTS day_tick (
  "id" uuid PRIMARY KEY,
  "schedule" TEXT NOT NULL,
  "tick_at" TIMESTAMPTZ NOT NULL,
  "late" boolean NOT NULL,
  "caller" TEXT,
  "txid" BIGINT DEFAULT pg_current_xact_id()::text::bigint
);
INSERT INTO mecha.rls_exempt VALUES ('public.day_tick', 'internal: no app_user reaches it') ON CONFLICT DO NOTHING;
ALTER TABLE day_tick ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS day_tick_service_all ON day_tick;
CREATE POLICY day_tick_service_all ON day_tick FOR ALL TO service USING (true) WITH CHECK (true);
DROP TRIGGER IF EXISTS restamp_txid ON day_tick;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON day_tick
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
COMMIT;
