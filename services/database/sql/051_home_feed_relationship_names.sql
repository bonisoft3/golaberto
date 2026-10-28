BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION game_archive(feed home_feed) RETURNS SETOF game_archive
LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
  SELECT source.* FROM game_archive source WHERE source.id=feed.id
$$;
REVOKE ALL ON FUNCTION game_archive(home_feed) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION game_archive(home_feed) TO anon, app_user, service;
COMMIT;
