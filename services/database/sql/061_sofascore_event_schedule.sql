SET lock_timeout='5s';
SET statement_timeout='120s';
DO $$ BEGIN
 IF to_regclass('public.schedule') IS NOT NULL THEN
  DELETE FROM public.schedule WHERE name='sofascore-minute';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION sofa.seed_fixtures(p_now timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE r record; v_key text; v_owed jsonb; v_meta jsonb; v_id uuid;
BEGIN
 FOR r IN SELECT s.id AS source_id,g.day,g.kickoff,b.external_id FROM sofa.source s JOIN phase p ON p.championship_id=s.championship_id
  JOIN game g ON g.phase_id=p.id JOIN sofa.binding b ON b.entity_kind='game' AND b.local_id=g.id AND b.state='confirmed'
  WHERE s.enabled AND s.event_scope='fixtures' AND NOT g.played AND coalesce(g.sync_status,'') NOT IN ('cancelled','abandoned','awarded') LOOP
  IF r.external_id !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'invalid bound event id'; END IF;
  v_key := 'event/'||r.external_id;
  v_owed := jsonb_build_array(jsonb_build_object('status','scheduled','day',r.day,'kickoff',r.kickoff));
  v_meta := jsonb_build_object('event_id',r.external_id,'day',r.day,'kickoff',r.kickoff);
  INSERT INTO sofa.resource(source_id,family,resource_key,path,meta,priority)
  VALUES(r.source_id,'event',v_key,v_key,v_meta,0) ON CONFLICT(source_id,resource_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
   PERFORM hybrid_sofa_resource.spawn(v_id,jsonb_build_object('family','event','due',sofa.ms(least(p_now,now())),'owed',sofa.owed(v_owed)),
    jsonb_build_object('service',sofa.service_actor()));
  ELSE
   UPDATE sofa.resource SET meta=meta||v_meta WHERE source_id=r.source_id AND resource_key=v_key
    AND (meta->'day' IS DISTINCT FROM v_meta->'day' OR meta->'kickoff' IS DISTINCT FROM v_meta->'kickoff')
    RETURNING id INTO v_id;
   IF v_id IS NOT NULL THEN
    PERFORM sofa.tell(v_id,'hasten',jsonb_build_object('owed',sofa.owed(v_owed)));
   END IF;
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION sofa.admit() RETURNS integer
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE c sofa.control; r record; v_seq bigint; v_request uuid; v_now timestamptz := clock_timestamp(); total integer := 0;
BEGIN
 IF sofa.provider()->>'phase'<>'open' THEN RETURN 0; END IF;
 SELECT * INTO c FROM sofa.control WHERE id FOR UPDATE;
 IF c.budget_minute<>date_trunc('minute',v_now) THEN
  UPDATE sofa.control SET budget_minute=date_trunc('minute',v_now),used=0 WHERE id RETURNING * INTO c;
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
 UPDATE sofa.control SET used=used+total WHERE id AND total>0;
 IF to_regclass('public.schedule') IS NOT NULL THEN
  IF c.used+total>=c.minute_limit AND EXISTS (
   SELECT 1 FROM sofa.resource res JOIN sofa.source s ON s.id=res.source_id
   JOIN hybrid_sofa_resource.instance i ON i.id=res.id
   WHERE s.enabled AND i.state->>'phase'='due'
  ) THEN
   INSERT INTO public.schedule(name,due_at,max_lateness_seconds,emits_entity,emits_values)
   VALUES('sofascore-budget',date_trunc('minute',v_now)+interval '1 minute',2147483647,'sofa_tick','{}'::jsonb)
   ON CONFLICT(name) DO UPDATE SET cron=NULL,due_at=EXCLUDED.due_at,max_lateness_seconds=EXCLUDED.max_lateness_seconds,
    emits_entity=EXCLUDED.emits_entity,emits_values=EXCLUDED.emits_values,suspended=false,last_tick_at=NULL
   WHERE public.schedule.due_at IS DISTINCT FROM EXCLUDED.due_at OR public.schedule.last_tick_at IS NOT NULL OR public.schedule.suspended;
  ELSE
   DELETE FROM public.schedule WHERE name='sofascore-budget';
  END IF;
 END IF;
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION sofa.admit() FROM PUBLIC;

CREATE OR REPLACE FUNCTION sofa.tick() RETURNS integer
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp SET timezone='UTC' AS $$
DECLARE v_now timestamptz := clock_timestamp(); r record;
BEGIN
 PERFORM 1 FROM sofa.control WHERE id FOR UPDATE;
 DELETE FROM public.sofa_tick WHERE tick_at<v_now-interval '7 days';
 UPDATE sofa.source s SET enabled=false FROM public.championship c WHERE c.id=s.championship_id AND s.enabled
  AND c.ends<current_date-30 AND NOT EXISTS(SELECT 1 FROM sofa.event e WHERE e.source_id=s.id AND e.snapshot->>'status' NOT IN ('finished','cancelled','abandoned','awarded'))
  AND NOT EXISTS(SELECT 1 FROM public.game g JOIN public.phase p ON p.id=g.phase_id WHERE p.championship_id=s.championship_id
   AND NOT g.played AND coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded'));
 FOR r IN UPDATE public.sofa_request q SET stuck_at=v_now WHERE q.id IN (
  SELECT id FROM public.sofa_request WHERE status='acquiring' AND stuck_at IS NULL AND admitted_at<v_now-interval '30 minutes' FOR UPDATE SKIP LOCKED)
  RETURNING q.source_id,q.resource_key,q.id LOOP
  PERFORM sofa.review_item(r.source_id,'request',r.resource_key,'request never answered',jsonb_build_object('request',r.id));
 END LOOP;
 PERFORM sofa.seed_fixtures(v_now);
 IF to_regclass('hybrid_sofa_provider.instance') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM hybrid_sofa_provider.instance i WHERE i.id=sofa.provider_id()
   AND i.state->>'phase'='blocked' AND (i.state->>'until')::bigint>0 AND (i.state->>'until')::bigint<=sofa.ms(v_now)) THEN
   PERFORM hybrid_sofa_provider.wake(sofa.provider_id(),sofa.ms(v_now));
  END IF;
 END IF;
 IF to_regclass('sofa.resource') IS NOT NULL AND to_regclass('hybrid_sofa_resource.instance') IS NOT NULL THEN
  FOR r IN SELECT res.id FROM sofa.resource res JOIN sofa.source s ON s.id=res.source_id
   JOIN hybrid_sofa_resource.instance i ON i.id=res.id
   WHERE s.enabled AND i.state->>'phase' IN ('acquiring','idle','backoff')
    AND (i.state->>'due')::bigint>0 AND (i.state->>'due')::bigint<=sofa.ms(v_now) LOOP
   PERFORM hybrid_sofa_resource.wake(r.id,sofa.ms(v_now));
  END LOOP;
 END IF;
 RETURN sofa.admit();
END $$;
REVOKE ALL ON FUNCTION sofa.tick() FROM PUBLIC;
