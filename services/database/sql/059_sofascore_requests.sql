BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
-- A request row's commit stores its answer as an observation, parses it with
-- the database functions and applies it when it is its resource's newest
-- (apps/golaberto/docs/decisions/2026-10-28-crawling.md).
ALTER TABLE sofa.source ADD COLUMN IF NOT EXISTS next_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS public.sofa_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL, source_id uuid NOT NULL,
 resource_id uuid NOT NULL, family text NOT NULL, resource_key text NOT NULL, path text NOT NULL,
 seq portable_int64 NOT NULL CHECK(seq>0), failure text,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), stuck_at timestamptz,
 txid bigint DEFAULT pg_current_xact_id()::text::bigint
);
INSERT INTO mecha.rls_exempt VALUES ('public.sofa_request','internal: no app_user reaches it') ON CONFLICT DO NOTHING;
ALTER TABLE public.sofa_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sofa_request FROM PUBLIC;
DROP POLICY IF EXISTS sofa_request_service_all ON public.sofa_request;
CREATE POLICY sofa_request_service_all ON public.sofa_request FOR ALL TO service USING (true) WITH CHECK (true);
CREATE TABLE IF NOT EXISTS sofa.observation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
 source_id uuid NOT NULL REFERENCES sofa.source(id), family text NOT NULL, resource_key text NOT NULL,
 seq bigint NOT NULL CHECK(seq>0), response jsonb NOT NULL, normalized jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(source_id,resource_key,seq)
);
REVOKE ALL ON sofa.observation FROM PUBLIC;
CREATE OR REPLACE VIEW sofa.current AS
 SELECT DISTINCT ON (source_id,resource_key) * FROM sofa.observation ORDER BY source_id,resource_key,seq DESC;
REVOKE ALL ON sofa.current FROM PUBLIC;
-- A resource's and the provider's lifecycle are their reducers'
-- (machines/sofa_resource.js, machines/sofa_provider.js); SQL keeps what is
-- decided over every resource at once: priority and the minute's budget.
DROP VIEW IF EXISTS sofa.status;
ALTER TABLE sofa.control DROP COLUMN IF EXISTS paused, DROP COLUMN IF EXISTS blocked_until, DROP COLUMN IF EXISTS pause_reason;
DROP INDEX IF EXISTS sofa.sofa_resource_due;
ALTER TABLE sofa.resource DROP COLUMN IF EXISTS next_due_at, DROP COLUMN IF EXISTS failures, DROP COLUMN IF EXISTS cache_until;
-- The one member of every scheduling instance: no reader opens them.
CREATE OR REPLACE FUNCTION sofa.service_actor() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-4000-8000-00000000050f'::uuid $$;
CREATE OR REPLACE FUNCTION sofa.provider_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-4000-8000-0000000050fa'::uuid $$;
CREATE OR REPLACE FUNCTION sofa.ms(p_at timestamptz) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT floor(extract(epoch FROM p_at)*1000)::bigint $$;
-- Fixtures as a resource's rules read them: status, kickoff and calendar day in epoch milliseconds.
CREATE OR REPLACE FUNCTION sofa.owed(p_events jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET timezone='UTC' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('status',coalesce(e->>'status','scheduled'),
  'kickoff',coalesce(sofa.ms(nullif(e->>'kickoff','')::timestamptz),0),
  'day',coalesce(sofa.ms(nullif(e->>'day','')::date::timestamptz),0))),'[]')
 FROM jsonb_array_elements(coalesce(p_events,'[]')) e
