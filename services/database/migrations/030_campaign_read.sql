SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

DROP FUNCTION IF EXISTS refresh_team_campaign_group(uuid);
DROP FUNCTION IF EXISTS replace_team_campaign_points(uuid, jsonb);

DO $$ DECLARE alias record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_class
             WHERE oid=to_regclass('public.team_campaign_point') AND relkind='r') THEN
    -- pgroll creates the new schema's compatibility view before on-complete SQL.
    -- Retire only its aliases of the replaced cache; other dependencies must fail.
    IF to_regclass('pgroll.migrations') IS NOT NULL THEN
      FOR alias IN
        SELECT n.nspname,c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
        WHERE m.schema='public' AND c.relname='team_campaign_point' AND c.relkind='v'
      LOOP
        EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname);
      END LOOP;
    END IF;
    DROP TABLE team_campaign_point;
  END IF;
END $$;

-- Keep the group key outside the lateral computation so request predicates
-- select a group before ranking every member; team selection follows ranking.
CREATE OR REPLACE VIEW team_campaign_point WITH (security_invoker=true) AS
SELECT sg.id::text || ':' || member.team_id::text || ':' || item.game_id::text AS id,
  sg.id AS group_id, member.team_id, item.game_id,
  item.sequence, item.day, item.points, item.position, item.result,
  NULL::bigint AS txid, 'public:'::text AS scope_id
FROM stage_group sg
CROSS JOIN LATERAL jsonb_to_recordset(compute_team_campaign_rows(sg.id)) AS item(
  team_id uuid, game_id uuid, sequence integer, day date,
  points integer, position integer, result text
)
JOIN team_group member ON member.group_id=sg.id AND member.team_id=item.team_id;

CREATE OR REPLACE FUNCTION game(campaign team_campaign_point) RETURNS SETOF game
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM game source WHERE source.id=campaign.game_id
$$;
REVOKE ALL ON FUNCTION game(team_campaign_point) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION game(team_campaign_point) TO app_user, service;

CREATE OR REPLACE FUNCTION team(campaign team_campaign_point) RETURNS SETOF team
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM team source WHERE source.id=campaign.team_id
$$;
REVOKE ALL ON FUNCTION team(team_campaign_point) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION team(team_campaign_point) TO app_user, service;

REVOKE ALL ON team_campaign_point FROM PUBLIC, anon, app_user, service, electric;
GRANT SELECT ON team_campaign_point TO app_user, service;
GRANT EXECUTE ON FUNCTION compute_team_campaign_rows(uuid) TO app_user, service;

COMMIT;
