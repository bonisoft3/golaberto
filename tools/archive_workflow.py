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
import time


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
    args = parser.parse_args()
    if args.command=='check-project':
        check_new_project(args.project)
    elif args.command=='restore-source':
        restore_source(args.project,args.archive,json.loads(args.provenance.read_text()))
    elif args.command=='source-ready':
        source_ready(args.project,json.loads(args.provenance.read_text()))
    else:
        check_dump(args.dump,args.target)


if __name__=='__main__':
    main()
