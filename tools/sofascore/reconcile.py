"""Build reviewable domain patches from normalized SofaScore data."""

import datetime as dt
import hashlib
import json
import unicodedata
import uuid

from normalize import normalize_events

_NAMESPACE = uuid.UUID('e7aa3517-bf8c-5ee7-9e03-6269ff938cca')


def _uuid(kind, *parts):
    return str(uuid.uuid5(_NAMESPACE, json.dumps([kind, *map(str, parts)], ensure_ascii=False, separators=(',', ':'))))


def _patch(event):
    return {'rows': [], 'bindings': [], 'reviews': [], 'collections': [], 'details_due': False, 'event': event}


def _review(result, kind, external_id, reason, evidence):
    result['reviews'].append({'kind': kind, 'external_id': str(external_id), 'reason': reason, 'evidence': evidence})


def _bindings(context, kind, external_id):
    found = {str(b['local_id']) for b in context.get('bindings', []) if b['kind'] == kind and str(b['external_id']) == str(external_id)}
    if len(found) > 1:
        raise ValueError(f'conflicting {kind} bindings for {external_id}')
    return next(iter(found), None)


def _game(event, context):
    eid = str(event['external_id'])
    bound = _bindings(context, 'game', eid)
    matches = [g for g in context.get('games', []) if (bound and str(g['id']) == bound) or (g.get('external_id') is not None and str(g['external_id']) == eid)]
    ids = {str(g['id']) for g in matches}
    if len(ids) > 1:
        raise ValueError(f'conflicting games for {eid}')
    if bound and not matches:
        raise ValueError(f'game binding {eid} references missing game')
    return matches[0] if matches else None


def _instant(value):
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamps must include timezone')
    return parsed


def event_patch(event, context):
    result = _patch(event)
    eid = str(event['external_id'])
    source = context['source']
    game = _game(event, context)
    stage = context.get('stages', {}).get(event.get('stage_key', str(event['stage_id'])))
    teams = {side: _bindings(context, 'team', event[f'{side}_external_id']) for side in ('home', 'away')}
    if not stage:
        _review(result, 'stage', event['stage_id'], 'stage is not bound', {'event_id': eid, 'stage_key': event.get('stage_key', event['stage_id'])})
    for side, team in teams.items():
        if not team:
            _review(result, 'team', event[f'{side}_external_id'], 'team is not bound', {'name': event[side], 'side': side, 'event_id': eid, 'candidate_ids': [str(game[side+'_id'])] if game else []})
    if result['reviews']:
        return result
    if teams['home'] == teams['away']:
        _review(result, 'game', eid, 'both teams resolve to the same team', {'team_id': teams['home']})
        return result
    if game and (str(game['phase_id']) != str(stage) or str(game['home_id']) != teams['home'] or str(game['away_id']) != teams['away']):
        _review(result, 'game', eid, 'bound fixture conflicts with stage or teams', {'game_id': str(game['id'])})
        return result
    if not game:
        candidates = [g for g in context.get('games', []) if str(g['phase_id']) == str(stage) and str(g['home_id']) == teams['home'] and str(g['away_id']) == teams['away'] and not g.get('external_id')]
        if candidates:
            _review(result, 'game', eid, 'unbound fixture may already exist', {'candidate_ids': [str(g['id']) for g in candidates]})
            return result
    gid = str(game['id']) if game else _uuid('game', eid)
    status = event['status']
    if game and game.get('played') and (status != 'finished' or not event['played']):
        _review(result, 'game', eid, 'provider no longer reports a played final', {'game_id': gid, 'status': status})
        return result
    if status in ('cancelled', 'abandoned', 'awarded'):
        _review(result, 'game', eid, 'terminal outcome requires review', {'game_id': gid, 'status': status})
    fields = {'phase_id': str(stage), 'home_id': teams['home'], 'away_id': teams['away'], 'day': event['day'], 'kickoff': event['kickoff']}
    # Legacy NULL already means finished for played games, scheduled otherwise.
    effective = game.get('sync_status') or ('finished' if game.get('played') else 'scheduled') if game else None
    if not game or status in ('cancelled','abandoned','awarded','postponed','unknown') or effective not in ('scheduled','in_progress','finished') or (status == 'finished' and not game.get('played')):
        if effective != status:
            fields['sync_status'] = status
    if event.get('round_key') is not None and isinstance(event['round_key'], int) and not isinstance(event['round_key'], bool) and event['round_key'] > 0:
        fields['round'] = event['round_key']
    if status == 'finished' and event['played']:
        fields.update({k: event[k] for k in ('played', 'home_score', 'away_score', 'home_aet', 'away_aet', 'home_pen', 'away_pen')})
    elif status == 'finished':
        _review(result, 'game', eid, 'final score is incomplete', {'game_id': gid})
    result['rows'].append({'table': 'game', 'id': gid, 'fields': fields})
    if not _bindings(context, 'game', eid):
        result['bindings'].append({'kind': 'game', 'external_id': eid, 'local_id': gid})
    cutoff, kickoff = _instant(source.get('detail_after')), _instant(event.get('kickoff'))
    eligible = bool(game and not game.get('played')) or bool(cutoff and kickoff and kickoff >= cutoff) or event.get('detail_eligible') is True
    result['details_due'] = bool(status == 'finished' and event['played'] and eligible)
    return result