$$;
CREATE OR REPLACE FUNCTION sofa.resource_state(p_resource uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=sofa,public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 SELECT i.state INTO v FROM hybrid_sofa_resource.instance i WHERE i.id=p_resource;
 RETURN v;
END $$;
CREATE OR REPLACE FUNCTION sofa.tell(p_resource uuid,p_kind text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
BEGIN
 PERFORM hybrid_sofa_resource.deliver(p_resource,jsonb_build_object('kind',p_kind,'payload',p_payload));
 RETURN sofa.resource_state(p_resource);
END $$;
-- The provider's standing, its instance made the first time it is asked.
CREATE OR REPLACE FUNCTION sofa.provider(p_kind text DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 SELECT i.state INTO v FROM hybrid_sofa_provider.instance i WHERE i.id=sofa.provider_id();
 IF NOT FOUND THEN
  PERFORM hybrid_sofa_provider.spawn(sofa.provider_id(),'{}'::jsonb,jsonb_build_object('service',sofa.service_actor()));
 END IF;
 IF p_kind IS NOT NULL THEN
  PERFORM hybrid_sofa_provider.deliver(sofa.provider_id(),jsonb_build_object('kind',p_kind,'payload',p_payload));
 END IF;
 SELECT i.state INTO STRICT v FROM hybrid_sofa_provider.instance i WHERE i.id=sofa.provider_id();
 RETURN v;
END $$;
-- An operator lifts a pause or a block.
CREATE OR REPLACE FUNCTION sofa.resume() RETURNS jsonb
LANGUAGE sql SET search_path=sofa,public,pg_temp AS $$ SELECT sofa.provider('resumed') $$;
REVOKE ALL ON FUNCTION sofa.resume() FROM PUBLIC;

CREATE OR REPLACE FUNCTION sofa.apply_source_patch(p_source uuid, p_patch jsonb, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE
  v_source uuid; v_championship uuid; v_event text; v_game uuid;
  r jsonb; b jsonb; c jsonb; x jsonb; v_rows jsonb := '[]'; v_conflicts jsonb := '[]';
  v_id_map jsonb := '{}'; v_collections jsonb := '[]'; v_original uuid;
  v_table text; v_id uuid; v_fields jsonb; v_typed jsonb; v_current jsonb;
  v_base sofa.baseline%ROWTYPE; v_has_base boolean; v_exists boolean;
  v_allowed text[]; v_key text; v_columns text; v_values text; v_sets text;
  v_conflict boolean; v_target uuid; v_game_id uuid; v_count integer := 0;
  v_reason text; v_evidence jsonb; v_kind text; v_external text;
  v_skipped text[]; v_bad_result boolean; v_pristine_result boolean; v_soft_conflicts integer := 0; v_result_ready boolean := false;
BEGIN
  SELECT s.id, s.championship_id INTO v_source, v_championship FROM sofa.source s WHERE s.id = p_source;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown source'; END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR jsonb_typeof(p_patch->'rows') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_patch->'bindings') IS DISTINCT FROM 'array' OR jsonb_typeof(p_patch->'reviews') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_patch->'collections') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid patch shape';
  END IF;
  v_event := p_patch->'event'->>'external_id';
  IF v_event IS NULL OR v_event = '' THEN RAISE EXCEPTION 'missing event identity'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sofa-source:' || v_source::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('sofa-event:' || v_source::text || ':' || v_event, 0));
  SELECT local_id INTO v_game FROM sofa.binding WHERE entity_kind = 'game' AND external_id = v_event AND state = 'confirmed';
  FOR r IN SELECT value FROM jsonb_array_elements(p_patch->'rows') LOOP
    v_table := r->>'table'; v_id := (r->>'id')::uuid; v_fields := r->'fields';
    -- A fixture new to the source arrives without a local id: it takes the bound
    -- game, or a fresh one the bindings below record for every later delivery.
    IF v_table = 'game' AND v_id IS NULL THEN v_id := coalesce(v_game, gen_random_uuid()); END IF;
    IF v_id IS NULL OR jsonb_typeof(v_fields) IS DISTINCT FROM 'object' OR v_fields = '{}'::jsonb THEN RAISE EXCEPTION 'invalid row'; END IF;
    v_allowed := CASE v_table
      WHEN 'game' THEN ARRAY['phase_id','home_id','away_id','day','kickoff','round','played','home_score','away_score','home_aet','away_aet','home_pen','away_pen','sync_status']
      WHEN 'player' THEN ARRAY['name','full_name','birth','country','height']
      WHEN 'team_player' THEN ARRAY['championship_id','team_id','player_id']
      WHEN 'player_game' THEN ARRAY['game_id','player_id','side','on_minute','off_minute','bench','yellow','red']
      WHEN 'goal' THEN ARRAY['game_id','player_id','side','minute','penalty','own_goal','aet','period','added_time','source_order']
      WHEN 'substitution' THEN ARRAY['game_id','side','minute','player_off_id','player_on_id','added_time','period','source_order']
      ELSE NULL END;
    IF v_allowed IS NULL OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_fields) k WHERE NOT k = ANY(v_allowed)) THEN RAISE EXCEPTION 'invalid fields for %', v_table; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table' = v_table AND q->>'id' = v_id::text) THEN RAISE EXCEPTION 'duplicate patch row'; END IF;
    IF v_table = 'game' THEN
      IF v_game IS NOT NULL AND v_game <> v_id THEN RAISE EXCEPTION 'event game mismatch'; END IF;
      v_game := v_id;
      IF NOT EXISTS (SELECT 1 FROM phase WHERE id = (v_fields->>'phase_id')::uuid AND championship_id = v_championship) THEN RAISE EXCEPTION 'game phase outside source'; END IF;
    ELSIF v_table = 'team_player' THEN
      IF (v_fields->>'championship_id')::uuid IS DISTINCT FROM v_championship THEN RAISE EXCEPTION 'membership outside source'; END IF;
      IF v_game IS NULL OR NOT EXISTS (SELECT 1 FROM game WHERE id=v_game AND (home_id=(v_fields->>'team_id')::uuid OR away_id=(v_fields->>'team_id')::uuid)) THEN RAISE EXCEPTION 'membership outside event teams'; END IF;
      SELECT id INTO v_target FROM team_player WHERE championship_id = v_championship AND team_id = (v_fields->>'team_id')::uuid AND player_id = (v_fields->>'player_id')::uuid FOR UPDATE;
      IF FOUND THEN v_id := v_target; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table'=v_table AND q->>'id'=v_id::text) THEN RAISE EXCEPTION 'duplicate patch row'; END IF;
    END IF;
    IF v_table = 'player_game' THEN
      v_original := v_id;
      SELECT id INTO v_target FROM player_game WHERE game_id=(v_fields->>'game_id')::uuid AND player_id=(v_fields->>'player_id')::uuid FOR UPDATE;
      IF FOUND AND v_target <> v_original THEN
        IF EXISTS (SELECT 1 FROM player_game WHERE id=v_original) THEN RAISE EXCEPTION 'appearance ID collides with another row'; END IF;
        IF EXISTS (SELECT 1 FROM sofa.baseline WHERE table_name='player_game' AND local_id=v_original AND NOT removed) THEN
          v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind','player_game','external_id',v_original::text,'reason','provider-owned appearance was manually deleted','evidence',jsonb_build_object('replacement_id',v_target)));
        END IF;
        v_id := v_target;
        v_id_map := v_id_map || jsonb_build_object(v_table || ':' || v_original::text, v_id::text);
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table'=v_table AND q->>'id'=v_id::text) THEN RAISE EXCEPTION 'duplicate patch row'; END IF;
    END IF;
    IF v_table IN ('player_game','goal','substitution') THEN
      v_game_id := (v_fields->>'game_id')::uuid;
      IF v_game_id IS NULL OR v_game IS DISTINCT FROM v_game_id THEN RAISE EXCEPTION 'dependent row outside event'; END IF;
    END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1 FOR UPDATE', v_table) INTO v_current USING v_id;
    v_exists := v_current IS NOT NULL;
    IF v_table = 'game' AND v_exists AND NOT EXISTS (SELECT 1 FROM phase WHERE id = (v_current->>'phase_id')::uuid AND championship_id = v_championship) THEN RAISE EXCEPTION 'existing game outside source'; END IF;
    IF v_table IN ('player_game','goal','substitution') AND v_exists AND (v_current->>'game_id')::uuid IS DISTINCT FROM v_game THEN RAISE EXCEPTION 'existing dependent row outside event'; END IF;
    SELECT * INTO v_base FROM sofa.baseline WHERE table_name = v_table AND local_id = v_id FOR UPDATE;
    v_has_base := FOUND;
    IF v_has_base AND v_base.source_id <> v_source THEN RAISE EXCEPTION 'row owned by another source'; END IF;
    EXECUTE format('SELECT coalesce(jsonb_object_agg(k, typed->k), ''{}''::jsonb) FROM (SELECT to_jsonb(jsonb_populate_record(NULL::public.%I, $1)) AS typed) t CROSS JOIN LATERAL jsonb_object_keys($1) k', v_table) INTO v_typed USING v_fields;
    v_conflict := v_has_base AND NOT v_base.removed AND NOT v_exists;
    v_skipped := ARRAY[]::text[]; v_bad_result := false;
    v_pristine_result := v_exists AND v_current->'played' = 'false'::jsonb
      AND v_current->'home_score' = 'null'::jsonb AND v_current->'away_score' = 'null'::jsonb
      AND v_current->'home_aet' = 'null'::jsonb AND v_current->'away_aet' = 'null'::jsonb
      AND v_current->'home_pen' = 'null'::jsonb AND v_current->'away_pen' = 'null'::jsonb;
    IF v_exists THEN
      FOR v_key IN SELECT jsonb_object_keys(v_typed) LOOP
        IF v_table='game' AND v_key IN ('day','kickoff') THEN CONTINUE; END IF;
        IF (NOT v_has_base OR NOT (v_base.fields ? v_key)) THEN
          v_exists := (v_current->v_key) IS DISTINCT FROM (v_typed->v_key)
            AND NOT (v_table='game' AND v_pristine_result AND v_key = ANY(ARRAY['played','home_score','away_score','home_aet','away_aet','home_pen','away_pen']))
            AND NOT (v_table='game' AND v_current->v_key = 'null'::jsonb AND v_key='sync_status');
        ELSE
          v_exists := (v_current->v_key) IS DISTINCT FROM (v_base.fields->v_key) AND (v_current->v_key) IS DISTINCT FROM (v_typed->v_key);
        END IF;
        IF v_exists THEN
          IF v_table='game' AND v_key = ANY(ARRAY['round','sync_status']) THEN
            v_skipped := array_append(v_skipped,v_key);
          ELSIF v_table='game' AND v_key = ANY(ARRAY['played','home_score','away_score','home_aet','away_aet','home_pen','away_pen']) THEN
            v_bad_result := true;
          ELSE
            v_conflict := true;
          END IF;
        END IF;
      END LOOP;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind',v_table,'external_id',v_id::text,'reason','manual change conflicts with provider','evidence',jsonb_build_object('current',v_current,'baseline',CASE WHEN v_has_base THEN v_base.fields ELSE NULL END,'proposed',v_typed)));
    END IF;
    IF v_table='game' AND NOT v_conflict AND NOT v_bad_result AND v_typed->'played'='true'::jsonb
       AND v_typed ? 'home_score' AND v_typed->'home_score'<>'null'::jsonb
       AND v_typed ? 'away_score' AND v_typed->'away_score'<>'null'::jsonb THEN v_result_ready := true; END IF;
    IF v_bad_result THEN
      v_skipped := v_skipped || ARRAY['played','home_score','away_score','home_aet','away_aet','home_pen','away_pen'];
    END IF;
    IF cardinality(v_skipped)>0 THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind','game','external_id',v_id::text,'reason','manual fixture fields conflict with provider','evidence',jsonb_build_object('fields',to_jsonb(v_skipped),'current',(SELECT jsonb_object_agg(k,v_current->k) FROM unnest(v_skipped) k),'proposed',(SELECT jsonb_object_agg(k,v_typed->k) FROM unnest(v_skipped) k))));
      v_soft_conflicts := v_soft_conflicts+1;
      v_typed := v_typed - v_skipped;
    END IF;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('table',v_table,'id',v_id,'fields',v_typed));
  END LOOP;
  IF v_game IS NOT NULL AND NOT EXISTS (SELECT 1 FROM game g JOIN phase p ON p.id = g.phase_id WHERE g.id = v_game AND p.championship_id = v_championship)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table' = 'game' AND (q->>'id')::uuid = v_game) THEN
    RAISE EXCEPTION 'event game outside source';
  END IF;
  IF v_game IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sofa.binding WHERE entity_kind='game' AND external_id=v_event AND local_id=v_game AND state='confirmed')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch->'bindings') q WHERE q->>'kind'='game' AND q->>'external_id'=v_event AND coalesce((q->>'local_id')::uuid,v_game)=v_game) THEN
    RAISE EXCEPTION 'event game is not bound';
  END IF;
  IF v_game IS NOT NULL THEN PERFORM 1 FROM game WHERE id=v_game FOR UPDATE; END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_patch->'bindings') LOOP
    v_kind := b->>'kind'; v_external := b->>'external_id'; v_target := (b->>'local_id')::uuid;
    IF v_kind = 'game' AND v_target IS NULL THEN v_target := v_game; END IF;
    IF (v_kind IS NULL OR v_kind NOT IN ('game','player','team')) OR v_external IS NULL OR v_external !~ '^[1-9][0-9]*$' OR v_target IS NULL THEN RAISE EXCEPTION 'invalid binding'; END IF;
    IF v_kind='game' AND (v_external <> v_event OR v_target IS DISTINCT FROM v_game) THEN RAISE EXCEPTION 'binding outside event'; END IF;
    IF EXISTS (SELECT 1 FROM sofa.binding WHERE entity_kind=v_kind AND (external_id=v_external OR local_id=v_target) AND (external_id<>v_external OR local_id<>v_target OR state<>'confirmed')) THEN RAISE EXCEPTION 'conflicting binding'; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table'=v_kind AND (q->>'id')::uuid=v_target) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id=$1)',v_kind) INTO v_exists USING v_target;
      IF NOT v_exists THEN RAISE EXCEPTION 'binding target does not exist'; END IF;
    END IF;
  END LOOP;
  FOR c IN SELECT value FROM jsonb_array_elements(p_patch->'collections') LOOP
    v_table := c->>'table'; v_game_id := (c->>'game_id')::uuid;
    IF (v_table IS NULL OR v_table NOT IN ('player_game','goal','substitution')) OR v_game_id IS DISTINCT FROM v_game OR v_game IS NULL OR jsonb_typeof(c->'ids') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid collection'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_patch->'collections') q WHERE q->>'table'=v_table AND q->>'game_id'=v_game::text) <> 1 THEN RAISE EXCEPTION 'duplicate collection'; END IF;
    SELECT jsonb_set(c,'{ids}',coalesce(jsonb_agg(to_jsonb(coalesce(v_id_map->>(v_table || ':' || i::uuid::text),i::uuid::text))),'[]'::jsonb))
      INTO c FROM jsonb_array_elements_text(c->'ids') i;
    IF (SELECT count(*) <> count(DISTINCT i) FROM jsonb_array_elements_text(c->'ids') i) THEN RAISE EXCEPTION 'duplicate collection ID'; END IF;
    v_collections := v_collections || jsonb_build_array(c);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(c->'ids') i WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table'=v_table AND (q->>'id')::uuid=i::uuid AND (q->'fields'->>'game_id')::uuid=v_game)) THEN RAISE EXCEPTION 'collection contains unrepresented row'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) q WHERE q->>'table'=v_table AND NOT (c->'ids' ? (q->>'id'))) THEN RAISE EXCEPTION 'collection omits patch row'; END IF;
    FOR v_current IN EXECUTE format(
      'SELECT to_jsonb(t) FROM public.%I t WHERE t.game_id=$1 AND NOT ($2 ? t.id::text) AND NOT EXISTS (SELECT 1 FROM sofa.baseline b WHERE b.table_name=$3 AND b.local_id=t.id AND b.source_id=$4 AND NOT b.removed) FOR UPDATE OF t',v_table)
      USING v_game,c->'ids',v_table,v_source LOOP
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind',v_table,'external_id',v_current->>'id','reason','unowned event detail requires review','evidence',jsonb_build_object('current',v_current)));
    END LOOP;
    FOR v_base IN SELECT * FROM sofa.baseline WHERE table_name=v_table AND source_id=v_source AND NOT removed FOR UPDATE LOOP
      IF c->'ids' ? v_base.local_id::text THEN CONTINUE; END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 FOR UPDATE',v_table) INTO v_current USING v_base.local_id;
      IF v_current IS NULL OR (v_current->>'game_id')::uuid IS DISTINCT FROM v_game THEN CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(v_base.fields) f WHERE v_current->f.key IS DISTINCT FROM f.value) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('kind',v_table,'external_id',v_base.local_id::text,'reason','manual change prevents provider retraction','evidence',jsonb_build_object('current',v_current,'baseline',v_base.fields)));
      END IF;
    END LOOP;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements((p_patch->'reviews') || v_conflicts) LOOP
    v_kind := x->>'kind'; v_external := x->>'external_id'; v_reason := x->>'reason'; v_evidence := x->'evidence';
    IF v_kind IS NULL OR v_external IS NULL OR v_reason IS NULL OR jsonb_typeof(v_evidence) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid review'; END IF;
    PERFORM sofa.review_item(v_source,v_kind,v_external,v_reason,v_evidence);
  END LOOP;
  IF jsonb_array_length(v_conflicts) > v_soft_conflicts OR (jsonb_array_length(v_conflicts)>0 AND jsonb_array_length(p_patch->'collections')>0) THEN
    RETURN jsonb_build_object('applied',false,'result_ready',false,'conflicts',jsonb_array_length(v_conflicts));
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(v_rows) ORDER BY CASE value->>'table' WHEN 'game' THEN 1 WHEN 'player' THEN 2 WHEN 'team_player' THEN 3 ELSE 4 END LOOP
    v_table := r->>'table'; v_id := (r->>'id')::uuid; v_fields := r->'fields';
    IF v_fields = '{}'::jsonb THEN CONTINUE; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',v_table) INTO v_current USING v_id;
    SELECT string_agg(format('%I',key),',' ORDER BY key), string_agg(format('typed.%I',key),',' ORDER BY key), string_agg(format('%1$I=typed.%1$I',key),',' ORDER BY key)
      INTO v_columns,v_values,v_sets FROM jsonb_object_keys(v_fields) key;
    IF v_current IS NULL THEN
      EXECUTE format('INSERT INTO public.%I (id,%s) SELECT $1,%s FROM jsonb_populate_record(NULL::public.%I,$2) typed',v_table,v_columns,v_values,v_table) USING v_id,v_fields;
      v_count := v_count+1;
    ELSIF EXISTS (SELECT 1 FROM jsonb_each(v_fields) f WHERE v_current->f.key IS DISTINCT FROM f.value) THEN
      EXECUTE format('UPDATE public.%I AS target SET %s FROM jsonb_populate_record(NULL::public.%I,$2) typed WHERE target.id=$1',v_table,v_sets,v_table) USING v_id,v_fields;
      v_count := v_count+1;
    END IF;
    INSERT INTO sofa.baseline(table_name,local_id,source_id,fields,removed) VALUES(v_table,v_id,v_source,v_fields,false)
    ON CONFLICT(table_name,local_id) DO UPDATE SET fields=sofa.baseline.fields || EXCLUDED.fields,removed=false;
    IF v_table='game' AND (v_fields ? 'day' OR v_fields ? 'kickoff') THEN
      UPDATE sofa.review review SET resolved=true
      WHERE review.source_id=v_source AND review.kind='game' AND review.external_id=v_id::text
        AND NOT review.resolved AND review.reason='manual fixture fields conflict with provider'
        AND CASE WHEN jsonb_typeof(review.evidence->'fields')='array' THEN
          jsonb_array_length(review.evidence->'fields')>0 AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(review.evidence->'fields') field
            WHERE field NOT IN ('day','kickoff') OR NOT (v_fields ? field)
          ) ELSE false END;
    END IF;
  END LOOP;
  FOR b IN SELECT value FROM jsonb_array_elements(p_patch->'bindings') LOOP
    INSERT INTO sofa.binding(entity_kind,external_id,local_id,provenance,evidence,state)
      VALUES(b->>'kind',b->>'external_id',CASE WHEN b->>'kind'='game' THEN coalesce((b->>'local_id')::uuid,v_game) ELSE (b->>'local_id')::uuid END,'sofascore',p_evidence,'confirmed')
      ON CONFLICT(entity_kind,external_id) DO NOTHING;
  END LOOP;
  FOR c IN SELECT value FROM jsonb_array_elements(v_collections) LOOP
    v_table := c->>'table';
    FOR v_base IN SELECT * FROM sofa.baseline WHERE table_name=v_table AND source_id=v_source AND NOT removed FOR UPDATE LOOP
      IF c->'ids' ? v_base.local_id::text THEN CONTINUE; END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 FOR UPDATE',v_table) INTO v_current USING v_base.local_id;
      IF v_current IS NULL OR (v_current->>'game_id')::uuid IS DISTINCT FROM v_game THEN CONTINUE; END IF;
      EXECUTE format('DELETE FROM public.%I WHERE id=$1',v_table) USING v_base.local_id;
      UPDATE sofa.baseline SET removed=true WHERE table_name=v_table AND local_id=v_base.local_id;
      v_count := v_count+1;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('applied',true,'result_ready',v_result_ready,'rows_changed',v_count,'conflicts',jsonb_array_length(v_conflicts));
