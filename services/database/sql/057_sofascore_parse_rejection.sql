BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
CREATE OR REPLACE FUNCTION sofa.reject_parse(p_id uuid,p_token uuid,p_error text) RETURNS void
LANGUAGE plpgsql SET search_path=sofa,public,pg_temp AS $$
DECLARE v_resource_id uuid;
BEGIN
 UPDATE sofa.attempt a SET state='failed',error=p_error WHERE a.id=p_id AND a.token=p_token AND a.state='fetched' RETURNING a.resource_id INTO v_resource_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale SofaScore parse'; END IF;
 UPDATE sofa.resource r SET next_due_at=NULL,last_error=p_error WHERE r.id=v_resource_id;
 PERFORM sofa.review_item(r.source_id,'parse',r.resource_key,p_error,'{}') FROM sofa.resource r WHERE r.id=v_resource_id;
END $$;
REVOKE ALL ON FUNCTION sofa.reject_parse(uuid,uuid,text) FROM PUBLIC;
COMMIT;
