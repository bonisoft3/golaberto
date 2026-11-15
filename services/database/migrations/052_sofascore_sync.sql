BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
CREATE TABLE IF NOT EXISTS public.sofa_tick (
 id uuid PRIMARY KEY, schedule text NOT NULL, tick_at timestamptz NOT NULL,
 late boolean NOT NULL, caller text, txid bigint DEFAULT pg_current_xact_id()::text::bigint
);
REVOKE ALL ON public.sofa_tick FROM PUBLIC;
GRANT SELECT,INSERT ON public.sofa_tick TO service;
INSERT INTO mecha.rls_exempt VALUES ('public.sofa_tick','internal: no app_user reaches it') ON CONFLICT DO NOTHING;
ALTER TABLE public.sofa_tick ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sofa_tick_service_all ON public.sofa_tick;
CREATE POLICY sofa_tick_service_all ON public.sofa_tick FOR ALL TO service USING(true) WITH CHECK(true);
DROP TRIGGER IF EXISTS restamp_txid ON public.sofa_tick;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON public.sofa_tick FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- Fresh init creates schedule at 800; retained volumes need this registration.
DO $$ BEGIN
 IF to_regclass('public.schedule') IS NOT NULL THEN
  INSERT INTO public.schedule(name,cron,time_zone,suspended,max_lateness_seconds,concurrency_policy,emits_entity,emits_values)
  VALUES('sofascore-minute','* * * * *','UTC',false,300,'Allow','sofa_tick','{}')
  ON CONFLICT(name) DO UPDATE SET cron=EXCLUDED.cron,suspended=false,emits_entity=EXCLUDED.emits_entity;
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='golaberto_cdc') AND NOT EXISTS(
  SELECT 1 FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND schemaname='public' AND tablename='sofa_tick') THEN
  ALTER PUBLICATION golaberto_cdc ADD TABLE public.sofa_tick;
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sofa;
REVOKE ALL ON SCHEMA sofa FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sofa.control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), paused boolean NOT NULL DEFAULT false,
 blocked_until timestamptz, minute_limit integer NOT NULL DEFAULT 6 CHECK(minute_limit BETWEEN 1 AND 600),
 budget_minute timestamptz NOT NULL DEFAULT date_trunc('minute',clock_timestamp()), used integer NOT NULL DEFAULT 0,
 pause_reason text
);
INSERT INTO sofa.control(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sofa.source (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), championship_id uuid NOT NULL REFERENCES public.championship(id),
 unique_tournament_id bigint NOT NULL CHECK(unique_tournament_id>0), season_id bigint NOT NULL CHECK(season_id>0),
 enabled boolean NOT NULL DEFAULT false, detail_after timestamptz NOT NULL DEFAULT clock_timestamp(),
 create_players boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 event_scope text NOT NULL DEFAULT 'competition' CHECK(event_scope IN ('competition','stages','fixtures')),
 UNIQUE(unique_tournament_id,season_id), UNIQUE(championship_id)
);
CREATE TABLE IF NOT EXISTS sofa.binding (
 entity_kind text NOT NULL CHECK(entity_kind IN ('team','player','game')), external_id text NOT NULL CHECK(external_id ~ '^[1-9][0-9]*$'),
 local_id uuid NOT NULL, state text NOT NULL DEFAULT 'confirmed' CHECK(state IN ('confirmed','pending','conflict')),
 provenance text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(entity_kind,external_id), UNIQUE(entity_kind,local_id)
);
CREATE TABLE IF NOT EXISTS sofa.stage_binding (
 source_id uuid NOT NULL REFERENCES sofa.source(id), stage_key text NOT NULL, phase_id uuid NOT NULL REFERENCES public.phase(id),
 PRIMARY KEY(source_id,stage_key)
);
CREATE TABLE IF NOT EXISTS sofa.review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid REFERENCES sofa.source(id), kind text NOT NULL,
 external_id text NOT NULL DEFAULT '', reason text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', fingerprint text NOT NULL UNIQUE,
 resolved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS sofa.resource (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES sofa.source(id),
 family text NOT NULL CHECK(family IN ('rounds','round','event','lineups','incidents')), resource_key text NOT NULL,
 path text NOT NULL CHECK(path ~ '^[A-Za-z0-9/_,.?=%&+:-]+$' AND path NOT LIKE '%..%'),
 meta jsonb NOT NULL DEFAULT '{}', next_due_at timestamptz, priority integer NOT NULL DEFAULT 10,
 etag text, last_modified text, cache_until timestamptz, body text, semantic_hash text,
 last_success_at timestamptz, last_change_at timestamptz, last_error text, failures integer NOT NULL DEFAULT 0,
 generation bigint NOT NULL DEFAULT 0, UNIQUE(source_id,resource_key)
);
CREATE TABLE IF NOT EXISTS sofa.attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource_id uuid NOT NULL REFERENCES sofa.resource(id),
 generation bigint NOT NULL, token uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','inflight','fetched','applied','failed')),
 lease_until timestamptz, status integer, headers jsonb NOT NULL DEFAULT '{}', body text, error text,
 requests integer NOT NULL DEFAULT 0, elapsed_ms bigint, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz, UNIQUE(resource_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS sofa_attempt_active ON sofa.attempt(resource_id) WHERE state IN ('queued','inflight','fetched');
CREATE INDEX IF NOT EXISTS sofa_resource_due ON sofa.resource(next_due_at) WHERE next_due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS sofa.baseline (
 table_name text NOT NULL, local_id uuid NOT NULL, source_id uuid NOT NULL REFERENCES sofa.source(id),
 fields jsonb NOT NULL, removed boolean NOT NULL DEFAULT false, PRIMARY KEY(table_name,local_id)
);
CREATE TABLE IF NOT EXISTS sofa.event (
 source_id uuid NOT NULL REFERENCES sofa.source(id), external_id text NOT NULL,
 snapshot jsonb NOT NULL, details_eligible boolean NOT NULL DEFAULT false, first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_id,external_id)
);
ALTER TABLE public.game ADD COLUMN IF NOT EXISTS sync_status text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='game_sync_status_check') THEN
  ALTER TABLE public.game ADD CONSTRAINT game_sync_status_check CHECK(sync_status IS NULL OR sync_status IN
   ('scheduled','in_progress','finished','postponed','cancelled','abandoned','awarded','unknown'));
 END IF;
