BEGIN;
SET lock_timeout='5s';
SET statement_timeout='120s';
-- An event's calendar day, from fn_sofascore_normalize's output: the kickoff's
-- day in Sao Paulo, or the UTC day of a start the provider has not confirmed.
CREATE OR REPLACE FUNCTION sofa.event_day(p_event jsonb) RETURNS date
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_event->>'kickoff' IS NULL
   THEN ((p_event->>'start_at')::timestamptz AT TIME ZONE 'UTC')::date
   ELSE ((p_event->>'start_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date END
$$;
COMMIT;
