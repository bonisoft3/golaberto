#!/usr/bin/env python3
"""Check a fresh trial project, restore a checksum-reviewed private archive,
wait for its source, or check that a pg_dump was made by these migrations."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid


def docker(*arguments: str) -> str:
    return subprocess.run(['docker', *arguments],check=True,text=True,capture_output=True).stdout.strip()


def project_name(value: str) -> str:
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}',value):
        raise ValueError('project must contain 1-40 lowercase letters, digits, underscores or hyphens')
    return value


def check_new_project(project: str):
    project_name(project)
    containers = docker('container','ls','-aq','--filter','label=com.docker.compose.project='+project)
    names = docker('container','ls','-a','--format','{{.Names}}').splitlines()
    volumes = docker('volume','ls','--format','{{.Name}}').splitlines()
    if containers or project+'-source' in names or any(v.startswith(project+'_') for v in volumes):
        raise ValueError('trial project already has containers or volumes; choose a new project, existing data is never reset')


def verify_archive(path: Path, provenance: dict):
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream,'sha256').hexdigest()
    if digest != provenance['archive_sha256']:
        raise ValueError('archive SHA-256 differs from reviewed provenance')
    if not re.fullmatch(r'mysql@sha256:[0-9a-f]{64}',provenance['mysql_image']):
        raise ValueError('provenance must pin the MySQL image by digest')


def restore_source(project: str, archive: Path, provenance: dict):
    verify_archive(archive,provenance)
    container, client = source_client(project, provenance)
    volume = project+'_archive-source'
    # The project's target may already stand; only an existing source would be
    # reset by restoring over it.
    if container in docker('container','ls','-a','--format','{{.Names}}').splitlines() or volume in docker('volume','ls','--format','{{.Name}}').splitlines():
        raise ValueError(f'{container} or its volume already exists; existing data is never reset')
    docker('volume','create',volume)
    docker('run','-d','--name',container,'--network','none','--mount',
           'type=volume,source='+volume+',target=/var/lib/mysql',
           '-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-e','MYSQL_DATABASE='+provenance['source_database'],
           provenance['mysql_image'])
    wait_for_source(container,client)
    with gzip.open(archive,'rb') as source, subprocess.Popen(client,stdin=subprocess.PIPE) as destination:
        assert destination.stdin is not None
        shutil.copyfileobj(source,destination.stdin)
        destination.stdin.close()
        if destination.wait():
            raise RuntimeError('MySQL archive restore failed; restored resources are retained for inspection')
    # Persisted, so a restarted source still reports its restore finished.
    docker('exec',container,'mysql','-uroot','-e','SET PERSIST super_read_only=ON;')
    print(container)


def wait_for_source(container: str, client: list[str]):
    deadline = time.monotonic()+60
    while True:
        # The entrypoint's temporary daemon also answers SELECT 1.
        final_server = docker('exec',container,'cat','/proc/1/comm')=='mysqld'
        ready = subprocess.run(client+['-e','SELECT 1'],capture_output=True) if final_server else None
        if ready is not None and ready.returncode==0:
            break
        if docker('inspect','--format','{{.State.Running}}',container)!='true':
            raise RuntimeError('MySQL stopped before becoming ready; inspect the isolated source container')
        if time.monotonic()>=deadline:
            raise RuntimeError('MySQL did not become ready in 60 seconds; restored resources are retained for inspection')
        time.sleep(1)


def source_client(project: str, provenance: dict) -> tuple[str, list[str]]:
    container = project+'-source'
    return container, ['docker','exec','-i',container,'mysql','-uroot','-D',provenance['source_database'],
                       '--connect-timeout=2','--default-character-set=utf8mb4']


def source_ready(project: str, provenance: dict):
    """Starts a restored source and waits for it; refuses one whose restore
    stopped before it set super_read_only, its last step."""
    container, client = source_client(project, provenance)
    docker('start',container)
    wait_for_source(container,client)
    if docker('exec',container,'mysql','-uroot','-N','-e','SELECT @@super_read_only')!='1':
        raise RuntimeError(f'{container} exists but its restore did not finish; inspect it, or remove it and its volume to restore again')


def ledger_names(copy_text: str) -> set[str]:
    """The schema migrations of public a `pg_restore -f - --data-only` of
    pgroll.migrations records: pgroll's own and its baseline, not the DDL it
    inferred, which differs between any two databases."""
    lines = iter(copy_text.splitlines())
    for line in lines:
        if line.startswith('COPY pgroll.migrations ('):
            columns = [c.strip() for c in line[len('COPY pgroll.migrations ('):line.index(')')].split(',')]
            break
    else:
        raise ValueError('the dump carries no pgroll ledger')
    names = set()
    for line in lines:
        if line == '\\.':
            return names
        row = dict(zip(columns, line.split('\t')))
        if row['schema'] == 'public' and row['migration_type'] in ('pgroll','baseline'):
            if row.get('done') != 't':
                raise ValueError('the dump has an incomplete migration')
            names.add(row['name'])
    raise ValueError('the dump ledger ends without its terminator')


def check_dump(dump: Path, target: str):
    """Refuses a dump whose migrations differ from the target's: a data-only
    restore into other columns fills or drops them without an error."""
    with dump.open('rb') as stream:
        restored = subprocess.run(['docker','exec','-i',target,'pg_restore','-f','-','--data-only','-n','pgroll','-t','migrations'],
                                  stdin=stream,check=True,capture_output=True).stdout.decode()
    theirs = ledger_names(restored)
    ours = set(docker('exec',target,'psql','-X','-U','postgres','-d','golaberto','-Atc',
                      "SELECT name FROM pgroll.migrations WHERE schema='public' AND migration_type IN ('pgroll','baseline')").split())
    if theirs != ours:
        raise ValueError(f'the dump was made by other migrations: only in the dump {sorted(theirs-ours)}, only here {sorted(ours-theirs)}')
    if docker('exec', target, 'psql', '-X', '-U', 'postgres', '-d', 'golaberto', '-Atc',
              "SELECT count(*) FROM pgroll.migrations WHERE schema='public' AND migration_type IN ('pgroll','baseline') AND done IS NOT TRUE") != '0':
        raise ValueError('the destination has an incomplete migration')


def sequence_restart(value: int, called: bool, increment: int, minimum: int, maximum: int, cycle: bool) -> int:
    if increment == 0 or not minimum <= value <= maximum:
        raise ValueError('unsupported archive sequence state')
    next_value = value + increment if called else value
    if next_value > maximum:
        if not cycle:
            raise ValueError('archive sequence is exhausted')
        return minimum
    if next_value < minimum:
        if not cycle:
            raise ValueError('archive sequence is exhausted')
        return maximum
    return next_value


def ensure_compute_schema(target: str):
    repo = Path(__file__).resolve().parents[3]
    bootstrap = '\n\n'.join([
        (repo / 'libraries/mecha/services/durex/work.sql').read_text(),
        (repo / 'libraries/mecha/services/compute/batch-machine.sql').read_text(),
        (repo / 'libraries/mecha/services/compute/job-cache.sql').read_text(),
        """CREATE TABLE IF NOT EXISTS compute.machine_version (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          fingerprint text NOT NULL
        );
        REVOKE ALL ON TABLE compute.machine_version, compute.job_result, compute.job_cache_size FROM PUBLIC;
        ALTER TABLE compute.machine_version ENABLE ROW LEVEL SECURITY;
        ALTER TABLE compute.job_result ENABLE ROW LEVEL SECURITY;
        ALTER TABLE compute.job_cache_size ENABLE ROW LEVEL SECURITY;""",
        (repo / 'libraries/mecha/services/compute/batches.sql').read_text(),
    ])
    subprocess.run(
        ['docker', 'exec', '-i', target, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
         '--single-transaction', '-U', 'postgres', '-d', 'golaberto'],
        input=bootstrap, text=True, capture_output=True, check=True,
    )


def restore_dump(dump: Path, target: str):
    """Restore only archive tables, leaving target-only runtime state intact."""
    check_dump(dump, target)
    work = '/tmp/golaberto-archive-' + uuid.uuid4().hex
    docker('exec', target, 'mkdir', work)
    try:
        docker('cp', str(dump), f'{target}:{work}/archive.dump')
        listing = docker('exec', target, 'pg_restore', '-l', f'{work}/archive.dump')
        if re.search(r'^\d+; \d+ \d+ TABLE DATA compute definition ', listing, re.M):
            ensure_compute_schema(target)
        catalog = json.loads(docker('exec', target, 'psql', '-X', '-U', 'postgres', '-d', 'golaberto', '-Atc', """
            SELECT coalesce(json_agg(row_to_json(x)),'[]') FROM (
              SELECT c.relkind::text AS kind, n.nspname || '.' || c.relname AS name,
                     format('%I.%I', n.nspname, c.relname) AS quoted,
                     s.seqincrement, s.seqmin, s.seqmax, s.seqcycle
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              LEFT JOIN pg_sequence s ON s.seqrelid=c.oid
              WHERE c.relkind IN ('r','p','S') AND n.nspname NOT IN ('pgroll','information_schema')
                AND n.nspname !~ '^pg_') x"""))
        tables = {row['name']: row['quoted'] for row in catalog if row['kind'] in ('r', 'p')}
        sequences = {row['name']: row for row in catalog if row['kind'] == 'S'}
        wanted, selected, missing, sequence_entries = [], set(), [], []
        for line in listing.splitlines():
            match = re.match(r'^\d+; \d+ \d+ (TABLE DATA|SEQUENCE SET) (\S+) (\S+) ', line)
            if not match:
                continue
            kind, schema, name = match.groups()
            qualified = schema + '.' + name
            if kind == 'TABLE DATA' and qualified in tables:
                selected.add(qualified)
                wanted.append(line)
            elif kind == 'SEQUENCE SET' and qualified in sequences:
                sequence_entries.append(line)
            elif kind == 'TABLE DATA' and schema != 'pgroll':
                missing.append(qualified)
        if not selected:
            raise ValueError('archive has no table data made by the destination migrations')
        if missing:
            print('left out, not made by these migrations: ' + ', '.join(sorted(missing)))
        with tempfile.TemporaryDirectory(prefix='golaberto-archive-') as tmp:
            selection = Path(tmp) / 'archive.list'
            selection.write_text('\n'.join(wanted) + '\n')
            docker('cp', str(selection), f'{target}:{work}/archive.list')
            docker('cp', str(Path(__file__).parent / 'archive/check-fks.sql'), f'{target}:{work}/check-fks.sql')
            docker('exec', target, 'pg_restore', '-f', f'{work}/archive.sql', '--data-only',
                   '-L', f'{work}/archive.list', f'{work}/archive.dump')
            restarts = []
            if sequence_entries:
                sequence_list = Path(tmp) / 'sequences.list'
                sequence_list.write_text('\n'.join(sequence_entries) + '\n')
                docker('cp', str(sequence_list), f'{target}:{work}/sequences.list')
                source = docker('exec', target, 'pg_restore', '-f', '-', '--data-only',
                                '-L', f'{work}/sequences.list', f'{work}/archive.dump')
                seen = set()
                for line in source.splitlines():
                    if not line.startswith('SELECT pg_catalog.setval('):
                        continue
                    match = re.fullmatch(r"SELECT pg_catalog\.setval\('([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)', (-?\d+), (true|false)\);", line)
                    if not match or match[1] not in sequences or match[1] in seen:
                        raise ValueError('unsupported archive sequence state')
                    seen.add(match[1])
                    seq = sequences[match[1]]
                    next_value = sequence_restart(int(match[2]), match[3] == 'true', seq['seqincrement'],
                                                  seq['seqmin'], seq['seqmax'], seq['seqcycle'])
                    restarts.append(f"ALTER SEQUENCE {seq['quoted']} RESTART WITH {next_value};")
                if len(seen) != len(sequence_entries):
                    raise ValueError('archive sequence state is missing or duplicated')
            delete_statements = [f'DELETE FROM {tables[name]};' for name in sorted(selected)]
            post_check = 'SELECT 1'
            if 'compute.definition' in selected:
                if 'durex.pool' in tables:
                    delete_statements.append(f"DELETE FROM {tables['durex.pool']} WHERE owner = 'compute';")
                if 'graphile_worker._private_jobs' in tables and 'graphile_worker._private_tasks' in tables:
                    delete_statements.append(
                        f"DELETE FROM {tables['graphile_worker._private_jobs']} j "
                        f"USING {tables['graphile_worker._private_tasks']} t "
                        "WHERE j.task_id = t.id AND t.identifier = 'compute_batch';"
                    )
                post_check = """DO $$ BEGIN
                  IF EXISTS (
                    SELECT FROM compute.definition d JOIN compute.batch b USING (name)
                    LEFT JOIN compute.capture c USING (instance_id)
                    WHERE NOT d.enabled OR b.completed = 0 OR b.requested <> b.completed
                       OR b.claimed IS NOT NULL OR b.wake IS NOT NULL OR b.inputs IS NOT NULL
                       OR c.instance_id IS NULL OR c.claimed_coverage IS NOT NULL
                       OR (c.completed_coverage - 'digest') IS DISTINCT FROM compute.current_coverage(d.name)
                  ) THEN
                    RAISE EXCEPTION 'restored archive computation coverage does not match restored tables';
                  END IF;
                END $$;"""
            deletes = ' '.join(delete_statements)
            reset_slots = """SELECT pg_create_logical_replication_slot(slot_name, plugin)
              FROM (SELECT slot_name, plugin, pg_drop_replication_slot(slot_name)
                    FROM pg_replication_slots WHERE NOT active AND slot_type = 'logical') s"""
            docker('exec', target, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction',
                   '-U', 'postgres', '-d', 'golaberto', '-c', "SET LOCAL session_replication_role = 'replica'",
                   '-c', deletes, '-f', f'{work}/archive.sql', '-c', ' '.join(restarts) or 'SELECT 1',
                   '-f', f'{work}/check-fks.sql', '-c', post_check)
            docker('exec', target, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                   '-U', 'postgres', '-d', 'golaberto', '-c', reset_slots)
    finally:
        docker('exec', target, 'rm', '-f', f'{work}/archive.dump', f'{work}/archive.list',
               f'{work}/archive.sql', f'{work}/check-fks.sql', f'{work}/sequences.list')
        docker('exec', target, 'rmdir', work)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    check = commands.add_parser('check-project')
    check.add_argument('--project',required=True,type=project_name)
    restore = commands.add_parser('restore-source')
    restore.add_argument('--project',required=True,type=project_name)
    restore.add_argument('--archive',type=Path,required=True)
    restore.add_argument('--provenance',type=Path,required=True)
    ready = commands.add_parser('source-ready')
    ready.add_argument('--project',required=True,type=project_name)
    ready.add_argument('--provenance',type=Path,required=True)
    dump = commands.add_parser('check-dump')
    dump.add_argument('--dump',type=Path,required=True)
    dump.add_argument('--target',required=True)
    restore = commands.add_parser('restore-dump')
    restore.add_argument('--dump',type=Path,required=True)
    restore.add_argument('--target',required=True)
    args = parser.parse_args()
    if args.command=='check-project':
        check_new_project(args.project)
    elif args.command=='restore-source':
        restore_source(args.project,args.archive,json.loads(args.provenance.read_text()))
    elif args.command=='source-ready':
        source_ready(args.project,json.loads(args.provenance.read_text()))
    elif args.command=='check-dump':
        check_dump(args.dump,args.target)
    else:
        restore_dump(args.dump,args.target)


if __name__=='__main__':
    main()
