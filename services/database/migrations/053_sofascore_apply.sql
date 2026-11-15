BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
CREATE OR REPLACE FUNCTION sofa.apply_patch(p_attempt uuid, p_token uuid, p_patch jsonb)
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
  SELECT s.id, s.championship_id INTO v_source, v_championship
  FROM sofa.attempt a JOIN sofa.resource r ON r.id = a.resource_id
  JOIN sofa.source s ON s.id = r.source_id
  WHERE a.id = p_attempt AND a.token = p_token AND a.state = 'fetched'
  FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid or unfetched attempt'; END IF;
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
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch->'bindings') q WHERE q->>'kind'='game' AND q->>'external_id'=v_event AND (q->>'local_id')::uuid=v_game) THEN
    RAISE EXCEPTION 'event game is not bound';
  END IF;
  IF v_game IS NOT NULL THEN PERFORM 1 FROM game WHERE id=v_game FOR UPDATE; END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_patch->'bindings') LOOP
    v_kind := b->>'kind'; v_external := b->>'external_id'; v_target := (b->>'local_id')::uuid;
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
      VALUES(b->>'kind',b->>'external_id',(b->>'local_id')::uuid,'sofascore',jsonb_build_object('attempt',p_attempt),'confirmed')
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
REVOKE ALL ON FUNCTION sofa.apply_patch(uuid,uuid,jsonb) FROM PUBLIC;
COMMIT;