END $$;
REVOKE ALL ON FUNCTION sofa.apply_source_patch(uuid,jsonb,jsonb) FROM PUBLIC;

-- Requests and their observations replace the coordinator's attempts.
DROP FUNCTION IF EXISTS sofa.apply_patch(uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS sofa.reject_parse(uuid,uuid,text);
DROP FUNCTION IF EXISTS sofa.finish(uuid,uuid,timestamptz,text,jsonb,timestamptz);
DROP FUNCTION IF EXISTS sofa.record_response(uuid,uuid,jsonb,timestamptz);
DROP FUNCTION IF EXISTS sofa.claim();
DROP FUNCTION IF EXISTS sofa.plan();
DROP VIEW IF EXISTS sofa.status;
DROP TABLE IF EXISTS sofa.attempt;
CREATE VIEW sofa.status AS
 SELECT s.id,s.championship_id,s.unique_tournament_id,s.season_id,s.enabled,s.detail_after,
 (SELECT count(*) FROM sofa.resource r JOIN hybrid_sofa_resource.instance i ON i.id=r.id WHERE r.source_id=s.id AND i.state->>'phase'='due') AS overdue,
 (SELECT to_timestamp(min((i.state->>'due')::bigint)/1000.0) FROM sofa.resource r JOIN hybrid_sofa_resource.instance i ON i.id=r.id
  WHERE r.source_id=s.id AND (i.state->>'due')::bigint>0) AS next_due_at,
 (SELECT max(last_success_at) FROM sofa.resource r WHERE r.source_id=s.id) AS last_success_at,
 (SELECT count(*) FROM sofa.review v WHERE v.source_id=s.id AND NOT resolved) AS reviews,
 (SELECT coalesce(sum(greatest(coalesce((o.response->>'requests')::integer,1),1)),0) FROM sofa.observation o WHERE o.source_id=s.id) AS requests,
 (SELECT coalesce(sum(octet_length(o.response->>'body')),0) FROM sofa.observation o WHERE o.source_id=s.id) AS payload_bytes,
 s.event_scope
 FROM sofa.source s;
REVOKE ALL ON sofa.status FROM PUBLIC;

-- A request's answer, in the commit that records it. A parse or apply that
-- raises fails that commit.
-- The source budget counts provider requests: admission spends one per
-- request, and an answer that followed redirects pays for the rest.
CREATE OR REPLACE FUNCTION sofa.charge(p_outcome jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v_extra integer := greatest(coalesce((p_outcome->'data'->>'requests')::integer,1)-1,0);
BEGIN
 IF v_extra=0 THEN RETURN; END IF;
 UPDATE sofa.control SET budget_minute=date_trunc('minute',clock_timestamp()),used=v_extra
  WHERE id AND budget_minute<>date_trunc('minute',clock_timestamp());
 IF NOT FOUND THEN UPDATE sofa.control SET used=used+v_extra WHERE id; END IF;
END $$;
REVOKE ALL ON FUNCTION sofa.charge(jsonb) FROM PUBLIC;

-- Due resources become requests, each at its source's next sequence, while
-- the provider is open and the minute's budget lasts: results first, then the
-- inventory, then details.
CREATE OR REPLACE FUNCTION sofa.admit() RETURNS integer
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE c sofa.control; r record; v_seq bigint; v_request uuid; total integer := 0;
BEGIN
 IF sofa.provider()->>'phase'<>'open' THEN RETURN 0; END IF;
 SELECT * INTO c FROM sofa.control WHERE id FOR UPDATE;
 IF c.budget_minute<>date_trunc('minute',clock_timestamp()) THEN
  UPDATE sofa.control SET budget_minute=date_trunc('minute',clock_timestamp()),used=0 WHERE id RETURNING * INTO c;
 END IF;
 FOR r IN SELECT res.* FROM sofa.resource res JOIN sofa.source s ON s.id=res.source_id
  JOIN hybrid_sofa_resource.instance i ON i.id=res.id
  WHERE s.enabled AND i.state->>'phase'='due'
  ORDER BY res.priority,(i.state->>'due')::bigint LIMIT greatest(c.minute_limit-c.used,0) FOR UPDATE OF res SKIP LOCKED LOOP
  UPDATE sofa.source SET next_seq=next_seq+1 WHERE id=r.source_id RETURNING next_seq INTO v_seq;
  INSERT INTO public.sofa_request(source_id,resource_id,family,resource_key,path,seq,status)
  VALUES(r.source_id,r.id,r.family,r.resource_key,r.path,v_seq,'acquiring') RETURNING id INTO v_request;
  PERFORM sofa.tell(r.id,'admitted',jsonb_build_object('request',v_request::text));
  total := total+1;
 END LOOP;
 UPDATE sofa.control SET used=used+total WHERE id;
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION sofa.admit() FROM PUBLIC;

-- Ids a pure function cannot know: the same parts always name the same row.
CREATE OR REPLACE FUNCTION sofa.derived_id(p_parts jsonb) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT substr(encode(sha256(convert_to(p_parts::text,'UTF8')),'hex'),1,32)::uuid $$;
CREATE OR REPLACE FUNCTION sofa.derive_ids(p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=sofa,public,pg_temp AS $$
DECLARE v_out jsonb;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  IF (SELECT array_agg(k) FROM jsonb_object_keys(p_value) k)=ARRAY['derive'] AND jsonb_typeof(p_value->'derive')='array' THEN
   RETURN to_jsonb(sofa.derived_id(sofa.derive_ids(p_value->'derive'))::text);
  END IF;
  SELECT coalesce(jsonb_object_agg(key,sofa.derive_ids(value)),'{}') INTO v_out FROM jsonb_each(p_value);
  RETURN v_out;
 ELSIF jsonb_typeof(p_value)='array' THEN
  SELECT coalesce(jsonb_agg(sofa.derive_ids(value) ORDER BY n),'[]') INTO v_out FROM jsonb_array_elements(p_value) WITH ORDINALITY x(value,n);
  RETURN v_out;
 END IF;
 RETURN p_value;
END $$;

-- When a resource is owed again (tools/sofascore/schedule.py's rules).
DROP FUNCTION IF EXISTS sofa.round_due(jsonb,timestamptz);
DROP FUNCTION IF EXISTS sofa.detail_due(jsonb,boolean,timestamptz);
DROP FUNCTION IF EXISTS sofa.retry_at(jsonb,integer,timestamptz);
DROP FUNCTION IF EXISTS sofa.cache_until(jsonb,timestamptz);
CREATE OR REPLACE FUNCTION sofa.quote(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT string_agg(CASE WHEN chr(b) ~ '^[A-Za-z0-9_.~-]$' THEN chr(b) ELSE '%'||upper(lpad(to_hex(b),2,'0')) END,'' ORDER BY n)
 FROM (SELECT get_byte(convert_to(p_text,'UTF8'),i) AS b,i AS n FROM generate_series(0,octet_length(convert_to(p_text,'UTF8'))-1) i) x
$$;
CREATE OR REPLACE FUNCTION sofa.round_path(p_tournament bigint,p_season bigint,p_info jsonb,p_page integer DEFAULT 0) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_round integer := (p_info->>'round')::integer; v_path text;
BEGIN
 IF v_round IS NULL OR v_round<1 THEN RAISE EXCEPTION 'invalid round'; END IF;
 v_path := format('unique-tournament/%s/season/%s/events/round/%s',p_tournament,p_season,v_round);
 IF nullif(p_info->>'slug','') IS NOT NULL THEN v_path := v_path||'/slug/'||sofa.quote(p_info->>'slug'); END IF;
 IF nullif(p_info->>'prefix','') IS NOT NULL THEN v_path := v_path||'/prefix/'||sofa.quote(p_info->>'prefix'); END IF;
 IF coalesce(p_page,0)>0 THEN v_path := v_path||'?page='||p_page; END IF;
 RETURN v_path;
END $$;

-- A resource, made once with its instance; owing fixtures, it is first due
-- when the soonest of them is, otherwise at p_due, no later than the
-- transaction's instant that its steps read as now.
DROP FUNCTION IF EXISTS sofa.put_resource(uuid,text,text,jsonb,timestamptz,integer);
CREATE OR REPLACE FUNCTION sofa.put_resource(p_source uuid,p_family text,p_key text,p_meta jsonb,p_due timestamptz,p_priority integer,p_owed jsonb DEFAULT '[]')
RETURNS uuid LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
 INSERT INTO sofa.resource(source_id,family,resource_key,path,meta,priority)
 VALUES(p_source,p_family,p_key,p_key,p_meta,p_priority) ON CONFLICT(source_id,resource_key) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  SELECT id INTO STRICT v_id FROM sofa.resource WHERE source_id=p_source AND resource_key=p_key;
  RETURN v_id;
 END IF;
 PERFORM hybrid_sofa_resource.spawn(v_id,jsonb_build_object('family',p_family,'due',sofa.ms(least(p_due,now())),'owed',sofa.owed(p_owed)),
  jsonb_build_object('service',sofa.service_actor()));
 RETURN v_id;
END $$;
-- The phases a round descriptor names, and its still-owed games.
CREATE OR REPLACE FUNCTION sofa.round_phases(p_source uuid,p_info jsonb) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path=sofa,public,pg_temp AS $$
 SELECT phase_id FROM sofa.stage_binding WHERE source_id=p_source
  AND CASE WHEN position('|' IN stage_key)>0 THEN substr(stage_key,position('|' IN stage_key)+1)::jsonb ELSE '{}' END
   = jsonb_strip_nulls(jsonb_build_object('slug',nullif(p_info->>'slug',''),'prefix',nullif(p_info->>'prefix','')))
$$;
CREATE OR REPLACE FUNCTION sofa.round_games(p_source uuid,p_info jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('status','scheduled','day',g.day,'kickoff',g.kickoff,'external_id',b.external_id)),'[]')
 FROM game g LEFT JOIN sofa.binding b ON b.entity_kind='game' AND b.local_id=g.id AND b.state='confirmed'
 WHERE g.phase_id IN (SELECT sofa.round_phases(p_source,p_info))
  AND (nullif(p_info->>'slug','') IS NOT NULL OR nullif(p_info->>'prefix','') IS NOT NULL OR g.round=(p_info->>'round')::integer)
  AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded')
$$;

-- A round inventory owes the rounds still in play: the current one, those with
-- a local fixture pending, and later ones; a completed phase owes nothing.
CREATE OR REPLACE FUNCTION sofa.receive_rounds(p_src sofa.source,p_body jsonb,p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE v_info jsonb; v_current integer; v_relevant jsonb; v_first timestamptz; v_path text; v_unresolved boolean;
BEGIN
 IF p_src.event_scope='fixtures' THEN RETURN jsonb_build_object('owed','[]'::jsonb,'kept',false,'terminal',false,'unresolved',false); END IF;
 IF jsonb_typeof(p_body->'rounds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'missing round inventory'; END IF;
 v_current := (p_body->'currentRound'->>'round')::integer;
 SELECT EXISTS(SELECT 1 FROM game g JOIN phase p ON p.id=g.phase_id WHERE p.championship_id=p_src.championship_id
  AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded')) INTO v_unresolved;
 FOR v_info IN SELECT value FROM jsonb_array_elements(p_body->'rounds') LOOP
  IF EXISTS(SELECT 1 FROM game g WHERE g.phase_id IN (SELECT sofa.round_phases(p_src.id,v_info)))
   AND NOT EXISTS(SELECT 1 FROM game g WHERE g.phase_id IN (SELECT sofa.round_phases(p_src.id,v_info))
    AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded')) THEN CONTINUE; END IF;
  v_relevant := sofa.round_games(p_src.id,v_info);
  IF v_relevant='[]' AND (v_current IS NULL OR (v_info->>'round')::integer<v_current) THEN CONTINUE; END IF;
  v_path := sofa.round_path(p_src.unique_tournament_id,p_src.season_id,v_info);
  PERFORM sofa.put_resource(p_src.id,'round',v_path,jsonb_build_object('round',v_info,'page',0),p_now,0,
   CASE WHEN v_relevant<>'[]' AND (v_info->>'round')::integer IS DISTINCT FROM v_current THEN v_relevant ELSE '[]' END);
 END LOOP;
 RETURN jsonb_build_object('owed','[]'::jsonb,'kept',false,'terminal',false,'unresolved',v_unresolved);
END $$;

-- A round's or an event's events: each is reconciled and applied, its snapshot
-- kept, and its details owed when it is a played final the source may detail.
CREATE OR REPLACE FUNCTION sofa.receive_events(p_src sofa.source,p_res sofa.resource,p_request uuid,p_body jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE
 v_raw jsonb; v_events jsonb; v_ids jsonb; v_ctx jsonb; v_reconciled jsonb; v_patch jsonb; v_event jsonb; v_result jsonb;
 v_saved sofa.event; v_eligible boolean; v_kickoff timestamptz; v_accepted text[] := '{}'; v_changed boolean; v_queue boolean;
 v_kept jsonb; v_pending jsonb := '[]'; v_unresolved boolean := false; v_meta jsonb := p_res.meta;
 v_detail text; v_key text; v_page integer; v_detail_id uuid;
BEGIN
 v_raw := CASE p_res.family WHEN 'round' THEN p_body->'events' ELSE jsonb_build_array(p_body->'event') END;
 v_events := public.fn_sofascore_normalize(jsonb_build_object('kind','events','payload',jsonb_build_object('events',v_raw)));
 SELECT coalesce(jsonb_agg(e || jsonb_build_object('day',sofa.event_day(e)) ORDER BY n),'[]') INTO v_events
 FROM jsonb_array_elements(v_events) WITH ORDINALITY x(e,n);
 SELECT coalesce(jsonb_agg(DISTINCT id),'[]') INTO v_ids FROM jsonb_array_elements(v_events) e,
  LATERAL (VALUES (e->>'external_id'),(e->>'home_external_id'),(e->>'away_external_id')) v(id) WHERE id IS NOT NULL;
 v_ctx := jsonb_build_object(
  'bindings',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',b.entity_kind,'external_id',b.external_id,'local_id',b.local_id)),'[]')
   FROM sofa.binding b WHERE b.state='confirmed' AND b.entity_kind IN ('team','game') AND v_ids ? b.external_id),
  'stages',(SELECT coalesce(jsonb_object_agg(stage_key,phase_id),'{}') FROM sofa.stage_binding WHERE source_id=p_src.id),
  'games',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'external_id',b.external_id,'phase_id',g.phase_id,
     'home_id',g.home_id,'away_id',g.away_id,'played',g.played,'sync_status',g.sync_status)),'[]')
   FROM game g JOIN phase p ON p.id=g.phase_id
   LEFT JOIN sofa.binding b ON b.entity_kind='game' AND b.local_id=g.id AND b.state='confirmed'
   WHERE p.championship_id=p_src.championship_id));
 v_reconciled := public.fn_sofascore_reconcile(jsonb_build_object('family',p_res.family,
  'source',jsonb_build_object('unique_tournament_id',p_src.unique_tournament_id,'season_id',p_src.season_id,'event_scope',p_src.event_scope),
  'requested_event',CASE WHEN p_res.family='event' THEN nullif(split_part(p_res.resource_key,'/',2),'') END,
  'raw_events',v_raw,'events',v_events,'ctx',v_ctx));
 v_kept := v_reconciled->'events';
 UPDATE sofa.observation SET normalized=v_kept WHERE request_id=p_request;
 FOR v_patch IN SELECT value FROM jsonb_array_elements(v_reconciled->'patches') LOOP
  v_event := v_patch->'event';
  SELECT * INTO v_saved FROM sofa.event WHERE source_id=p_src.id AND external_id=v_event->>'external_id';
  v_kickoff := (v_event->>'kickoff')::timestamptz;
  v_eligible := coalesce(v_saved.details_eligible,false) OR v_event->>'status'='in_progress'
   OR coalesce(v_kickoff>=p_src.detail_after,false)
   OR (coalesce(v_kickoff>=p_src.detail_after-interval '6 hours',false) AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_ctx->'games') g WHERE g->>'external_id'=v_event->>'external_id' AND NOT (g->>'played')::boolean));
  IF v_eligible THEN
   INSERT INTO sofa.event(source_id,external_id,snapshot,details_eligible) VALUES(p_src.id,v_event->>'external_id','{}',true)
   ON CONFLICT(source_id,external_id) DO UPDATE SET details_eligible=true WHERE NOT sofa.event.details_eligible;
  END IF;
  v_result := sofa.apply_source_patch(p_src.id,v_patch,jsonb_build_object('request',p_request));
  IF NOT (v_result->>'applied')::boolean OR ((v_event->>'played')::boolean AND NOT (v_result->>'result_ready')::boolean) THEN CONTINUE; END IF;
  IF (v_event->>'terminal')::boolean AND jsonb_array_length(v_patch->'reviews')=0
   AND (v_event->>'status'<>'finished' OR (v_event->>'played')::boolean) THEN v_accepted := v_accepted||(v_event->>'external_id'); END IF;
  v_changed := v_saved.snapshot IS NOT NULL AND v_saved.snapshot<>'{}' AND EXISTS(SELECT 1 FROM unnest(ARRAY['home_score','away_score','home_aet','away_aet','home_pen','away_pen']) k
   WHERE v_saved.snapshot->k IS DISTINCT FROM v_event->k);
  v_queue := v_event->>'status'='finished' AND (v_event->>'played')::boolean AND v_eligible
   AND (jsonb_array_length(v_patch->'rows')>0 OR jsonb_array_length(v_patch->'reviews')=0);
  INSERT INTO sofa.event(source_id,external_id,snapshot,details_eligible) VALUES(p_src.id,v_event->>'external_id',v_event,v_eligible)
  ON CONFLICT(source_id,external_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,details_eligible=sofa.event.details_eligible OR EXCLUDED.details_eligible
  WHERE sofa.event.snapshot IS DISTINCT FROM EXCLUDED.snapshot OR EXCLUDED.details_eligible AND NOT sofa.event.details_eligible;
  IF v_queue THEN
   FOREACH v_detail IN ARRAY ARRAY['lineups','incidents'] LOOP
    v_key := 'event/'||(v_event->>'external_id')||'/'||v_detail;
    v_detail_id := sofa.put_resource(p_src.id,v_detail,v_key,jsonb_build_object('event_id',v_event->>'external_id'),p_now,5);
    -- A corrected final asks its details again from the start.
    IF v_changed THEN PERFORM sofa.tell(v_detail_id,'reopened','{}'); END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF p_res.family='round' THEN
  SELECT coalesce(jsonb_agg(g),'[]') INTO v_pending FROM jsonb_array_elements(sofa.round_games(p_src.id,v_meta->'round')) g
   WHERE NOT (g->>'external_id' = ANY(v_accepted)) OR g->>'external_id' IS NULL;
  v_unresolved := EXISTS(SELECT 1 FROM jsonb_array_elements(v_kept) e
   WHERE NOT (e->>'terminal')::boolean OR (e->>'status'='finished' AND NOT (e->>'played')::boolean)) OR v_pending<>'[]';
 ELSE
  v_unresolved := EXISTS(SELECT 1 FROM jsonb_array_elements(v_kept) e WHERE NOT (e->>'external_id' = ANY(v_accepted)));
 END IF;
 IF p_res.family='round' AND p_src.event_scope<>'fixtures' AND p_body->'hasNextPage'='true'::jsonb THEN
  v_page := coalesce((v_meta->>'page')::integer,0)+1;
  v_key := sofa.round_path(p_src.unique_tournament_id,p_src.season_id,v_meta->'round',v_page);
  PERFORM sofa.put_resource(p_src.id,'round',v_key,jsonb_build_object('round',v_meta->'round','page',v_page),p_now,0);
 END IF;
 IF v_kept<>'[]' AND p_res.family='round' THEN
  v_meta := v_meta||jsonb_build_object('events',(SELECT jsonb_agg(e->'external_id') FROM jsonb_array_elements(v_kept) e));
 END IF;
 RETURN jsonb_build_object('owed',v_kept||v_pending,'kept',v_kept<>'[]','meta',v_meta,'unresolved',v_unresolved,
  'terminal',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_kept) e WHERE NOT (e->>'terminal')::boolean));
END $$;

-- An event's lineups and incidents apply together: the detail that completes
-- the pair parses both with the event it belongs to.
CREATE OR REPLACE FUNCTION sofa.receive_details(p_src sofa.source,p_res sofa.resource,p_body jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE
 v_event_id text := p_res.meta->>'event_id'; v_other text := CASE p_res.family WHEN 'lineups' THEN 'incidents' ELSE 'lineups' END;
 v_partner sofa.current; v_partner_res sofa.resource; v_snapshot jsonb; v_other_body jsonb; v_detail jsonb; v_patch jsonb;
 v_result jsonb; v_complete boolean := false; v_ids jsonb; v_names text[]; v_ctx jsonb;
BEGIN
 SELECT snapshot INTO v_snapshot FROM sofa.event WHERE source_id=p_src.id AND external_id=v_event_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'detail has no retained event'; END IF;
 SELECT * INTO v_partner FROM sofa.current WHERE source_id=p_src.id AND resource_key='event/'||v_event_id||'/'||v_other;
 IF FOUND THEN
  v_other_body := (v_partner.response->>'body')::jsonb;
  v_detail := public.fn_sofascore_normalize(jsonb_build_object('kind','details',
   'lineups',CASE p_res.family WHEN 'lineups' THEN p_body ELSE v_other_body END,
   'incidents',CASE p_res.family WHEN 'incidents' THEN p_body ELSE v_other_body END,'event',v_snapshot));
  SELECT coalesce(jsonb_agg(DISTINCT p->>'external_id'),'[]'),
   coalesce(array_agg(DISTINCT normalize(lower(regexp_replace(trim(n),'\s+',' ','g')),NFKC)) FILTER (WHERE nullif(trim(n),'') IS NOT NULL),'{}')
  INTO v_ids,v_names FROM jsonb_array_elements(v_detail->'players') p, LATERAL (VALUES (p->>'name'),(p->>'full_name')) x(n);
  v_ctx := jsonb_build_object(
   'bindings',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',b.entity_kind,'external_id',b.external_id,'local_id',b.local_id)),'[]')
    FROM sofa.binding b WHERE b.state='confirmed' AND (b.entity_kind='player' AND v_ids ? b.external_id
     OR b.entity_kind='game' AND b.external_id=v_event_id)),
   'stages','{}'::jsonb,
   'games',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'external_id',b.external_id,'phase_id',g.phase_id,
      'home_id',g.home_id,'away_id',g.away_id,'played',g.played,'sync_status',g.sync_status)),'[]')
    FROM sofa.binding b JOIN game g ON g.id=b.local_id WHERE b.entity_kind='game' AND b.state='confirmed' AND b.external_id=v_event_id),
   'players',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'full_name',p.full_name,'birth',p.birth,
      'country',p.country,'external_id',b.external_id)),'[]')
    FROM player p LEFT JOIN sofa.binding b ON b.entity_kind='player' AND b.local_id=p.id AND b.state='confirmed'
    WHERE v_ids ? b.external_id OR normalize(lower(regexp_replace(trim(p.name),'\s+',' ','g')),NFKC)=ANY(v_names)
     OR normalize(lower(regexp_replace(trim(p.full_name),'\s+',' ','g')),NFKC)=ANY(v_names)));
  v_patch := sofa.derive_ids(public.fn_sofascore_reconcile(jsonb_build_object('family','details',
   'source',jsonb_build_object('championship_id',p_src.championship_id,'create_players',p_src.create_players,
    'unique_tournament_id',p_src.unique_tournament_id,'season_id',p_src.season_id,'event_scope',p_src.event_scope),
   'detail',v_detail,'event',v_snapshot,'ctx',v_ctx)));
  v_result := sofa.apply_source_patch(p_src.id,v_patch,jsonb_build_object('detail',p_res.resource_key));
  v_complete := (v_detail->>'complete')::boolean AND jsonb_array_length(v_patch->'reviews')=0
   AND coalesce((v_result->>'conflicts')::integer,0)=0;
  SELECT * INTO v_partner_res FROM sofa.resource WHERE source_id=p_src.id AND resource_key='event/'||v_event_id||'/'||v_other FOR UPDATE;
  -- The pair's other half is complete too, and owes only its next-day check.
  IF v_complete AND FOUND AND (sofa.resource_state(v_partner_res.id)->>'complete_checks')::integer=0 THEN
   PERFORM sofa.tell(v_partner_res.id,'paired','{}');
  END IF;
 END IF;
 RETURN jsonb_build_object('owed','[]'::jsonb,'kept',false,'terminal',false,'complete',v_complete,'unresolved',false);
