BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
ALTER TABLE sofa.source ADD COLUMN IF NOT EXISTS event_scope text NOT NULL DEFAULT 'competition'
 CHECK(event_scope IN ('competition','stages','fixtures'));
UPDATE sofa.resource SET priority=CASE family WHEN 'rounds' THEN 1 WHEN 'lineups' THEN 5 WHEN 'incidents' THEN 5 ELSE 0 END
WHERE priority IS DISTINCT FROM CASE family WHEN 'rounds' THEN 1 WHEN 'lineups' THEN 5 WHEN 'incidents' THEN 5 ELSE 0 END;
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
COMMIT;
