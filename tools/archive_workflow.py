#!/usr/bin/env python3
"""Check a fresh trial project or restore a checksum-reviewed private archive."""
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
    check_new_project(project)
    container,volume = project+'-source',project+'_archive-source'
    docker('volume','create',volume)
    docker('run','-d','--name',container,'--network','none','--mount',
           'type=volume,source='+volume+',target=/var/lib/mysql',
           '-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-e','MYSQL_DATABASE='+provenance['source_database'],
           provenance['mysql_image'])
    client = ['docker','exec','-i',container,'mysql','-uroot','-D',provenance['source_database'],
              '--connect-timeout=2','--default-character-set=utf8mb4']
    wait_for_source(container,client)
    with gzip.open(archive,'rb') as source, subprocess.Popen(client,stdin=subprocess.PIPE) as destination:
        assert destination.stdin is not None
        shutil.copyfileobj(source,destination.stdin)
        destination.stdin.close()
        if destination.wait():
            raise RuntimeError('MySQL archive restore failed; restored resources are retained for inspection')
    docker('exec',container,'mysql','-uroot','-e','SET GLOBAL super_read_only=ON;')
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    check = commands.add_parser('check-project')
    check.add_argument('--project',required=True,type=project_name)
    restore = commands.add_parser('restore-source')
    restore.add_argument('--project',required=True,type=project_name)
    restore.add_argument('--archive',type=Path,required=True)
    restore.add_argument('--provenance',type=Path,required=True)
    args = parser.parse_args()
    if args.command=='check-project':
        check_new_project(args.project)
    else:
        restore_source(args.project,args.archive,json.loads(args.provenance.read_text()))


if __name__=='__main__':
    main()