END $$;

-- A request the provider or the transport failed: its requests are paid for,
-- its resource backs off, a detail past five failures goes to review, and a
-- refusal pauses or blocks the provider.
CREATE OR REPLACE FUNCTION sofa.fail(p_resource uuid,p_outcome jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v_res sofa.resource; v_status integer := coalesce((p_outcome->'data'->>'status')::integer,0);
 v_after text := p_outcome->'data'->'headers'->>'retry-after'; v_retry bigint := 0; v_state jsonb;
BEGIN
 PERFORM sofa.charge(p_outcome);
 IF v_after ~ '^[0-9]+$' THEN v_retry := sofa.ms(clock_timestamp())+v_after::bigint*1000;
 ELSIF nullif(v_after,'') IS NOT NULL THEN v_retry := sofa.ms(v_after::timestamptz);
 END IF;
 UPDATE sofa.resource SET last_error=coalesce(p_outcome->'data'->>'error','status '||(p_outcome->'data'->>'status'),p_outcome->'data'->>'reason',p_outcome->>'kind')
 WHERE id=p_resource RETURNING * INTO STRICT v_res;
 v_state := sofa.tell(p_resource,'failed',jsonb_build_object('status',v_status,'retry_at',greatest(v_retry,0)));
 IF v_state->>'phase'='review' THEN
  PERFORM sofa.review_item(v_res.source_id,'details',v_res.resource_key,'detail HTTP retries exhausted',jsonb_build_object('status',v_status));
 END IF;
 IF v_status IN (401,403,429) THEN
  PERFORM sofa.provider('refused',jsonb_build_object('status',v_status,'until',CASE WHEN v_status=429 THEN (v_state->>'due')::bigint ELSE 0 END));
 END IF;
END $$;
REVOKE ALL ON FUNCTION sofa.fail(uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION sofa.receive(p_request uuid,p_source uuid,p_family text,p_key text,p_seq bigint,p_outcome jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE
 v_src sofa.source; v_res sofa.resource; v_body jsonb; v_now timestamptz := clock_timestamp(); v_step jsonb;
 v_ends date; v_state jsonb;
BEGIN
 PERFORM sofa.charge(p_outcome);
 INSERT INTO sofa.observation(request_id,source_id,family,resource_key,seq,response)
 VALUES(p_request,p_source,p_family,p_key,p_seq,p_outcome->'data');
 IF EXISTS(SELECT 1 FROM sofa.current WHERE source_id=p_source AND resource_key=p_key AND seq<>p_seq) THEN RETURN; END IF;
 SELECT * INTO STRICT v_src FROM sofa.source WHERE id=p_source;
 SELECT * INTO STRICT v_res FROM sofa.resource WHERE source_id=p_source AND resource_key=p_key FOR UPDATE;
 v_body := (p_outcome->'data'->>'body')::jsonb;
 IF jsonb_typeof(v_body) IS DISTINCT FROM 'object' OR v_body ? 'error' THEN RAISE EXCEPTION 'invalid source payload'; END IF;
 v_step := CASE
  WHEN p_family='rounds' THEN sofa.receive_rounds(v_src,v_body,v_now)
  WHEN p_family IN ('round','event') THEN sofa.receive_events(v_src,v_res,p_request,v_body,v_now)
  WHEN p_family IN ('lineups','incidents') THEN sofa.receive_details(v_src,v_res,v_body,v_now) END;
 IF v_step IS NULL THEN RAISE EXCEPTION 'unknown resource family'; END IF;
 SELECT ends INTO v_ends FROM championship WHERE id=v_src.championship_id;
 v_state := sofa.tell(v_res.id,'fetched',jsonb_build_object(
  'owed',sofa.owed(v_step->'owed'),'kept',coalesce((v_step->>'kept')::boolean,false),
  'terminal',coalesce((v_step->>'terminal')::boolean,false),'unresolved',coalesce((v_step->>'unresolved')::boolean,false),
  'fixtures',v_src.event_scope='fixtures','complete',coalesce((v_step->>'complete')::boolean,false),
  'max_age',coalesce((regexp_match(coalesce(p_outcome->'data'->'headers'->>'cache-control',''),'(?:^|,)\s*(?:s-maxage|max-age)=(\d+)'))[1]::integer,-1),
  'ends',coalesce(sofa.ms(v_ends::timestamptz),0)));
 IF v_state->>'phase'='review' THEN
  PERFORM sofa.review_item(v_src.id,'details',v_res.meta->>'event_id','detail retries exhausted',v_state);
 END IF;
 -- After its season a round left owing fixtures is audited weekly; each audit is a review.
 IF p_family IN ('rounds','round') AND v_src.event_scope<>'fixtures' AND v_ends IS NOT NULL
  AND v_now>=v_ends::timestamptz+interval '30 days' AND (v_step->>'unresolved')::boolean THEN
  PERFORM sofa.review_item(v_src.id,p_family,v_res.path,'stale season has unresolved fixtures',jsonb_build_object('resource',v_res.path));
 END IF;
 UPDATE sofa.resource SET meta=coalesce(v_step->'meta',v_res.meta),last_success_at=v_now,last_error=NULL WHERE id=v_res.id;
END $$;
REVOKE ALL ON FUNCTION sofa.receive(uuid,uuid,text,text,bigint,jsonb) FROM PUBLIC;

-- Enrolling a championship binds its source, first stage and round inventory;
-- a source's identity never changes once enrolled.
CREATE OR REPLACE FUNCTION sofa.enable(p_championship uuid,p_phase uuid,p_tournament bigint,p_season bigint,p_stage text,
 p_create_players boolean DEFAULT false,p_scope text DEFAULT 'competition') RETURNS sofa.source
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v_src sofa.source; v_path text := format('unique-tournament/%s/season/%s/rounds',p_tournament,p_season); v_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('sofascore-source-configuration'));
 IF NOT EXISTS(SELECT 1 FROM phase WHERE id=p_phase AND championship_id=p_championship) THEN RAISE EXCEPTION 'phase not in championship'; END IF;
 IF EXISTS(SELECT 1 FROM sofa.source WHERE championship_id=p_championship AND (unique_tournament_id<>p_tournament OR season_id<>p_season)) THEN
  RAISE EXCEPTION 'source identity is immutable'; END IF;
 IF EXISTS(SELECT 1 FROM sofa.stage_binding b JOIN sofa.source s ON s.id=b.source_id WHERE s.championship_id=p_championship
  AND b.stage_key=p_stage AND b.phase_id<>p_phase) THEN RAISE EXCEPTION 'stage binding conflict'; END IF;
 INSERT INTO sofa.source(championship_id,unique_tournament_id,season_id,enabled,create_players,event_scope)
 VALUES(p_championship,p_tournament,p_season,true,p_create_players,p_scope)
 ON CONFLICT(championship_id) DO UPDATE SET enabled=true,create_players=EXCLUDED.create_players,event_scope=EXCLUDED.event_scope
 RETURNING * INTO v_src;
 IF p_scope='fixtures' THEN
  PERFORM sofa.tell(r.id,'stopped','{}') FROM sofa.resource r WHERE r.source_id=v_src.id AND r.family IN ('rounds','round')
   AND sofa.resource_state(r.id)->>'phase'<>'done';
 END IF;
 INSERT INTO sofa.stage_binding(source_id,stage_key,phase_id) VALUES(v_src.id,p_stage,p_phase) ON CONFLICT DO NOTHING;
 IF p_scope<>'fixtures' THEN
  v_id := sofa.put_resource(v_src.id,'rounds',v_path,'{}',clock_timestamp(),1);
  -- Enabled again, an inventory that had finished starts over.
  IF sofa.resource_state(v_id)->>'phase'='done' THEN PERFORM sofa.tell(v_id,'reopened','{}'); END IF;
 END IF;
 RETURN v_src;
END $$;
REVOKE ALL ON FUNCTION sofa.enable(uuid,uuid,bigint,bigint,text,boolean,text) FROM PUBLIC;

-- A reviewed identity plan (tools/sofascore/identities.py recover) binds
-- provider ids to existing rows; a conflicting or missing target refuses the
-- whole plan, and the plan's own conflicts go to review.
CREATE OR REPLACE FUNCTION sofa.recover_bindings(p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE b jsonb; v_kind text; v_external text; v_local uuid; v_exists boolean; c jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('sofascore-identities'));
 FOR b IN SELECT value FROM jsonb_array_elements(p_plan->'candidate_bindings') LOOP
  v_kind := b->>'entity_kind'; v_external := b->>'external_id'; v_local := (b->>'local_id')::uuid;
  IF v_kind NOT IN ('team','player','game') THEN RAISE EXCEPTION 'invalid binding kind'; END IF;
  IF v_external !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'invalid binding id'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1)',v_kind) INTO v_exists USING v_local;
  IF NOT v_exists THEN RAISE EXCEPTION 'missing binding target'; END IF;
  IF EXISTS(SELECT 1 FROM sofa.binding WHERE entity_kind=v_kind AND (external_id=v_external AND local_id<>v_local OR local_id=v_local AND external_id<>v_external)) THEN
   RAISE EXCEPTION 'binding conflict'; END IF;
  INSERT INTO sofa.binding(entity_kind,external_id,local_id,provenance,evidence)
  VALUES(v_kind,v_external,v_local,coalesce(b->>'provenance',''),coalesce(b->'evidence','{}')) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(coalesce(p_plan->'conflicts','[]')) LOOP
  PERFORM sofa.review_item(NULL,'binding','','identity recovery conflict',c);
 END LOOP;
 RETURN jsonb_build_object('bindings',jsonb_array_length(p_plan->'candidate_bindings'),'conflicts',jsonb_array_length(coalesce(p_plan->'conflicts','[]')));
END $$;
REVOKE ALL ON FUNCTION sofa.recover_bindings(jsonb) FROM PUBLIC;

-- Fixture-scoped sources owe each pending bound fixture its own event.
CREATE OR REPLACE FUNCTION sofa.seed_fixtures(p_now timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE r record; v_key text; v_owed jsonb; v_id uuid;
BEGIN
 FOR r IN SELECT s.id AS source_id,g.day,g.kickoff,b.external_id FROM sofa.source s JOIN phase p ON p.championship_id=s.championship_id
  JOIN game g ON g.phase_id=p.id JOIN sofa.binding b ON b.entity_kind='game' AND b.local_id=g.id AND b.state='confirmed'
  WHERE s.enabled AND s.event_scope='fixtures' AND NOT g.played AND coalesce(g.sync_status,'') NOT IN ('cancelled','abandoned','awarded') LOOP
  IF r.external_id !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'invalid bound event id'; END IF;
  v_key := 'event/'||r.external_id;
  v_owed := jsonb_build_array(jsonb_build_object('status','scheduled','day',r.day,'kickoff',r.kickoff));
  v_id := sofa.put_resource(r.source_id,'event',v_key,jsonb_build_object('event_id',r.external_id),p_now,0,v_owed);
  PERFORM sofa.tell(v_id,'hasten',jsonb_build_object('owed',sofa.owed(v_owed)));
 END LOOP;
END $$;

-- Every minute: retention, sources past their season, requests that never
-- answered, fixture seeds, then admission.
CREATE OR REPLACE FUNCTION sofa.tick() RETURNS integer
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE v_now timestamptz := clock_timestamp(); r record;
BEGIN
 DELETE FROM public.sofa_tick WHERE tick_at<v_now-interval '7 days';
 UPDATE sofa.source s SET enabled=false FROM public.championship c WHERE c.id=s.championship_id AND s.enabled
  AND c.ends<current_date-30 AND NOT EXISTS(SELECT 1 FROM sofa.event e WHERE e.source_id=s.id AND e.snapshot->>'status' NOT IN ('finished','cancelled','abandoned','awarded'))
  AND NOT EXISTS(SELECT 1 FROM public.game g JOIN public.phase p ON p.id=g.phase_id WHERE p.championship_id=s.championship_id
   AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded'));
 FOR r IN UPDATE public.sofa_request q SET stuck_at=v_now WHERE q.status='acquiring' AND q.stuck_at IS NULL AND q.admitted_at<v_now-interval '30 minutes'
  RETURNING q.source_id,q.resource_key,q.id LOOP
  PERFORM sofa.review_item(r.source_id,'request',r.resource_key,'request never answered',jsonb_build_object('request',r.id));
 END LOOP;
 PERFORM sofa.seed_fixtures(v_now);
 RETURN sofa.admit();
END $$;
REVOKE ALL ON FUNCTION sofa.tick() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.refresh_sofascore_queue() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=sofa,public,pg_temp AS $$ SELECT sofa.tick() $$;
REVOKE ALL ON FUNCTION public.refresh_sofascore_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_sofascore_queue() TO service;
COMMIT;
