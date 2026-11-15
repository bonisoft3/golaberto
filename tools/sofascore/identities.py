#!/usr/bin/env python3
"""Export and review existing SofaScore identifiers without changing either database."""
import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict

KINDS = {'team': 7, 'player': 11, 'game': 9, 'phase': 3, 'championship': 2}


def legacy_uuid(kind, number):
    if isinstance(number, bool) or not str(number).isdigit():
        raise ValueError('invalid legacy id')
    number = int(number)
    if kind not in KINDS or not 0 < number < 2**48:
        raise ValueError('legacy id outside namespace')
    return f'a{KINDS[kind]:02x}00000-0000-4000-8000-{number:012x}'


def positive_id(value):
    if isinstance(value, bool) or not re.fullmatch(r'[0-9]+', str(value or '')):
        raise ValueError('expected positive numeric identifier')
    number = int(value)
    if not 0 < number < 2**63:
        raise ValueError('expected positive numeric identifier within bigint range')
    return str(number)


def build_plan(records, targets, existing=(), sources=(), stages=(), phase_scopes=None):
    """Build a dry-run plan; every colliding candidate is quarantined.

    Records have entity_kind, local_source_id, external_id and provenance.
    Targets maps each kind to existing public UUIDs. Existing rows use the
    provider_binding shape. Source and stage rows include local legacy IDs;
    stage rows must include their phase's championship legacy ID for scope.
    """
    conflicts, candidates = [], []
    target_sets = {kind: set(ids) for kind, ids in targets.items()}
    phase_scopes = phase_scopes or {}
    for record in records:
        kind = record.get('entity_kind')
        value = record.get('external_id')
        if value is None or value == '':
            continue
        try:
            if kind not in ('team', 'player', 'game'):
                raise ValueError('unknown entity kind')
            external = positive_id(value)
            local = legacy_uuid(kind, record.get('local_source_id'))
        except ValueError as exc:
            conflicts.append({'reason': str(exc), 'record': record})
            continue
        binding = {'provider': 'sofascore', 'entity_kind': kind, 'external_id': external,
                   'local_id': local, 'state': 'confirmed', 'provenance': record.get('provenance', ''),
                   'evidence': {'local_source_id': str(record['local_source_id'])}}
        candidates.append(binding)

    # Repeated evidence for the same pair is harmless; different pairs are not.
    pairs = defaultdict(list)
    for item in candidates:
        pairs[(item['entity_kind'], item['external_id'], item['local_id'])].append(item)
    ext, local = defaultdict(set), defaultdict(set)
    for kind, external, target in pairs:
        ext[(kind, external)].add(target)
        local[(kind, target)].add(external)
    for item in existing:
        if item.get('provider') != 'sofascore' or item.get('state') != 'confirmed':
            continue
        kind, target = item['entity_kind'], item['local_id']
        external = positive_id(item['external_id'])
        ext[(kind, external)].add(target)
        local[(kind, target)].add(external)
    safe = []
    for (kind, external, target), evidence in sorted(pairs.items()):
        item = evidence[0].copy()
        item['provenance'] = ','.join(sorted({row['provenance'] for row in evidence}))
        if len(ext[(kind, external)]) > 1 or len(local[(kind, target)]) > 1:
            conflicts.append({'reason': 'conflicting identity', 'binding': item})
        elif target not in target_sets.get(kind, set()):
            conflicts.append({'reason': 'missing target', 'binding': item})
        else:
            safe.append(item)

    configs, stage_bindings = [], []
    source_keys = defaultdict(list)
    for row in sources:
        try:
            champ = legacy_uuid('championship', row['championship_id'])
            tournament = positive_id(row['unique_tournament_id'])
            season = positive_id(row['season_id'])
            if champ not in target_sets.get('championship', set()):
                raise ValueError('missing championship target')
            config = {'championship_id': champ, 'unique_tournament_id': int(tournament),
                      'season_id': int(season), 'enabled': False, 'detail_after': None}
            source_keys[(tournament, season)].append((row, config))
        except (KeyError, ValueError) as exc:
            conflicts.append({'reason': str(exc), 'source': row})
    accepted = {}
    for key, entries in source_keys.items():
        if len({entry[1]['championship_id'] for entry in entries}) != 1:
            conflicts.extend({'reason': 'conflicting source scope', 'source': row} for row, _ in entries)
        else:
            accepted[key] = entries[0][1]
            configs.append(entries[0][1])
    stage_keys = defaultdict(list)
    for row in stages:
        try:
            key = (positive_id(row['unique_tournament_id']), positive_id(row['season_id']))
            stage_key = positive_id(row['stage_key'])
            phase = legacy_uuid('phase', row['phase_id'])
            champ = legacy_uuid('championship', row['championship_id'])
            if key not in accepted or accepted[key]['championship_id'] != champ:
                raise ValueError('unverified stage scope')
            if phase not in target_sets.get('phase', set()):
                raise ValueError('missing phase target')
            if phase_scopes.get(phase) != champ:
                raise ValueError('phase championship mismatch')
            stage_keys[(key, stage_key)].append((row, phase))
        except (KeyError, ValueError) as exc:
            conflicts.append({'reason': str(exc), 'stage': row})
    for (key, stage_key), entries in stage_keys.items():
        if len({phase for _, phase in entries}) != 1:
            conflicts.extend({'reason': 'conflicting stage scope', 'stage': row} for row, _ in entries)
        else:
            stage_bindings.append({'unique_tournament_id': int(key[0]), 'season_id': int(key[1]),
                                   'stage_key': stage_key, 'phase_id': entries[0][1]})
    return {'candidate_bindings': safe, 'conflicts': conflicts,
            'source_configs': configs, 'stage_bindings': stage_bindings}


