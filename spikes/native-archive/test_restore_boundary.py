import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('archive_workflow', HERE.parents[1] / 'tools/archive_workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)
IMAGE = 'bonitao/mecha-database:0.23.0@sha256:75648c03a4b177ef768a8c541721685ef67d45135838808f67b8260261aa0cac'


@unittest.skipUnless(os.environ.get('ARCHIVE_DUMP_RESTORE_TEST'), 'Docker integration not requested')
class RestoreBoundaryTest(unittest.TestCase):
    def test_restore_preserves_unlisted_runtime_and_rejects_invalid_foreign_key(self):
        name = 'archive-boundary-' + uuid.uuid4().hex[:10]
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

        def sql(db, text):
            return subprocess.run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', db,
                                   '-At', '-v', 'ON_ERROR_STOP=1'], input=text, text=True, capture_output=True, check=True).stdout.strip()

        sql('golaberto', 'CREATE DATABASE archive_source;')
        schema = '''CREATE SCHEMA pgroll;
          CREATE TABLE pgroll.migrations(schema text, name text, migration_type text, done boolean);
          INSERT INTO pgroll.migrations VALUES ('public','00_initdb','baseline',true);
          CREATE SEQUENCE public.counter_seq;
          CREATE TABLE public.parent(id int PRIMARY KEY);
          CREATE TABLE public.child(id int PRIMARY KEY, parent_id int REFERENCES public.parent(id));'''
        sql('archive_source', schema + "SELECT setval('public.counter_seq',7,true); INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1,1);")
        sql('golaberto', schema + '''CREATE SCHEMA graphile_worker;
          CREATE TABLE graphile_worker.migrations(id int); INSERT INTO graphile_worker.migrations VALUES (42);
          CREATE TABLE public.schedule(id int); INSERT INTO public.schedule VALUES (43);
          SELECT setval('public.counter_seq',42,true);
          INSERT INTO parent VALUES (2); INSERT INTO child VALUES (2,2);''')
        with tempfile.TemporaryDirectory() as tmp:
            dump = Path(tmp) / 'archive.dump'
            def export():
                with dump.open('wb') as out:
                    subprocess.run(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-d', 'archive_source',
                                    '-Fc', '--data-only', '-t', 'pgroll.migrations', '-t', 'public.parent', '-t', 'public.child', '-t', 'public.counter_seq'],
                                   stdout=out, stderr=subprocess.PIPE, check=True)
            export()
            workflow.restore_dump(dump, name)
            self.assertEqual(sql('golaberto', "SELECT id FROM parent; SELECT id FROM child; SELECT id FROM public.schedule; SELECT id FROM graphile_worker.migrations; SELECT last_value || '|' || is_called FROM public.counter_seq;"), '1\n1\n43\n42\n8|false')
            sql('archive_source', "SET session_replication_role='replica'; UPDATE child SET parent_id=99; SELECT setval('public.counter_seq',20,true);")
            export()
            with self.assertRaises(subprocess.CalledProcessError):
                workflow.restore_dump(dump, name)
            self.assertEqual(sql('golaberto', "SELECT id FROM parent; SELECT parent_id FROM child; SELECT id FROM public.schedule; SELECT id FROM graphile_worker.migrations; SELECT last_value || '|' || is_called FROM public.counter_seq;"), '1\n1\n43\n42\n8|false')

            workflow.ensure_compute_schema(name)
            inst_id = '11111111-1111-4111-8111-111111111111'
            sql('golaberto', f"""
              INSERT INTO compute.source(name, revision) VALUES ('parent', 5), ('child', 6);
              SELECT setval('compute.source_revision_seq', 6, true);
              CREATE TRIGGER compute_source_touch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.parent
                FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source('parent');
              ALTER TABLE public.parent ENABLE ALWAYS TRIGGER compute_source_touch;
              INSERT INTO hybrid_compute_batch.instance(id, version, revision, state)
                VALUES ('{inst_id}', 1, 2, '{{"name":"sample","coalesce":0,"attempts":1,"requested":1,"completed":1,"claimed":0,"wake":0,"due":0,"required":[]}}'::jsonb);
              INSERT INTO compute.definition(name, instance_id, version, reads, to_tables, parents, ordinal, enabled)
                VALUES ('sample', '{inst_id}', 'v1', ARRAY['parent'], ARRAY['child'], ARRAY[]::text[], 0, true);
              INSERT INTO compute.capture(instance_id, completed_coverage)
                VALUES ('{inst_id}', compute.current_coverage('sample'));
            """)
            with dump.open('wb') as out:
                subprocess.run(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-d', 'golaberto',
                                '-Fc', '--data-only', '-t', 'pgroll.migrations', '-t', 'public.parent', '-t', 'public.child',
                                '-t', 'public.counter_seq', '-t', 'compute.definition', '-t', 'compute.capture',
                                '-t', 'compute.source', '-t', 'compute.source_revision_seq', '-t', 'hybrid_compute_batch.instance'],
                               stdout=out, stderr=subprocess.PIPE, check=True)
            sql('golaberto', "INSERT INTO parent VALUES (9);")
            self.assertEqual(sql('golaberto', "SELECT revision FROM compute.source WHERE name='parent';"), '7')
            workflow.restore_dump(dump, name)
            self.assertEqual(sql('golaberto', "SELECT revision FROM compute.source WHERE name='parent'; SELECT compute.reconcile(false); SELECT requested || '|' || completed FROM compute.batch WHERE name='sample';"), '5\n\n1|1')
            sql('golaberto', "UPDATE compute.capture SET completed_coverage = '{\"version\":\"stale\"}'::jsonb;")
            with dump.open('wb') as out:
                subprocess.run(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-d', 'golaberto',
                                '-Fc', '--data-only', '-t', 'pgroll.migrations', '-t', 'public.parent', '-t', 'public.child',
                                '-t', 'public.counter_seq', '-t', 'compute.definition', '-t', 'compute.capture',
                                '-t', 'compute.source', '-t', 'compute.source_revision_seq', '-t', 'hybrid_compute_batch.instance'],
                               stdout=out, stderr=subprocess.PIPE, check=True)
            sql('golaberto', "UPDATE compute.capture SET completed_coverage = compute.current_coverage('sample');")
            with self.assertRaises(subprocess.CalledProcessError):
                workflow.restore_dump(dump, name)


if __name__ == '__main__':
    unittest.main()
