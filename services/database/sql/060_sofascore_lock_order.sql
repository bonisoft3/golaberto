SET lock_timeout='5s';
SET statement_timeout='120s';
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
 RETURN sofa.admit();
END $$;
