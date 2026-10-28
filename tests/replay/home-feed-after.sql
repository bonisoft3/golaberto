DO $$ BEGIN
  IF EXISTS ((SELECT * FROM replay_fixture.game_rows EXCEPT ALL SELECT * FROM game)
    UNION ALL (SELECT * FROM game EXCEPT ALL SELECT * FROM replay_fixture.game_rows)) THEN
    RAISE EXCEPTION 'homepage conversion changed authoritative game rows';
  END IF;
  IF EXISTS ((SELECT * FROM replay_fixture.source_rows EXCEPT ALL SELECT * FROM game_card)
    UNION ALL (SELECT * FROM game_card EXCEPT ALL SELECT * FROM replay_fixture.source_rows)) THEN
    RAISE EXCEPTION 'homepage conversion changed source game rows';
  END IF;
  IF EXISTS ((SELECT * FROM replay_fixture.user_rows EXCEPT ALL SELECT * FROM app_user)
    UNION ALL (SELECT * FROM app_user EXCEPT ALL SELECT * FROM replay_fixture.user_rows)) THEN
    RAISE EXCEPTION 'homepage conversion changed user rows';
  END IF;
  IF NOT coalesce((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='home_feed'::regclass), false) THEN
    RAISE EXCEPTION 'homepage view must use the caller permissions';
  END IF;
  IF has_table_privilege('anon','home_feed','INSERT,UPDATE,DELETE')
    OR has_table_privilege('app_user','home_feed','INSERT,UPDATE,DELETE')
    OR has_table_privilege('service','home_feed','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'homepage view grants writes';
  END IF;
END $$;
SET app.scopes='public:';
SET ROLE app_user;
SELECT count(*) = 1 AND bool_and(
  f.home_upcoming_rank = 1
  AND (SELECT id FROM id(f)) = f.id
  AND (SELECT id FROM championship(f)) = f.championship_id
  AND (SELECT id FROM home_id(f)) = f.home_id
  AND (SELECT id FROM away_id(f)) = f.away_id
) FROM home_feed f;
