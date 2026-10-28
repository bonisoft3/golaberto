BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION id(feed home_feed) RETURNS SETOF game
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM game source WHERE source.id=feed.id
$$;
CREATE OR REPLACE FUNCTION championship(feed home_feed) RETURNS SETOF championship
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM championship source WHERE source.id=feed.championship_id
$$;
CREATE OR REPLACE FUNCTION home_id(feed home_feed) RETURNS SETOF team
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM team source WHERE source.id=feed.home_id
$$;
CREATE OR REPLACE FUNCTION away_id(feed home_feed) RETURNS SETOF team
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM team source WHERE source.id=feed.away_id
$$;
REVOKE ALL ON FUNCTION id(home_feed), championship(home_feed), home_id(home_feed), away_id(home_feed) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION id(home_feed), championship(home_feed), home_id(home_feed), away_id(home_feed) TO anon, app_user, service;
COMMIT;
