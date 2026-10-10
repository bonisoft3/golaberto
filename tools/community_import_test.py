import os
import unittest
from unittest.mock import patch
import import_archive
from import_archive import Database, USER_COLUMNS, TABLES, UID_SQL, community_promotion_sql, legacy_uuid


def historical_fixture_sql():
    actor, home, away, champ, phase, game = [legacy_uuid(kind, 987654321) for kind in (18,7,7,2,3,9)]
    away = legacy_uuid(7,987654322)
    return f"""BEGIN;
{UID_SQL}
INSERT INTO public.app_user(id,handle) VALUES('{actor}','Historical public byline');
INSERT INTO public.team(id,name,country) VALUES('{home}','Historical home','Brasil'),('{away}','Historical away','Brasil');
INSERT INTO public.championship(id,name,region_name,begins,ends) VALUES('{champ}','Historical season','Brasil','2010-01-01','2010-12-31');
INSERT INTO public.phase(id,championship_id,name) VALUES('{phase}','{champ}','Final');
INSERT INTO public.game(id,phase_id,home_id,away_id,day) VALUES('{game}','{phase}','{home}','{away}','2010-01-01');
CREATE TEMP TABLE users(id bigint,name text,location text,about_me text,created_at text,updated_at text);
INSERT INTO users VALUES(987654321,'Historical name','Porto Alegre','<script>untrusted biography</script>','2009-01-01 00:00:00','2010-02-01 00:00:00');
CREATE TEMP TABLE game_versions(id bigint,game_id bigint,version integer,updater_id bigint,updated_at text,
 phase_id bigint,round integer,date text,has_time integer,home_id bigint,away_id bigint,home_field integer,
 played integer,home_score integer,away_score integer,home_aet integer,away_aet integer,home_pen integer,away_pen integer,
 stadium_id bigint,referee_id bigint,attendance integer);
INSERT INTO game_versions VALUES
 (1,987654321,1,987654321,'2010-01-01 12:00:00',987654321,1,'2010-01-01 00:00:00',0,987654321,987654322,0,1,0,0,NULL,NULL,NULL,NULL,0,0,-1),
 (2,987654321,2,987654321,'2010-01-02 12:00:00',987654321,1,'2010-01-01 00:00:00',0,987654321,987654322,0,1,2,0,1,NULL,3,NULL,0,0,-1),
 (3,987654321,3,987654321,'2010-01-03 12:00:00',987654321,1,'2010-01-01 00:00:00',0,987654321,987654322,0,1,2,0,1,NULL,3,NULL,0,0,-1),
 (4,987654321,4,0,'2010-01-04 12:00:00',987654321,1,'2010-01-02 01:00:00',1,987654321,987654322,0,0,2,0,NULL,NULL,NULL,NULL,0,0,-1),
 (5,987654321,5,0,'2010-01-05 12:00:00',987654321,1,'2010-01-02 01:00:00',1,987654321,987654322,0,0,2,0,NULL,NULL,NULL,NULL,0,0,-1);
{community_promotion_sql()}
DO $$ BEGIN
 IF (SELECT count(*) FROM public.game_change WHERE game_id='{game}')<>3
   OR (SELECT array_agg(version ORDER BY version) FROM public.game_change WHERE game_id='{game}')<>ARRAY[1,2,4]
   THEN RAISE EXCEPTION 'retain source versions while omitting revisions without approved field changes'; END IF;
 IF (SELECT changes_json::jsonb->'home_score' FROM public.game_change WHERE game_id='{game}' AND version=2)
   IS DISTINCT FROM '{{"before":0,"after":2}}'::jsonb
   THEN RAISE EXCEPTION 'legacy zero scores must not become unknown'; END IF;
 IF (SELECT changes_json::jsonb ? 'away_aet' OR changes_json::jsonb ? 'away_pen' FROM public.game_change WHERE game_id='{game}' AND version=2)
   THEN RAISE EXCEPTION 'missing historical AET and shootout scores must not be synthesized as zero'; END IF;
 IF (SELECT actor_id FROM public.game_change WHERE game_id='{game}' AND version=2) IS DISTINCT FROM '{actor}'::uuid
   OR (SELECT actor_handle FROM public.game_change WHERE game_id='{game}' AND version=2) IS DISTINCT FROM 'Historical public byline'
   OR (SELECT actor_id FROM public.game_change WHERE game_id='{game}' AND version=4) IS NOT NULL
   THEN RAISE EXCEPTION 'only source numeric author identities attribute historical edits'; END IF;
 IF (SELECT changes_json::jsonb->'home_score' FROM public.game_change WHERE game_id='{game}' AND version=4)
   IS DISTINCT FROM '{{"before":2,"after":null}}'::jsonb
   OR (SELECT game_day FROM public.game_change WHERE game_id='{game}' AND version=4) IS DISTINCT FROM '2010-01-01'::date
   THEN RAISE EXCEPTION 'legacy unplayed scores and Brazil civil days must use the ordinary archive mapping'; END IF;
 IF (SELECT about_me FROM public.user_biography WHERE app_user_id='{actor}') IS DISTINCT FROM '<script>untrusted biography</script>'
   OR (SELECT updated_at FROM public.user_biography WHERE app_user_id='{actor}') IS DISTINCT FROM '2010-02-01 00:00:00Z'::timestamptz
   OR EXISTS(SELECT 1 FROM public.editor WHERE app_user_id='{actor}')
   THEN RAISE EXCEPTION 'public biography text must survive without authentication or editor ownership grants'; END IF;
END $$;
UPDATE public.game SET attendance=12 WHERE id='{game}';
DO $$ BEGIN
 IF (SELECT max(version) FROM public.game_change WHERE game_id='{game}')<>6
   THEN RAISE EXCEPTION 'new changes must advance beyond every legacy revision, including omitted goals-only versions'; END IF;
 IF has_table_privilege('app_user','golaberto_history.version_floor','SELECT,INSERT,UPDATE,DELETE')
   THEN RAISE EXCEPTION 'clients cannot inspect or forge the imported history floor'; END IF;
END $$;
ROLLBACK;"""