def run_json_lines(argv, query, runner=subprocess.run):
    try:
        result = runner(argv, input=query, text=True, capture_output=True, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f'{argv[0]} query failed: {exc.stderr}') from exc
    return [json.loads(line) for line in result.stdout.splitlines() if line]


def export_records(mysql_database='Golaberto_development', runner=subprocess.run, psql_command=None):
    """Read only provider IDs and target UUIDs, using client authentication settings."""
    mysql = ['mysql', '-u', 'root', '--batch', '--raw', '--skip-column-names', '--', mysql_database]
    pg = psql_command if psql_command is not None else ['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']
    if not isinstance(pg, list) or not pg or not all(isinstance(arg, str) and arg for arg in pg):
        raise ValueError('psql command must be a nonempty JSON array of strings')
    records = []
    for table, kind in [('teams', 'team'), ('games', 'game')]:
        query = ("SELECT JSON_OBJECT('entity_kind', '%s', 'local_source_id', id, "
                 "'external_id', sofascore_id, 'provenance', 'mysql.%s') FROM %s "
                 "WHERE sofascore_id IS NOT NULL AND sofascore_id <> '';" % (kind, table, table))
        records.extend(run_json_lines(mysql, query, runner))
    for table, kind in [('players', 'player'), ('games', 'game')]:
        query = ("SELECT json_build_object('entity_kind', '%s', 'local_source_id', id, "
                 "'external_id', sofascore_id, 'provenance', 'legacy.%s') FROM legacy.%s "
                 "WHERE sofascore_id IS NOT NULL AND sofascore_id::text <> '';" % (kind, table, table))
        records.extend(run_json_lines(pg, query, runner))
    targets = {}
    for kind in KINDS:
        targets[kind] = run_json_lines(pg, 'SELECT to_json(id::text) FROM public."%s";' % kind, runner)
    sources = run_json_lines(mysql, "SELECT JSON_OBJECT('championship_id', championship_id, 'unique_tournament_id', unique_tournament_id, 'season_id', season_id) FROM sofascore_championship_sources;", runner)
    phase_rows = run_json_lines(mysql, "SELECT JSON_OBJECT('phase_id', id, 'championship_id', championship_id, 'stage_keys', sofascore_tournament_ids) FROM phases WHERE sofascore_tournament_ids IS NOT NULL AND sofascore_tournament_ids <> '';", runner)
    stages = []
    for phase in phase_rows:
        matching_sources = [source for source in sources if str(source['championship_id']) == str(phase['championship_id'])]
        if not matching_sources:
            matching_sources = [{'championship_id': phase['championship_id']}]
        for source in matching_sources:
            for stage_key in re.split(r'[,\s]+', phase['stage_keys'].strip()):
                stages.append({**source, 'phase_id': phase['phase_id'], 'stage_key': stage_key})
    scope_rows = run_json_lines(pg, "SELECT json_build_object('phase_id', id::text, 'championship_id', championship_id::text) FROM public.phase;", runner)
    return {'records': records, 'targets': targets, 'existing': [], 'sources': sources, 'stages': stages,
            'phase_scopes': {row['phase_id']: row['championship_id'] for row in scope_rows}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    export = sub.add_parser('export')
    export.add_argument('--mysql-database', default='Golaberto_development')
    export.add_argument('--psql-command', type=json.loads, help='JSON argument vector; must read SQL on stdin and emit unaligned tuples only')
    recover = sub.add_parser('recover')
    recover.add_argument('input', help='JSON export, optionally augmented with existing mappings and reviewed source/stage scope')
    args = parser.parse_args(argv)
    if args.command == 'export':
        result = export_records(args.mysql_database, psql_command=args.psql_command)
    else:
        with open(args.input, encoding='utf-8') as stream:
            result = build_plan(**json.load(stream))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == '__main__':
    main()
