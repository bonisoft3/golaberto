BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='1min';
CREATE TEMP TABLE history(id integer PRIMARY KEY,team_id integer,day date,offense real);
-- Streaming carriers use UTC timestamps without an offset.
-- squawk-ignore prefer-timestamp-tz
CREATE TEMP TABLE requests(id integer PRIMARY KEY,team_id integer,moment timestamp);
CREATE TEMP TABLE retained(LIKE history INCLUDING ALL);
CREATE TEMP VIEW full_lookup AS
SELECT q.id AS request_id,r.id AS rating_id,r.offense
FROM requests q LEFT JOIN LATERAL (
 SELECT id,offense FROM history r WHERE r.team_id=q.team_id AND r.day::timestamp<q.moment
 ORDER BY r.day DESC,r.id LIMIT 1
) r ON true;
CREATE TEMP VIEW compact_lookup AS
SELECT q.id AS request_id,r.id AS rating_id,r.offense
FROM requests q LEFT JOIN LATERAL (
 SELECT id,offense FROM retained r WHERE r.team_id=q.team_id AND r.day::timestamp<q.moment
 ORDER BY r.day DESC,r.id LIMIT 1
) r ON true;
CREATE FUNCTION pg_temp.refresh_selected() RETURNS void LANGUAGE sql AS $$
 TRUNCATE retained;
 INSERT INTO retained SELECT DISTINCT r.* FROM history r JOIN full_lookup f ON f.rating_id=r.id;
$$;
CREATE FUNCTION pg_temp.equivalent() RETURNS boolean LANGUAGE sql AS $$
 SELECT NOT EXISTS(
   (SELECT * FROM full_lookup EXCEPT ALL SELECT * FROM compact_lookup)
   UNION ALL
   (SELECT * FROM compact_lookup EXCEPT ALL SELECT * FROM full_lookup)
 );
$$;
CREATE FUNCTION pg_temp.expect(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%',label; END IF; END;
$$;
INSERT INTO history VALUES(1,1,'2026-01-01',1),(2,1,'2026-02-01',2),(3,1,'2026-03-01',3);
INSERT INTO requests VALUES
 (1,1,'2026-02-15'),(2,1,'2026-02-01'),(3,1,'2026-02-01 00:00:00.000001'),(4,1,'2025-12-01');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'initial snapshot');
SELECT pg_temp.expect((SELECT rating_id=2 FROM full_lookup WHERE request_id=1),'latest is not ASOF');
SELECT pg_temp.expect((SELECT rating_id=1 FROM full_lookup WHERE request_id=2),'strict midnight');
SELECT pg_temp.expect((SELECT rating_id=2 FROM full_lookup WHERE request_id=3),'microsecond boundary');
SELECT pg_temp.expect((SELECT rating_id IS NULL FROM full_lookup WHERE request_id=4),'missing predecessor');
INSERT INTO history VALUES(4,1,'2026-02-10',4);
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'new winner must invalidate');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'insert refresh');
UPDATE history SET day='2026-02-12' WHERE id=3;
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'an excluded row can become the winner');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'date correction refresh');
DELETE FROM history WHERE id=3;
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'deleting the winner needs an excluded predecessor');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'delete backfill');
DELETE FROM history WHERE id=4;
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'second delete backfill');
DELETE FROM requests WHERE id<>1;
SELECT pg_temp.refresh_selected();
UPDATE requests SET moment='2026-01-15' WHERE id=1;
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'backdated requests need older history');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'backdated request refresh');
INSERT INTO requests VALUES(5,1,'2026-04-01');
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'new requests need history backfill');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'new request refresh');
UPDATE history SET offense=5 WHERE id=1;
SELECT pg_temp.expect(NOT pg_temp.equivalent(),'value correction must invalidate');
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect(pg_temp.equivalent(),'value correction refresh');
DELETE FROM requests;
SELECT pg_temp.refresh_selected();
SELECT pg_temp.expect((SELECT count(*)=0 FROM retained),'retire unreferenced rows');
SELECT 'source-history contract passed' AS result;
ROLLBACK;