END $$;
ALTER TABLE public.goal ADD COLUMN IF NOT EXISTS period text;
ALTER TABLE public.goal ADD COLUMN IF NOT EXISTS added_time integer CHECK(added_time>=0);
ALTER TABLE public.goal ADD COLUMN IF NOT EXISTS source_order integer CHECK(source_order>=0);
CREATE TABLE IF NOT EXISTS public.substitution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES public.game(id) ON DELETE CASCADE,
 player_off_id uuid NOT NULL REFERENCES public.player(id) ON DELETE CASCADE, player_on_id uuid NOT NULL REFERENCES public.player(id) ON DELETE CASCADE,
 side text NOT NULL CHECK(side IN ('home','away')), minute integer NOT NULL CHECK(minute BETWEEN 0 AND 130),
 added_time integer CHECK(added_time>=0), period text, source_order integer CHECK(source_order>=0),
 CHECK(player_off_id<>player_on_id), txid bigint DEFAULT pg_current_xact_id()::text::bigint
);
ALTER TABLE public.substitution ADD COLUMN IF NOT EXISTS txid bigint DEFAULT pg_current_xact_id()::text::bigint;
INSERT INTO mecha.rls_exempt VALUES ('public.substitution','internal: no app_user reaches it') ON CONFLICT DO NOTHING;
ALTER TABLE public.substitution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.substitution FROM PUBLIC;

CREATE OR REPLACE FUNCTION sofa.review_item(p_source uuid,p_kind text,p_external text,p_reason text,p_evidence jsonb)
RETURNS void LANGUAGE sql SET search_path=sofa,public,pg_temp AS $$
 INSERT INTO sofa.review(source_id,kind,external_id,reason,evidence,fingerprint)
 VALUES(p_source,p_kind,coalesce(p_external,''),p_reason,p_evidence,
 md5(coalesce(p_source::text,'')||p_kind||coalesce(p_external,'')||p_reason||p_evidence::text))
 ON CONFLICT(fingerprint) DO NOTHING
