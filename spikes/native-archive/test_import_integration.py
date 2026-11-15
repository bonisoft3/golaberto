import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_archive', HERE / 'import.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
IMAGE = 'bonitao/mecha-database:0.23.0@sha256:75648c03a4b177ef768a8c541721685ef67d45135838808f67b8260261aa0cac'


@unittest.skipUnless(os.environ.get('ARCHIVE_DUMP_RESTORE_TEST'), 'Docker integration not requested')
class ImportIntegrationTest(unittest.TestCase):
    def test_import_and_failed_fk_restore_sequences_transactionally(self):
        name = 'archive-import-' + uuid.uuid4().hex[:10]
        subprocess.run(['docker', 'run', '-d', '--rm', '--name', name, '--network', 'none', '--memory', '256m',
                        '--tmpfs', '/postgresql-data', '--tmpfs', '/var/lib/postgresql',
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=golaberto',
                        '--entrypoint', 'sh', IMAGE, '-c',
                        'mv /docker-entrypoint-initdb.d/003_rls.sql /tmp/003_rls.sql && exec docker-entrypoint.sh postgres'],
                       check=True, capture_output=True)
        self.addCleanup(subprocess.run, ['docker', 'rm', '-f', name], capture_output=True)
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres', '-d', 'golaberto'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            self.fail('fixture database did not start')

        def sql(text):
            return subprocess.run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', 'golaberto',
                                   '-At', '-v', 'ON_ERROR_STOP=1'], input=text, text=True, capture_output=True, check=True).stdout.strip()

        tables = json.loads((HERE / 'tables.json').read_text())
        statements = ['CREATE SCHEMA pgroll;', 'CREATE SCHEMA golaberto_history;', 'CREATE SCHEMA golaberto_upload;',
                      'CREATE SCHEMA graphile_worker;', 'CREATE TABLE graphile_worker.migrations(id int);',
                      'INSERT INTO graphile_worker.migrations VALUES (42);',
                      'CREATE TABLE pgroll.migrations(schema text,name text,migration jsonb,done boolean,migration_type text);',
                      'CREATE TABLE pgroll.pgroll_version(version text);',
                      "INSERT INTO pgroll.pgroll_version VALUES ('fixture');",
                      'CREATE TABLE public.webauthn_credential(secret text);',
                      "INSERT INTO public.webauthn_credential VALUES ('credential-marker');"]
        for migration in sorted((HERE.parents[1] / 'services/database/pgroll').glob('*.json')):
            value = json.dumps(json.loads(migration.read_text())).replace("'", "''")
            statements.append(f"INSERT INTO pgroll.migrations VALUES ('public','{migration.stem}','{value}'::jsonb,true,'pgroll');")
        statements.extend(f'CREATE TABLE {table}(id text PRIMARY KEY);' for table in tables)
        statements.append('ALTER TABLE public.game ADD FOREIGN KEY(id) REFERENCES public.team(id);')
        statements.extend(f'CREATE SEQUENCE public.{seq}; SELECT setval(\'public.{seq}\',42,true);' for seq in archive.REVISION_SEQUENCES)
        sql('\n'.join(statements))
        original = archive.SOURCE_SHA256
        self.addCleanup(setattr, archive, 'SOURCE_SHA256', original)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'archive.sql'
            def write_archive(bad=False):
                with source.open('w') as f:
                    for table in tables:
                        value = 'broken' if bad and table == 'public.game' else 'ok'
                        f.write(f'COPY {table} (id) FROM stdin;\n{value}\n\\.\n')
                    for seq in sorted(archive.REVISION_SEQUENCES):
                        f.write(f"SELECT pg_catalog.setval('public.{seq}', {90 if bad else 7}, true);\n")
                archive.SOURCE_SHA256 = hashlib.sha256(source.read_bytes()).hexdigest()
            write_archive()
            archive.load(source, name)
            seq = sorted(archive.REVISION_SEQUENCES)[0]
            self.assertEqual(sql(f"SELECT id FROM public.game; SELECT last_value || '|' || is_called FROM public.{seq}; SELECT id FROM graphile_worker.migrations;"), 'ok\n43|false\n42')
            dump = Path(tmp) / 'export.dump'
            subprocess.run([os.sys.executable, str(HERE / 'export.py'), '--source-container', name, '--output', str(dump)],
                           check=True, capture_output=True)
            with dump.open('rb') as f:
                restored = subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '-f', '-', '--data-only'],
                                          stdin=f, check=True, capture_output=True).stdout
            self.assertNotIn(b'credential-marker', restored)
            self.assertNotIn(b'webauthn_credential', restored)
            write_archive(bad=True)
            with self.assertRaisesRegex(RuntimeError, 'transaction rolled back') as failure:
                archive.load(source, name)
            Path(str(failure.exception).split('private log: ', 1)[1]).unlink()
            self.assertEqual(sql(f"SELECT id FROM public.game; SELECT last_value || '|' || is_called FROM public.{seq}; SELECT id FROM graphile_worker.migrations;"), 'ok\n43|false\n42')


if __name__ == '__main__':
    unittest.main()
