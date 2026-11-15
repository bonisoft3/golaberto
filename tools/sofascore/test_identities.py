import json
import unittest
from types import SimpleNamespace

from identities import build_plan, export_records, legacy_uuid


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.team1, self.team2 = legacy_uuid('team', 1), legacy_uuid('team', 2)
        self.player = legacy_uuid('player', 3)
        self.targets = {'team': [self.team1, self.team2], 'player': [self.player], 'game': []}

    def record(self, kind, local, external, provenance='test'):
        return dict(entity_kind=kind, local_source_id=local, external_id=external, provenance=provenance)

    def test_duplicate_team_ids_quarantine_both_and_keep_other_kinds(self):
        records = [self.record('team', 1, 298263), self.record('team', 2, 298263),
                   self.record('player', 3, 298263), self.record('game', 4, 0)]
        plan = build_plan(records, self.targets)
        self.assertEqual([b['entity_kind'] for b in plan['candidate_bindings']], ['player'])
        self.assertEqual(len(plan['conflicts']), 3)

    def test_missing_target_still_quarantines_the_other_side(self):
        plan = build_plan([self.record('team', 1, 2), self.record('team', 99, 2)], self.targets)
        self.assertFalse(plan['candidate_bindings'])
        self.assertEqual(len(plan['conflicts']), 2)

    def test_repeated_evidence_and_prior_mappings(self):
        records = [self.record('team', 1, '002', 'mysql'), self.record('team', 1, '2', 'legacy'),
                   self.record('player', 3, 4)]
        existing = [dict(provider='sofascore', state='confirmed', entity_kind='player', external_id='9', local_id=self.player)]
        plan = build_plan(records, self.targets, existing)
        self.assertEqual(plan['candidate_bindings'][0]['provenance'], 'legacy,mysql')
        self.assertEqual(plan['candidate_bindings'][0]['external_id'], '2')
        self.assertEqual(plan['conflicts'][0]['reason'], 'conflicting identity')

    def test_stage_keys_are_season_scoped_and_many_to_one(self):
        champ, phase = legacy_uuid('championship', 1), legacy_uuid('phase', 2)
        targets = {'championship': [champ], 'phase': [phase]}
        sources = [dict(championship_id=1, unique_tournament_id=23, season_id=n) for n in (1, 2)]
        stages = [dict(**source, phase_id=2, stage_key=k) for source in sources for k in (10, 11)]
        plan = build_plan([], targets, sources=sources, stages=stages, phase_scopes={phase: champ})
        self.assertEqual(len(plan['source_configs']), 2)
        self.assertEqual(len(plan['stage_bindings']), 4)
        self.assertFalse(plan['conflicts'])
        self.assertTrue(all(not s['enabled'] for s in plan['source_configs']))
        bad = build_plan([], targets, sources=sources, stages=stages)
        self.assertEqual(len(bad['conflicts']), 4)

    def test_export_uses_argument_vectors_and_read_only_queries(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append((argv, kwargs['input']))
            return SimpleNamespace(stdout='')
        export_records('db; dangerous', runner)
        self.assertIn('db; dangerous', calls[0][0])
        self.assertTrue(all(q.startswith('SELECT ') for _, q in calls))
        self.assertTrue(all('shell' not in args for args, _ in calls))
        self.assertEqual(len(calls), 12)
        calls.clear()
        export_records(runner=runner, psql_command=['compose', 'exec', '-T', 'database', 'psql'])
        self.assertEqual(calls[2][0], ['compose', 'exec', '-T', 'database', 'psql'])
        with self.assertRaises(ValueError):
            export_records(runner=runner, psql_command='psql')

    def test_legacy_ids_are_bounded(self):
        self.assertEqual(legacy_uuid('team', 17), 'a0700000-0000-4000-8000-000000000011')
        for value in (0, -1, 2**48, True):
            with self.assertRaises(ValueError):
                legacy_uuid('team', value)


if __name__ == '__main__':
    unittest.main()