class CommunityImportTest(unittest.TestCase):
    def test_public_source_allowlist_excludes_account_secrets(self):
        self.assertTrue({'location','about_me','avatar_file_name'} <= set(USER_COLUMNS))
        self.assertFalse({'email','birthday','crypted_password','salt','identity_url','openid_connect_token','remember_token','last_login'} & set(USER_COLUMNS))
        self.assertIn('game_versions', TABLES)
        sql = community_promotion_sql()
        self.assertNotIn('set_config',sql)
        self.assertNotIn('request.jwt.claims',sql)
        self.assertNotIn('INSERT INTO public.editor',sql)
        self.assertIn('pg_temp.uid(18,nullif(v.updater_id,0))',sql)

    def test_future_import_fields_cannot_silently_enter_public_history(self):
        maps = tuple((target,source,fields+',creator_id',values+',NULL') if target=='game'
                     else (target,source,fields,values) for target,source,fields,values in import_archive.MAPS)
        with patch.object(import_archive,'MAPS',maps), self.assertRaisesRegex(ValueError,'approved field allowlist'):
            community_promotion_sql()

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_historical_snapshots_preserve_source_identity_zero_unknown_and_public_biography(self):
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        db.pg(historical_fixture_sql())

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_invalid_revision_identity_and_author_refuse_the_entire_import(self):
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        fixture = historical_fixture_sql()
        for changed in [fixture.replace('(4,987654321,4,0,', '(4,987654321,2,0,'),
                        fixture.replace('(2,987654321,2,987654321,', '(2,987654321,2,987654323,')]:
            with self.assertRaisesRegex(RuntimeError, 'legacy (game versions require|version author is absent)'):
                db.pg(changed)



if __name__=='__main__':
    unittest.main()
