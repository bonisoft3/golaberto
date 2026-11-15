import copy
import unittest

from normalize import normalize_details
from reconcile import details_patch, event_patch
from test_normalize import event, fixture


def context():
    return {'source': {'id': 'source', 'championship_id': 'champ', 'detail_after': '2024-01-01T00:00:00Z', 'create_players': True}, 'bindings': [{'kind': 'team', 'external_id': '10', 'local_id': 'home'}, {'kind': 'team', 'external_id': '20', 'local_id': 'away'}], 'stages': {'30': 'phase'}, 'games': [], 'players': []}


def existing(c, played=False):
    c['games'].append({'id': 'existing', 'external_id': '1', 'phase_id': 'phase', 'home_id': 'home', 'away_id': 'away', 'played': played, 'day': '2024-01-01', 'kickoff': '2024-01-02T00:00:00Z'})


class ReconcileTest(unittest.TestCase):
    def test_stage_keys_do_not_fall_back_across_rounds(self):
        c = context()
        c['stages'] = {'37': 'regular'}
        bare = event(tournament={'id': 37})
        playoff = event(tournament={'id': 37}, roundInfo={'slug': 'playoff'})
        self.assertEqual(event_patch(bare, c)['rows'][0]['fields']['phase_id'], 'regular')
        p = event_patch(playoff, c)
        self.assertFalse(p['rows'])
        self.assertEqual(p['reviews'][0]['reason'], 'stage is not bound')
        self.assertEqual(p['reviews'][0]['evidence']['stage_key'], playoff['stage_key'])

        c['stages'][playoff['stage_key']] = 'playoff'
        self.assertEqual(event_patch(playoff, c)['rows'][0]['fields']['phase_id'], 'playoff')
        final = event(tournament={'id': 37}, roundInfo={'slug': 'final'})
        self.assertEqual(event_patch(final, c)['reviews'][0]['reason'], 'stage is not bound')

        existing(c)
        c['games'][0]['phase_id'] = 'regular'
        p = event_patch(playoff, c)
        self.assertFalse(p['rows'])
        self.assertEqual(p['reviews'][0]['reason'], 'bound fixture conflicts with stage or teams')

    def test_new_and_existing_fixture_stability(self):
        e, c = event(), context()
        first = event_patch(e, c)
        self.assertEqual(first, event_patch(e, c))
        self.assertEqual(first['rows'][0]['fields']['home_score'], 1)
        self.assertTrue(first['details_due'])
        self.assertNotIn('home', first['rows'][0]['fields'])
        existing(c)
        p = event_patch(e, c)
        self.assertEqual(p['rows'][0]['id'], 'existing')
        self.assertTrue(p['details_due'])

    def test_missing_bindings_or_candidate_never_create_fixture(self):
        c = context()
        c['bindings'].pop()
        p = event_patch(event(), c)
        self.assertEqual(p['rows'], [])
        self.assertEqual(p['reviews'][0]['kind'], 'team')
        c = context()
        existing(c)
        c['games'][0]['external_id'] = None
        p = event_patch(event(), c)
        self.assertEqual(p['rows'], [])
        self.assertEqual(p['reviews'][0]['evidence']['candidate_ids'], ['existing'])

    def test_no_live_regression_or_historical_detail_backfill(self):
        c = context()
        existing(c, played=True)
        live = event(status={'type': 'inprogress'})
        p = event_patch(live, c)
        self.assertFalse(p['rows'])
        self.assertTrue(p['reviews'])
        c['source']['detail_after'] = '2025-01-01T00:00:00Z'
        self.assertFalse(event_patch(event(), c)['details_due'])
        c['games'][0]['played'] = False
        self.assertTrue(event_patch(event(), c)['details_due'])

    def test_details_atomic_and_deterministic(self):
        c = context()
        existing(c)
        d = normalize_details(*fixture(), event())
        p = details_patch(d, event(), c)
        self.assertFalse(p['reviews'])
        self.assertEqual(len(p['collections']), 3)
        self.assertEqual(len([r for r in p['rows'] if r['table'] == 'goal']), 3)
        self.assertEqual(len([r for r in p['rows'] if r['table'] == 'player']), 5)
        reorder = copy.deepcopy(d)
        reorder['goals'].reverse()
        for g in reorder['goals']:
            g['source_order'] += 10
        q = details_patch(reorder, event(), c)
        self.assertEqual({r['id'] for r in p['rows']}, {r['id'] for r in q['rows']})
        incomplete = copy.deepcopy(d)
        incomplete['complete'] = False
        self.assertEqual(details_patch(incomplete, event(), c)['collections'], [])

    def test_goal_clock_survives_normalization_and_patch(self):
        c = context()
        existing(c)
        lineups, incidents = fixture()
        own = next(i for i in incidents['incidents'] if i.get('id') == 13)
        own['period'] = 'firstHalf'
        detail = normalize_details(lineups, incidents, event())
        goal = next(g for g in detail['goals'] if g['external_id'] == '13')
        self.assertEqual((goal['minute'], goal['added_time'], goal['period'], goal['source_order']), (45, 2, 'firstHalf', 4))
        patch = details_patch(detail, event(), c)
        self.assertFalse(patch['reviews'])
        row = next(r for r in patch['rows'] if r['table'] == 'goal' and r['fields']['own_goal'])
        self.assertEqual(tuple(row['fields'][k] for k in ('minute', 'added_time', 'period', 'source_order')), (45, 2, 'firstHalf', 4))

    def test_possible_player_and_collision_block_all_collections(self):
        c = context()
        existing(c)
        c['players'] = [{'id': 'old', 'name': 'Player 1', 'birth': None}]
        d = normalize_details(*fixture(), event())
        p = details_patch(d, event(), c)
        self.assertEqual(p['rows'], [])
        self.assertEqual(p['collections'], [])
        self.assertEqual(p['reviews'][0]['evidence']['candidate_ids'], ['old'])
        c['players'] = []
        d['goals'].append(copy.deepcopy(d['goals'][0]))
        p = details_patch(d, event(), c)
        self.assertEqual(p['rows'], [])
        self.assertEqual(p['collections'], [])
        self.assertTrue(p['reviews'])


if __name__ == '__main__':
    unittest.main()