$$;
CREATE OR REPLACE FUNCTION sofa.plan() RETURNS integer LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE item record; total integer:=0;
BEGIN
 DELETE FROM public.sofa_tick WHERE tick_at<clock_timestamp()-interval '7 days';
 UPDATE sofa.attempt SET body=NULL WHERE created_at<clock_timestamp()-interval '30 days' AND state IN ('applied','failed') AND body IS NOT NULL;
 UPDATE sofa.source s SET enabled=false FROM public.championship c WHERE c.id=s.championship_id AND s.enabled
 AND c.ends<current_date-30 AND NOT EXISTS(SELECT 1 FROM sofa.event e WHERE e.source_id=s.id AND e.snapshot->>'status' NOT IN ('finished','cancelled','abandoned','awarded'))
 AND NOT EXISTS(SELECT 1 FROM public.game g JOIN public.phase p ON p.id=g.phase_id WHERE p.championship_id=s.championship_id AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded'));
 IF EXISTS(SELECT 1 FROM sofa.control WHERE paused OR blocked_until>clock_timestamp()) THEN RETURN 0; END IF;
 FOR item IN SELECT r.id FROM sofa.resource r JOIN sofa.source s ON s.id=r.source_id
 WHERE s.enabled AND r.next_due_at<=clock_timestamp() AND coalesce(r.cache_until,'-infinity')<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM sofa.attempt a WHERE a.resource_id=r.id AND a.state IN ('queued','inflight','fetched'))
 ORDER BY r.priority,r.next_due_at LIMIT 100 FOR UPDATE OF r SKIP LOCKED LOOP
  UPDATE sofa.resource SET generation=generation+1 WHERE id=item.id;
  INSERT INTO sofa.attempt(resource_id,generation) SELECT id,generation FROM sofa.resource WHERE id=item.id;
  total:=total+1;
 END LOOP;
 RETURN total;