def _fold(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def _candidate(player, other):
    names = {_fold(player.get(k)) for k in ('name', 'full_name')} - {''}
    other_names = {_fold(other.get(k)) for k in ('name', 'full_name')} - {''}
    return bool(names & other_names) and (not player.get('birth') or not other.get('birth') or player['birth'] == other['birth'])


def _incident_id(kind, eid, incident):
    external = incident.get('external_id')
    if external:
        return _uuid(kind, external)
    values = {k: v for k, v in incident.items() if k not in ('external_id', 'source_order')}
    encoded = json.dumps(values, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return _uuid(kind, eid, hashlib.sha256(encoded).hexdigest())


def details_patch(detail, event, context):
    result = _patch(event)
    eid = str(event['external_id'])
    game = _game(event, context)
    if not game:
        _review(result, 'game', eid, 'game must exist before importing details', {})
        return result
    gid = str(game['id'])
    if not detail.get('complete'):
        _review(result, 'game', eid, 'details are incomplete', {'missing': detail.get('missing', [])})
        return result
    if not event.get('played') or event.get('status') != 'finished':
        _review(result, 'game', eid, 'details require a played final', {})
        return result
    source = context['source']
    resolved = {}
    pending_rows, pending_bindings = [], []
    for player in detail['players']:
        pid = str(player['external_id'])
        local = _bindings(context, 'player', pid)
        direct = {str(p['id']) for p in context.get('players', []) if p.get('external_id') is not None and str(p['external_id']) == pid}
        if local:
            direct.add(local)
        if len(direct) > 1:
            raise ValueError(f'conflicting player bindings for {pid}')
        if direct:
            local = next(iter(direct))
            if not _bindings(context, 'player', pid):
                pending_bindings.append({'kind': 'player', 'external_id': pid, 'local_id': local})
        else:
            candidates = [str(p['id']) for p in context.get('players', []) if _candidate(player, p)]
            if candidates:
                _review(result, 'player', pid, 'possible existing player requires review', {'name': player['name'], 'candidate_ids': candidates})
                continue
            if not source.get('create_players'):
                _review(result, 'player', pid, 'player is not bound', {'name': player['name']})
                continue
            local = _uuid('player', pid)
            fields = {k: player.get(k) for k in ('name', 'full_name', 'birth', 'country', 'height')}
            pending_rows.append({'table': 'player', 'id': local, 'fields': fields})
            pending_bindings.append({'kind': 'player', 'external_id': pid, 'local_id': local})
        resolved[pid] = local
    if result['reviews']:
        return result
    result['rows'].extend(pending_rows)
    result['bindings'].extend(pending_bindings)
    collection_ids = {'player_game': [], 'goal': [], 'substitution': []}
    for app in detail['appearances']:
        player_id = resolved[str(app['player_external_id'])]
        team_id = str(game[f"{app['side']}_id"])
        membership = {'championship_id': str(source['championship_id']), 'team_id': team_id, 'player_id': player_id}
        result['rows'].append({'table': 'team_player', 'id': _uuid('team_player', *membership.values()), 'fields': membership})
        rid = _uuid('player_game', gid, player_id)
        collection_ids['player_game'].append(rid)
        result['rows'].append({'table': 'player_game', 'id': rid, 'fields': {'game_id': gid, 'player_id': player_id, **{k: app[k] for k in ('side', 'on_minute', 'off_minute', 'bench', 'yellow', 'red')}}})
    for kind, plural in (('goal', 'goals'), ('substitution', 'substitutions')):
        for incident in detail[plural]:
            rid = _incident_id(kind, eid, incident)
            if rid in collection_ids[kind]:
                _review(result, kind, eid, 'indistinguishable incidents require review', {'incident': incident})
                continue
            collection_ids[kind].append(rid)
            fields = {'game_id': gid, **{k: incident[k] for k in ('side', 'minute')}}
            if kind == 'goal':
                fields.update(player_id=resolved[str(incident['player_external_id'])], **{k: incident[k] for k in ('penalty', 'own_goal', 'aet')}, added_time=incident.get('added_time'), period=incident.get('period'), source_order=incident.get('source_order'))
            else:
                fields.update(player_off_id=resolved[str(incident['player_off_external_id'])], player_on_id=resolved[str(incident['player_on_external_id'])], added_time=incident.get('added_time'), period=incident.get('period'), source_order=incident.get('source_order'))
            result['rows'].append({'table': kind, 'id': rid, 'fields': fields})
    if result['reviews']:
        result['rows'], result['bindings'] = [], []
        return result
    result['collections'] = [{'game_id': gid, 'table': table, 'ids': ids} for table, ids in collection_ids.items()]
    return result


def reconcile_events(family, source, requested_event, raw_events, ctx):
    """The response checks and scope filter of a round or event response."""
    if not isinstance(raw_events, list):
        raise ValueError('events must be a list')
    for raw in raw_events:
        if not isinstance(raw, dict):
            raise ValueError('event must be an object')
        tournament = raw.get('tournament', {})
        if not isinstance(tournament, dict) or ('season' in raw and not isinstance(raw['season'], dict)) or ('uniqueTournament' in tournament and not isinstance(tournament['uniqueTournament'], dict)):
            raise ValueError('invalid response source metadata')
    events = normalize_events({'events': raw_events})
    for raw, event in zip(raw_events, events):
        for name, container, key, normalized in (
            ('season', raw, 'season', 'season_id'),
            ('tournament', raw.get('tournament', {}), 'uniqueTournament', 'unique_tournament_id'),
        ):
            if key in container and (not isinstance(container[key], dict) or event[normalized] is None):
                raise ValueError(f'invalid response {name} id')
        if 'id' in raw.get('tournament', {}) and event['stage_id'] is None:
            raise ValueError('invalid response stage id')
        if event.get('season_id') is not None and int(event['season_id']) != source['season_id']:
            raise ValueError('response season differs from configured source')
        if event.get('unique_tournament_id') is not None and int(event['unique_tournament_id']) != source['unique_tournament_id']:
            raise ValueError('response tournament differs from configured source')
    scope = source.get('event_scope', 'competition')
    if scope not in ('competition', 'stages', 'fixtures'):
        raise ValueError('invalid event scope')
    bound = {str(g['external_id']) for g in ctx['games'] if g.get('external_id') is not None}
    stages = {base for key in ctx['stages'] if (base := key.split('|', 1)[0]).isdigit() and int(base) > 0}
    if family == 'event' and requested_event and any(e['external_id'] != requested_event for e in events):
        raise ValueError('response event differs from requested fixture')
    if scope == 'stages':
        events = [e for e in events if e['stage_id'] in stages or e['external_id'] in bound]
    elif scope == 'fixtures':
        events = [e for e in events if e['external_id'] in bound]
    return events
