#!/usr/bin/env python3
"""Load the reviewed October archive into a freshly migrated Golaberto database."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE_SHA256 = '39ce0d8aea4da54fe0e61ae56d255cfb9872e0f730ef82a36c567517956f726a'
REVISION_SEQUENCES = {
    'player_metric_revision_seq', 'team_odds_chart_revision_seq',
    'team_profile_revision_seq', 'team_rating_chart_revision_seq',
    'team_roster_total_revision_seq',
}
HEADER = re.compile(rb'COPY ([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*) \((.*?)\) FROM stdin;\r?\n$')
SEQUENCE = re.compile(rb"SELECT pg_catalog\.setval\('public\.([a-z_]+)', (\d+), (true|false)\);\r?\n$")
CREDENTIAL = re.compile(r'password|credential|secret|token|passkey', re.I)
spec = importlib.util.spec_from_file_location('archive_workflow', HERE.parents[1] / 'tools/archive_workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


def psql(container, query):
    return subprocess.run(
        ['docker', 'exec', container, 'psql', '-X', '-U', 'postgres', '-d',
         'golaberto', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
        check=True, capture_output=True, text=True,
    ).stdout


def source_identity(source):
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
    if digest.hexdigest() != SOURCE_SHA256:
        raise ValueError('source SHA-256 does not match the reviewed archive')


def inspect_source(source, selected):
    headers, sequences = {}, {}
    with source.open('rb', buffering=1024 * 1024) as stream:
        for line in stream:
            match = HEADER.fullmatch(line)
            if match:
                table = match[1].decode()
                if table in selected:
                    columns = [x.strip().strip('"') for x in match[2].decode().split(',')]
                    if table in headers or CREDENTIAL.search(table) or any(CREDENTIAL.search(c) for c in columns):
                        raise ValueError(f'duplicate or credential-bearing table: {table}')
                    headers[table] = columns
            match = SEQUENCE.fullmatch(line)
            if match and match[1].decode() in REVISION_SEQUENCES:
                name = match[1].decode()
                if name in sequences:
                    raise ValueError(f'duplicate revision sequence: {name}')
                sequences[name] = (int(match[2]), match[3] == b'true')
    if set(headers) != selected or set(sequences) != REVISION_SEQUENCES:
        raise ValueError('archive does not contain the reviewed tables and revision sequences')
    return headers, sequences


def check_target(container, headers):
    query = """SELECT coalesce(json_agg(row_to_json(x)),'[]') FROM (
      SELECT c.table_schema,c.table_name,c.column_name,c.is_nullable,c.column_default,c.is_generated
      FROM information_schema.columns c JOIN pg_class r ON r.relname=c.table_name
      JOIN pg_namespace n ON n.oid=r.relnamespace AND n.nspname=c.table_schema
      WHERE c.table_schema IN ('public','golaberto_history','golaberto_upload') AND r.relkind IN ('r','p')) x"""
    columns = {}
    for c in json.loads(psql(container, query)):
        columns.setdefault(c['table_schema'] + '.' + c['table_name'], {})[c['column_name']] = c
    for table, source_columns in headers.items():
        target = columns.get(table, {})
        missing = set(source_columns) - set(target)
        required = {name for name, c in target.items() if name not in source_columns and
                    c['is_nullable'] == 'NO' and c['column_default'] is None and c['is_generated'] == 'NEVER'}
        if missing or required:
            raise ValueError(f'incompatible destination table {table}: missing={sorted(missing)}, required={sorted(required)}')
    ledger = json.loads(psql(container, """SELECT coalesce(json_object_agg(name,migration),'{}') FROM pgroll.migrations
      WHERE schema='public' AND migration_type='pgroll' AND done"""))
    migrations = HERE.parents[1] / 'services/database/pgroll'
    expected = {p.stem: json.loads(p.read_text()) for p in migrations.glob('*.json')}
    if not expected or ledger != expected or psql(container, "SELECT count(*) FROM pgroll.migrations WHERE schema='public' AND done IS NOT TRUE").strip() != '0':
        raise ValueError('destination pgroll ledger does not match current generated migrations')
    states = {}
    for name in sorted(REVISION_SEQUENCES):
        props = json.loads(psql(container, f"""SELECT row_to_json(x) FROM (
          SELECT s.seqincrement, s.seqmin, s.seqmax, s.seqcycle, v.last_value, v.is_called
          FROM pg_sequence s CROSS JOIN public.{name} v
          WHERE s.seqrelid='public.{name}'::regclass) x"""))
        if not props or props['seqcycle'] or abs(props['seqincrement']) != 1:
            raise ValueError(f'unsupported destination revision sequence: {name}')
        states[name] = props
    return states


def load(source, container):
    selected_list = json.loads((HERE / 'tables.json').read_text())
    selected = set(selected_list)
    if len(selected) != len(selected_list) or any(not re.fullmatch(r'[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*', t) for t in selected):
        raise ValueError('invalid reviewed table list')
    source_stat = source.stat()
    source_identity(source)
    checked_stat = source.stat()
    if (source_stat.st_dev, source_stat.st_ino, source_stat.st_size, source_stat.st_mtime_ns) != (checked_stat.st_dev, checked_stat.st_ino, checked_stat.st_size, checked_stat.st_mtime_ns):
        raise ValueError('source changed while verifying its SHA-256')
    headers, sequences = inspect_source(source, selected)
    sequence_states = check_target(container, headers)
    counts = {table: 0 for table in selected}
    seen = set()
    with tempfile.NamedTemporaryFile(prefix='golaberto-import-', suffix='.log', delete=False) as log:
        process = subprocess.Popen(
            ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
             '-U', 'postgres', '-d', 'golaberto'], stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            out = process.stdin
            out.write(b"BEGIN; SET LOCAL session_replication_role = 'replica';\n")
            for table in sorted(selected):
                out.write(f'DELETE FROM {table};\n'.encode())
            active = None
            with source.open('rb', buffering=1024 * 1024) as stream:
                for line in stream:
                    if active is not None:
                        out.write(line)
                        if line in (b'\\.\n', b'\\.\r\n'):
                            active = None
                        else:
                            counts[active] += 1
                    elif line.startswith(b'COPY '):
                        match = HEADER.fullmatch(line)
                        if match and match[1].decode() in selected:
                            active = match[1].decode()
                            if active in seen:
                                raise ValueError(f'duplicate COPY: {active}')
                            seen.add(active)
                            out.write(line)
            end_stat = source.stat()
            if active is not None or seen != selected or (source_stat.st_dev, source_stat.st_ino, source_stat.st_size, source_stat.st_mtime_ns) != (end_stat.st_dev, end_stat.st_ino, end_stat.st_size, end_stat.st_mtime_ns):
                raise ValueError('source changed or did not contain every reviewed COPY block')
            for table, count in sorted(counts.items()):
                out.write(f"DO $count$ BEGIN IF (SELECT count(*) FROM {table}) <> {count} THEN RAISE EXCEPTION 'row count mismatch: {table}'; END IF; END $count$;\n".encode())
            for name, (value, called) in sorted(sequences.items()):
                state = sequence_states[name]
                args = (state['seqincrement'], state['seqmin'], state['seqmax'], state['seqcycle'])
                source_next = workflow.sequence_restart(value, called, *args)
                target_next = workflow.sequence_restart(state['last_value'], state['is_called'], *args)
                next_value = max(source_next, target_next) if state['seqincrement'] > 0 else min(source_next, target_next)
                out.write(f"ALTER SEQUENCE public.{name} RESTART WITH {next_value};\n".encode())
            out.write((HERE.parents[1] / 'tools/archive/check-fks.sql').read_bytes())
            out.write(b'COMMIT;\n')
            out.close()
        except BaseException as error:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            process.wait()
            if isinstance(error, BrokenPipeError):
                raise RuntimeError(f'import failed and the transaction rolled back; private log: {log.name}') from error
            raise
        if process.wait():
            raise RuntimeError(f'import failed and the transaction rolled back; private log: {log.name}')
    Path(log.name).unlink()
    print(f'imported {len(counts)} tables; source counts and foreign keys match')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target-container', required=True)
    args = parser.parse_args()
    load(args.source, args.target_container)


if __name__ == '__main__':
    main()