END $$;
CREATE OR REPLACE FUNCTION public.refresh_sofascore_queue() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=sofa,public,pg_temp AS $$ SELECT sofa.plan() $$;
REVOKE ALL ON FUNCTION public.refresh_sofascore_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_sofascore_queue() TO service;
CREATE OR REPLACE FUNCTION sofa.claim() RETURNS jsonb LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE c sofa.control; a sofa.attempt; r sofa.resource; s sofa.source;
BEGIN
 SELECT * INTO c FROM sofa.control WHERE id FOR UPDATE;
 IF c.paused OR c.blocked_until>clock_timestamp() THEN RETURN NULL; END IF;
 IF c.budget_minute<>date_trunc('minute',clock_timestamp()) THEN
  UPDATE sofa.control SET budget_minute=date_trunc('minute',clock_timestamp()),used=0 WHERE id RETURNING * INTO c;
 END IF;
 IF c.used>=c.minute_limit OR EXISTS(SELECT 1 FROM sofa.attempt WHERE state='fetched' OR state='inflight' AND lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
 SELECT a0.* INTO a FROM sofa.attempt a0 JOIN sofa.resource r0 ON r0.id=a0.resource_id JOIN sofa.source s0 ON s0.id=r0.source_id
 WHERE s0.enabled AND (a0.state='queued' OR (a0.state='inflight' AND a0.lease_until<=clock_timestamp()))
 ORDER BY r0.priority,r0.next_due_at LIMIT 1 FOR UPDATE OF a0 SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE sofa.attempt SET token=gen_random_uuid(),state='inflight',lease_until=clock_timestamp()+interval '60 seconds'
 WHERE id=a.id RETURNING * INTO a;
 SELECT * INTO r FROM sofa.resource WHERE id=a.resource_id;
 SELECT * INTO s FROM sofa.source WHERE id=r.source_id;
 RETURN jsonb_build_object('attempt',to_jsonb(a),'resource',to_jsonb(r),'source',to_jsonb(s)||jsonb_build_object('ends',(SELECT ends FROM public.championship WHERE id=s.championship_id)),'max_requests',c.minute_limit-c.used);
END $$;
CREATE OR REPLACE FUNCTION sofa.record_response(p_id uuid,p_token uuid,p_response jsonb,p_retry_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE a sofa.attempt; status_code integer; call_count integer; error_text text;
BEGIN
 SELECT * INTO a FROM sofa.attempt WHERE id=p_id AND token=p_token AND state='inflight' AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale SofaScore attempt'; END IF;
 status_code:=(p_response->>'status')::integer;
 call_count:=greatest(0,coalesce((p_response->>'requests')::integer,0));
 error_text:=p_response->>'error';
 UPDATE sofa.control SET used=used+call_count WHERE id;
 UPDATE sofa.attempt SET status=status_code,headers=coalesce(p_response->'headers','{}'),body=p_response->>'body',
 requests=call_count,elapsed_ms=(p_response->>'elapsed_ms')::bigint,error=error_text,
 state=CASE WHEN error_text IS NULL AND (status_code BETWEEN 200 AND 299 OR status_code=304) THEN 'fetched' ELSE 'failed' END,
 completed_at=clock_timestamp() WHERE id=a.id;
 IF error_text IS NOT NULL OR status_code IS NULL OR NOT(status_code BETWEEN 200 AND 299 OR status_code=304) THEN
  UPDATE sofa.resource SET failures=failures+1,last_error=coalesce(error_text,'HTTP '||status_code),next_due_at=p_retry_at WHERE id=a.resource_id;
  IF EXISTS(SELECT 1 FROM sofa.resource WHERE id=a.resource_id AND family IN ('lineups','incidents') AND failures>=5) THEN
   UPDATE sofa.resource SET next_due_at=NULL WHERE id=a.resource_id;
   PERFORM sofa.review_item(source_id,'details',resource_key,'detail HTTP retries exhausted',jsonb_build_object('status',status_code)) FROM sofa.resource WHERE id=a.resource_id;
  END IF;
  IF status_code IN (401,403) THEN UPDATE sofa.control SET paused=true,pause_reason='HTTP '||status_code WHERE id; END IF;
  IF status_code=429 THEN UPDATE sofa.control SET blocked_until=p_retry_at WHERE id; END IF;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION sofa.finish(p_id uuid,p_token uuid,p_due timestamptz,p_hash text,p_meta jsonb,p_cache_until timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE a sofa.attempt;
BEGIN
 SELECT * INTO a FROM sofa.attempt WHERE id=p_id AND token=p_token AND state='fetched' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale SofaScore apply'; END IF;
 UPDATE sofa.resource SET next_due_at=p_due,meta=p_meta,semantic_hash=p_hash,
 last_change_at=CASE WHEN semantic_hash IS DISTINCT FROM p_hash THEN clock_timestamp() ELSE last_change_at END,
 body=CASE WHEN a.status=304 THEN body ELSE a.body END,
 etag=coalesce(a.headers->>'etag',etag),last_modified=coalesce(a.headers->>'last-modified',last_modified),
 cache_until=p_cache_until,last_success_at=clock_timestamp(),
 last_error=CASE WHEN p_cache_until>p_due AND family IN ('round','event') THEN 'provider cache freshness exceeds polling target' ELSE NULL END,failures=0 WHERE id=a.resource_id;
 UPDATE sofa.attempt SET state='applied',completed_at=clock_timestamp() WHERE id=a.id;
END $$;
CREATE OR REPLACE VIEW sofa.status AS
 SELECT s.id,s.championship_id,s.unique_tournament_id,s.season_id,s.enabled,s.detail_after,
 (SELECT count(*) FROM sofa.resource r WHERE r.source_id=s.id AND r.next_due_at<=clock_timestamp()) AS overdue,
 (SELECT min(next_due_at) FROM sofa.resource r WHERE r.source_id=s.id) AS next_due_at,
 (SELECT max(last_success_at) FROM sofa.resource r WHERE r.source_id=s.id) AS last_success_at,
 (SELECT count(*) FROM sofa.review v WHERE v.source_id=s.id AND NOT resolved) AS reviews,
 (SELECT coalesce(sum(a.requests),0) FROM sofa.attempt a JOIN sofa.resource r ON r.id=a.resource_id WHERE r.source_id=s.id) AS requests,
 (SELECT coalesce(sum(octet_length(a.body)),0) FROM sofa.attempt a JOIN sofa.resource r ON r.id=a.resource_id WHERE r.source_id=s.id) AS payload_bytes,
 s.event_scope
 FROM sofa.source s;
REVOKE ALL ON ALL TABLES IN SCHEMA sofa FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sofa FROM PUBLIC;
COMMIT;
