import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

from archive_workflow import check_new_project,ledger_names,project_name,sequence_restart,verify_archive,wait_for_source


class ArchiveWorkflowTest(unittest.TestCase):
    def test_dump_ledger_names_only_public_schema_migrations(self):
        copy = '\n'.join([
            'SET client_encoding = \'UTF8\';',
            'COPY pgroll.migrations (schema, name, migration, created_at, updated_at, parent, done, resulting_schema, migration_type) FROM stdin;',
            'public\t00_initdb\t{}\tt0\tt0\t\\N\tt\t{}\tbaseline',
            'public\t041_native_media\t{"a":"x\\ty"}\tt1\tt1\t00_initdb\tt\t{}\tpgroll',
            'public\t041_native_media_2026\t{}\tt2\tt2\t041_native_media\tt\t{}\tinferred',
            'pg_temp\t00000_initial_2026\t{}\tt3\tt3\t\\N\tt\t{}\tinferred',
            '\\.',
        ])
        self.assertEqual(ledger_names(copy),{'00_initdb','041_native_media'})
        with self.assertRaises(ValueError):
            ledger_names('SET client_encoding = \'UTF8\';')
        with self.assertRaisesRegex(ValueError, 'incomplete migration'):
            ledger_names(copy.replace('00_initdb\t{}\tt0\tt0\t\\N\tt\t{}', '00_initdb\t{}\tt0\tt0\t\\N\tf\t{}'))

    def test_sequence_restart_preserves_nextval_and_exhaustion(self):
        self.assertEqual(sequence_restart(7, True, 2, 1, 9, False), 9)
        self.assertEqual(sequence_restart(7, False, 2, 1, 9, False), 7)
        self.assertEqual(sequence_restart(9, True, 2, 1, 9, True), 1)
        self.assertEqual(sequence_restart(1, True, -2, 1, 9, True), 9)
        with self.assertRaisesRegex(ValueError, 'exhausted'):
            sequence_restart(9, True, 2, 1, 9, False)
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            sequence_restart(10, False, 1, 1, 9, False)

    def test_temporary_initialization_daemon_is_not_restore_ready(self):
        with patch('archive_workflow.docker',side_effect=['docker-entrypoi','true','mysqld']) as docker, \
             patch('archive_workflow.subprocess.run') as query, \
             patch('archive_workflow.time.sleep'):
            query.return_value.returncode = 0
            wait_for_source('source',['mysql','-D','GolAberto_production'])
            self.assertEqual(query.call_count,1)
            self.assertEqual(query.call_args.args[0],['mysql','-D','GolAberto_production','-e','SELECT 1'])
            self.assertEqual(docker.call_count,3)

    def test_existing_project_resources_are_never_reused(self):
        for responses in (['existing','',''],['','trial-source',''],['','','trial_archive-postgres']):
            with patch('archive_workflow.docker',side_effect=responses) as docker:
                with self.assertRaises(ValueError):
                    check_new_project('trial')
                self.assertFalse(any(call.args[0] in ('run','volume') and 'create' in call.args for call in docker.call_args_list))
        with patch('archive_workflow.docker',side_effect=['','','unrelated_volume']):
            check_new_project('trial')

    def test_wrong_dump_or_unpinned_source_fails_before_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'archive.gz';path.write_bytes(b'private fixture')
            provenance = {'archive_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mysql_image':'mysql@sha256:'+'a'*64}
            verify_archive(path,provenance)
            for wrong in ({**provenance,'archive_sha256':'b'*64},{**provenance,'mysql_image':'mysql:latest'}):
                with self.assertRaises(ValueError):
                    verify_archive(path,wrong)
        for project in ('../existing','Production','trial;rm',''):
            with self.assertRaises(ValueError):
                project_name(project)

    def test_reviewed_profile_only_contains_public_sports_corrections(self):
        directory = Path(__file__).parent/'archive'
        provenance = json.loads((directory/'production-2026-10-06.provenance.json').read_text())
        corrections = json.loads((directory/provenance['corrections']).read_text())
        self.assertEqual(set(corrections),{'games','teams','team_groups','player_games','groups','game_versions'})
        self.assertEqual(len(provenance['archive_sha256']),64)
        self.assertTrue(all('reason' in record for records in corrections.values() for record in records.values()))



if __name__=='__main__':
    unittest.main()
