#!/usr/bin/env python3
"""Export only reviewed archive data and the matching pgroll ledger."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_archive', HERE / 'import.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)

COMPUTE_OBJECTS = {
    'compute.machine_version',
    'compute.definition',
    'compute.capture',
    'compute.source',
    'compute.source_revision_seq',
    'compute.job_result',
    'compute.job_cache_size',
    'hybrid_compute_batch.instance',
    'hybrid_compute_batch.member',
    'hybrid_compute_batch.receipt',
    'durex.worker',
    'durex.work',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-container', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    tables = json.loads((HERE / 'tables.json').read_text())
    if len(set(tables)) != len(tables) or any(archive.CREDENTIAL.search(t) for t in tables):
        raise ValueError('invalid or credential-bearing table list')
    query = """SELECT coalesce(json_agg(row_to_json(x)),'[]') FROM (
      SELECT table_schema,table_name,column_name FROM information_schema.columns
      WHERE table_schema IN ('public','golaberto_history','golaberto_upload','compute','hybrid_compute_batch','durex')) x"""
    metadata = json.loads(archive.psql(args.source_container, query))
    selected = set(tables)
    has_compute = archive.psql(args.source_container, "SELECT to_regclass('compute.definition') IS NOT NULL").strip() == 't'
    if has_compute:
        state = json.loads(archive.psql(args.source_container, """
          SELECT json_build_object(
            'definitions', (SELECT count(*) FROM compute.definition),
            'unclean_batches', (
              SELECT count(*) FROM compute.definition d JOIN compute.batch b USING (name)
              WHERE NOT d.enabled OR b.completed = 0 OR b.requested <> b.completed
                 OR b.claimed IS NOT NULL OR b.wake IS NOT NULL OR b.inputs IS NOT NULL
            ),
            'unverified_coverage', (
              SELECT count(*) FROM compute.definition d LEFT JOIN compute.capture c USING (instance_id)
              WHERE c.instance_id IS NULL OR c.inputs IS NOT NULL OR c.claimed_coverage IS NOT NULL
                 OR (c.completed_coverage - 'digest') IS DISTINCT FROM compute.current_coverage(d.name)
            ),
            'pending_work', (
              SELECT count(*) FROM durex.work
              WHERE task = 'compute_batch' AND outcome IS NULL
            ),
            'dirty_projections', (
              SELECT coalesce(sum(n), 0) FROM (
                SELECT count(*) AS n FROM public.player_metric_dirty
                UNION ALL SELECT count(*) FROM public.team_roster_total_dirty
                UNION ALL SELECT count(*) FROM public.team_rating_chart_dirty
                UNION ALL SELECT count(*) FROM public.team_odds_chart_dirty
                UNION ALL SELECT count(*) FROM public.team_profile_dirty
              ) q
            )
          )"""))
        if state['definitions'] == 0 or any(state[k] != 0 for k in ('unclean_batches', 'unverified_coverage', 'pending_work', 'dirty_projections')):
            raise ValueError(f'refusing to export undrained or unverified computation state: {state}')
    checked_tables = selected | (COMPUTE_OBJECTS if has_compute else set())
    if any(archive.CREDENTIAL.search(c['column_name']) for c in metadata
           if c['table_schema'] + '.' + c['table_name'] in checked_tables):
        raise ValueError('a reviewed table now contains a credential-bearing column')
    sequences = {'public.' + name for name in archive.REVISION_SEQUENCES}
    included = checked_tables | sequences | {'pgroll.migrations', 'pgroll.pgroll_version'}
    command = ['docker', 'exec', args.source_container, 'pg_dump', '-U', 'postgres', '-d', 'golaberto',
               '-Fc', '--data-only', '--no-owner', '--no-acl']
    command.extend('--table=' + name for name in sorted(included))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        subprocess.run(command, stdout=output, check=True)
    with args.output.open('rb') as stream:
        listing = subprocess.run(['docker','exec','-i',args.source_container,'pg_restore','-l'],
                                 stdin=stream,capture_output=True,text=True,check=True).stdout
    actual = set()
    for line in listing.splitlines():
        match = re.match(r'^\d+; \d+ \d+ (?:TABLE DATA|SEQUENCE SET) (\S+) (\S+) ', line)
        if match:
            actual.add(match[1] + '.' + match[2])
    if actual != included:
        raise ValueError(f'dump data entries differ from reviewed list: {sorted(actual ^ included)}')
    subprocess.run([sys.executable, str(HERE.parents[1] / 'tools/archive_workflow.py'),
                    'check-dump', '--dump', str(args.output), '--target', args.source_container], check=True)
    digest = hashlib.sha256()
    with args.output.open('rb') as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
    print(f'{args.output}: sha256 {digest.hexdigest()}')


if __name__ == '__main__':
    main()
