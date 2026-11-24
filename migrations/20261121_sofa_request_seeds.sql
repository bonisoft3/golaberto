SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The request's machine restated with a seed's restore (900_seed.sql marks its
-- session as seeding, and a seeded row stands in its state, entering nothing);
-- its own migration keeps the bytes the edge ran (program.cue baseline.carried).
ALTER TABLE "sofa_request" DROP CONSTRAINT IF EXISTS "sofa_request_status_check";
ALTER TABLE "sofa_request" ADD CONSTRAINT "sofa_request_status_check" CHECK ("status" IN ('acquiring', 'applied', 'failed')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_sofa_request_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD' AS $$
DECLARE
  outcome jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('acquiring') THEN
      RAISE EXCEPTION '% in % awaits an outcome and is not deleted', 'sofa_request', OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'acquiring' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in acquiring keeps its key until the outcome of %', 'sofa_request', 'acquire:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'acquiring' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'sofa_request', 'acquiring', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('acquire:' || NEW."id"::text, 'acquire', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'path', NEW."path"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering acquiring again needs a new key', 'acquire:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'acquire:' || NEW."id"::text), job_key => airlock.job_key('acquire:' || NEW."id"::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'acquiring' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'acquire:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves acquiring only by the recorded outcome of %', 'sofa_request', 'acquire:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'applied' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'applied';
        PERFORM sofa.receive(NEW.id, NEW.source_id, NEW.family, NEW.resource_key, NEW.seq, outcome);
        RETURN NEW;
      END IF;
      IF NEW."status" = 'failed' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'failed';
        NEW."failure" := coalesce(outcome->'data'->>'error', outcome->'data'->>'reason', outcome->>'kind');
        PERFORM sofa.fail(NEW.resource_id, outcome);
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'sofa_request', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'applied' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'sofa_request' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'failed' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'sofa_request' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_sofa_request_status_machine" ON "sofa_request";
CREATE TRIGGER "trg_sofa_request_status_machine"
  BEFORE INSERT OR UPDATE OR DELETE ON "sofa_request"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_sofa_request_status_machine"();
