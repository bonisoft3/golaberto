from pathlib import Path
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest

from import_archive import (DEFERRED_TRIGGERS, KINDS, MAPS, RATING_NAMESPACE, Database, apply_script,corrected_views,csv_row,
                            game_day, legacy_uuid, literal, odds, paired_score, promotion_sql,
                            source_type,target_guard, validate_corrections, zones)


class ArchiveMappingTest(unittest.TestCase):
    def test_apply_artifact_can_move_without_changing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            original = Path(temporary)/'original';original.mkdir()
            (original/'apply.sh').write_text(apply_script(['cat']))
            (original/'apply.sql').write_text('private SQL payload\n')
            relocated = Path(temporary)/'relocated artifact'
            original.rename(relocated)
            applied = subprocess.run(['sh',str(relocated/'apply.sh')],cwd=temporary,text=True,capture_output=True,check=True)
            self.assertEqual(applied.stdout,'private SQL payload\n')

    def test_unknown_source_types_fail_instead_of_implicitly_coercing(self):
        self.assertEqual(source_type('int'),'bigint')
        self.assertEqual(source_type('json'),'text')
        with self.assertRaises(ValueError):
            source_type('blob')
    def test_namespaces_match_existing_archive_imports(self):
        self.assertEqual(legacy_uuid(7, 17), 'a0700000-0000-4000-8000-000000000011')
        self.assertEqual(KINDS['player_game'], 13)
        self.assertEqual(KINDS['comment'], 19)
        for kind, number in ((0, 1), (7, 0), (7, -1), (7, 2**48)):
            with self.assertRaises(ValueError):
                legacy_uuid(kind, number)

    def test_zone_positions_and_exact_colors_survive(self):
        value = '---\n- name: Copa\n  color: "#90EE90"\n  position: [1, 2, 4, 6, 7]\n'
        self.assertEqual(zones(value), [('Copa', '#90EE90', 1, 2),
                                       ('Copa', '#90EE90', 4, 4),
                                       ('Copa', '#90EE90', 6, 7)])

    def test_unsafe_or_ambiguous_yaml_fails(self):
        for value in ('!!python/object/apply:os.system [echo unsafe]',
                      '- name: Copa\n  color: red\n  position: [1]\n',
                      '- name: Copa\n  color: "#90EE90"\n  position: [1, 1]\n',
                      '- name: Copa\n  color: "#90EE90"\n  position: [true]\n'):
            with self.assertRaises(Exception):
                zones(value)

    def test_odds_preserve_zero_null_and_precision(self):
        self.assertEqual(odds('---\n- 0\n- null\n- 99.999999\n'), [0, None, 99.999999])
        for value in ('- 100.0000001', '- -1', '- .inf', '- true', 'value: 1'):
            with self.assertRaises(ValueError):
                odds(value)

    def test_corrections_require_exact_before_for_every_changed_field(self):
        columns = {'games': [('id','bigint'), ('home_id','bigint'), ('away_id','bigint')]}
        good = {'games': {'11': {'before': {'home_id':7,'away_id':7},
                               'after': {'away_id':8}, 'reason':'Distinct teams verified in original match report'}}}
        self.assertEqual(validate_corrections(good, columns), good)
        sql = corrected_views(columns, good)
        self.assertIn('home_id" IS NOT DISTINCT FROM 7', sql)
        self.assertIn('away_id" IS NOT DISTINCT FROM 7', sql)
        self.assertIn('count(*)', sql)
        self.assertIn('WHEN id=11 THEN 8::bigint', sql)
        self.assertNotIn('UPDATE legacy', sql)
        for bad in ({'games':{'11':{'before':{},'after':{'away_id':8},'reason':'verified'}}},
                    {'unknown':{}},
                    {'games':{'11':{'before':{'id':11},'after':{'id':12},'reason':'verified'}}},
                    {'games':{'11':{'before':{'away_id':7},'after':{'away_id':8},'reason':''}}}):
            with self.assertRaises(ValueError):
                validate_corrections(bad, columns)

    def test_sql_quotes_data_without_executing_it(self):
        self.assertEqual(literal("A'; SELECT $(echo secret); --"), "'A''; SELECT $(echo secret); --'")
        for value in (float('nan'), [], {'x': 1}, '\x00'):
            with self.assertRaises(ValueError):
                literal(value)

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_copy_null_empty_literal_sentinel_and_multiline_round_trip(self):
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        values = [None,'','\\N','first\nsecond','comma,quote"','backslash\\end']
        sql = "BEGIN; CREATE TEMP TABLE archive_copy_roundtrip(n integer,value text); COPY archive_copy_roundtrip FROM STDIN WITH(FORMAT csv,NULL '\\N');\n"
        sql += ''.join(csv_row((n,value)) for n,value in enumerate(values))
        sql += "\\.\nSELECT json_agg(value ORDER BY n) FROM archive_copy_roundtrip;ROLLBACK;"
        self.assertEqual(json.loads(db.pg(sql)),values)

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_mysql_structured_json_survives_copy_as_canonical_json(self):
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        value = [{'lat':'-23.5','lon':'-46.6','label':'quote"\nline','nested':[None,False,1.25]}]
        sql = "BEGIN;CREATE TEMP TABLE archive_json_roundtrip(value text);COPY archive_json_roundtrip FROM STDIN WITH(FORMAT csv,NULL '\\N');\n"+csv_row((value,))+"\\.\nSELECT value FROM archive_json_roundtrip;ROLLBACK;"
        self.assertEqual(json.loads(db.pg(sql)),value)

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_historical_rating_identity_matches_actual_rating_computation(self):
        repo = Path(__file__).resolve().parents[1]
        team = legacy_uuid(7,17)
        script = 'import {finish} from "./computations/ratings.js";console.log(finish('+json.dumps({'games':[{'recent':False}],'teams':[{'id':team}],'players':[],'phases':[]})+',[ [{team_id:1,measure_date:"2025-01-02",off_rating:1,def_rating:1,rating:50}] ]).team_rating[0].id);'
        runtime = subprocess.run(['node','--input-type=module','-e',script],cwd=repo,text=True,capture_output=True,check=True).stdout.strip()
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        actual = db.pg("BEGIN;CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA public VERSION '1.1';SELECT public.uuid_generate_v5('"+RATING_NAMESPACE+"'::uuid,'"+team+":2025-01-02');ROLLBACK;")
        self.assertEqual(actual,runtime)

    def test_event_stats_are_preserved_and_professional_semantics_match(self):
        mappings = {target: expression for target, _, _, expression in MAPS}
        self.assertIn('category_id IN (0,1)', mappings['championship'])
        self.assertIn('nullif(attendance,-1)', mappings['game'])
        self.assertIn('a.off_rating,a.def_rating', mappings['player_game'])
        self.assertIn('measure_date::date,off_rating,def_rating,rating', mappings['team_rating'])
        self.assertNotIn('least(', mappings['team_rating'])
        self.assertNotIn('greatest(', mappings['team_rating'])
        self.assertIn('CASE WHEN played=1 THEN home_score END', mappings['game'])

    @unittest.skipUnless(os.environ.get('ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'), 'scratch PostgreSQL destination not specified')
    def test_known_kickoffs_use_brasilia_day_without_shifting_hourless_games(self):
        db = Database('', '', os.environ['ARCHIVE_IMPORT_TEST_TARGET_CONTAINER'], 'golaberto')
        rows = "(VALUES ('2026-09-16 00:30:00',1),('2026-09-16 00:30:00',0),('2026-09-16 00:00:00',0),('2018-01-02 02:30:00',1)) AS g(date,has_time)"
        sql = "BEGIN READ ONLY; SET LOCAL TIME ZONE 'Asia/Tokyo'; SELECT json_agg(row_to_json(s)) FROM (SELECT " + game_day() + " AS game_day," + game_day('g.date','g.has_time') + " AS appearance_day FROM " + rows + ") s; ROLLBACK;"
        expected = ['2026-09-15','2026-09-16','2026-09-16','2018-01-02']
        self.assertEqual(json.loads(db.pg(sql)),[{'game_day':day,'appearance_day':day} for day in expected])

    def test_partial_score_pairs_preserve_entirely_absent_extra_time(self):
        connection = sqlite3.connect(':memory:')
        query = f'SELECT {paired_score("home_aet","away_aet")},{paired_score("away_aet","home_aet")} FROM (SELECT ? AS home_aet,? AS away_aet)'
        for values,expected in (((None,None),(None,None)),((2,None),(2,0)),((None,3),(0,3)),((2,1),(2,1))):
            self.assertEqual(connection.execute(query,values).fetchone(),expected)
        connection.close()

    def test_contradictory_substitution_minutes_are_not_guessed(self):
        mapping = next(expression for target, _, _, expression in MAPS if target=='player_game')
        off = mapping.split('a."on",',1)[1].split(',a.yellow',1)[0]
        bench = mapping.split(',a.red=1,',1)[1].split(',' + game_day('g.date','g.has_time'),1)[0]
        connection = sqlite3.connect(':memory:')
        query = f'SELECT {off},{bench} FROM(SELECT ? AS "on",? AS "off") a'
        for values,expected in (((0,0),(None,1)),((68,0),(0,0)),((74,45),(45,0)),((105,90),(90,0)),((60,75),(75,0))):
            self.assertEqual(connection.execute(query,values).fetchone(),expected)
        connection.close()

    def test_destination_guard_fails_before_import_and_never_resets(self):
        guard = target_guard('isolated', '123')
        self.assertIn("current_database()<>''isolated''", guard)
        self.assertIn("system_identifier::text", guard)
        self.assertIn('existing data is never reset', guard)
        self.assertIn('public."team_rating"', guard)
        self.assertNotIn('TRUNCATE', guard)

    def test_bulk_deferral_only_names_known_projection_triggers(self):
        self.assertNotIn('stamp_readable_address', str(DEFERRED_TRIGGERS))
        self.assertNotIn('player_game_day', str(DEFERRED_TRIGGERS))
        columns = {source:[('id','bigint')] for _,source,_,_ in MAPS}
        counts = {source:1 for source in columns}
        counts['current_goals'] = 1
        counts['unique_team_players'] = 1
        with tempfile.TemporaryDirectory() as temporary:
            paths = {key:Path(temporary)/(key+'.csv') for key in ('zones','odds','geocodes')}
            for path in paths.values():
                path.write_text('header\n')
            sql = promotion_sql(columns,{},counts,'isolated','123',paths,True)
        self.assertIn('NOT t.tgisinternal', sql)
        self.assertIn("WHEN 'A' THEN 'ENABLE ALWAYS'", sql)
        self.assertIn('player_metric_dirty', sql)
        self.assertNotIn('DISABLE TRIGGER ALL', sql)
        self.assertNotIn('DISABLE TRIGGER USER', sql)
        self.assertNotIn('session_replication_role', sql)
        self.assertNotIn('legacy."current_goals"', sql)
        self.assertNotIn('legacy."unique_team_players"', sql)
        self.assertIn('DISTINCT ON(championship_id,team_id,player_id)',sql)
        self.assertLess(sql.index('source event team is not a match participant'),sql.index('INSERT INTO public.'))
        self.assertIn('SELECT count(*) FROM pg_temp.player_games a JOIN pg_temp.games g',sql)
        self.assertIn('ORDER BY a.id', sql)
        self.assertNotIn('legacy-', sql)
        self.assertTrue(sql.endswith('COMMIT;\n'))

    def test_additions_and_exclusions_are_guarded_overlays(self):
        columns = {'teams':[('id','bigint'),('name','text'),('country','text')]}
        corrections = {'teams':{'4000000001':{'before':None,'after':{'name':'Burundi B','country':'Burundi'},'reason':'Distinct national B team'},
                                '1':{'before':{'name':'Placeholder'},'after':None,'reason':'Reviewed non-match fixture'}}}
        sql = corrected_views(columns,validate_corrections(corrections,columns))
        self.assertIn('addition already exists: teams/4000000001',sql)
        self.assertIn('WHERE id NOT IN(1)',sql)
        self.assertIn("UNION ALL SELECT 4000000001::bigint,'Burundi B'::text,'Burundi'::text",sql)
        self.assertNotIn('DELETE FROM legacy',sql)


if __name__ == '__main__':
    unittest.main()
