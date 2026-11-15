import copy
import unittest

from normalize import normalize_details, normalize_events, semantic_hash


def event(**changes):
    raw = {"id": 1, "homeTeam": {"id": 10, "name": "A"}, "awayTeam": {"id": 20, "name": "B"}, "tournament": {"id": 30}, "roundInfo": {"round": 1}, "startTimestamp": 1704153600, "status": {"type": "finished"}, "homeScore": {"normaltime": 1, "current": 2, "extra1": 1, "extra2": 0, "penalties": 4}, "awayScore": {"normaltime": 1, "current": 1, "extra1": 0, "extra2": 0, "penalties": 3}}
    raw.update(changes)
    return normalize_events({"events": [raw]})[0]


def entry(pid, sub=False):
    return {"player": {"id": pid, "name": f"Player {pid}"}, "substitute": sub}


def fixture():
    lineups = {"home": {"players": [entry(1), entry(2, True), entry(3, True)]}, "away": {"players": [entry(4), entry(5)]}}
    incidents = {"incidents": [
        {"id": 17, "incidentType": "period", "time": 120},
        {"id": 16, "incidentType": "goal", "incidentClass": "regular", "isHome": True, "time": 111, "player": {"id": 2}},
        {"id": 15, "incidentType": "card", "incidentClass": "yellowRed", "isHome": True, "time": 100, "player": {"id": 2}},
        {"id": 14, "incidentType": "substitution", "isHome": True, "time": 70, "playerIn": {"id": 2}, "playerOut": {"id": 1}},
        {"id": 13, "incidentType": "goal", "incidentClass": "ownGoal", "isHome": False, "time": 45, "addedTime": 2, "player": {"id": 1}},
        {"id": 12, "incidentType": "goal", "incidentClass": "penalty", "isHome": True, "time": 10, "player": {"id": 1}},
        {"incidentType": "goal", "incidentClass": "regular", "isHome": True, "time": 999, "player": {"id": 1}},
    ]}
    return lineups, incidents


class NormalizationTest(unittest.TestCase):
    def test_scores_day_and_precision(self):
        e = event()
        self.assertEqual((e['home_score'], e['away_score'], e['home_aet'], e['away_aet'], e['home_pen'], e['away_pen']), (1, 1, 1, 0, 4, 3))
        self.assertEqual(e['day'], '2024-01-01')
        self.assertTrue(e['played'])
        self.assertIsNone(event(startTimeConfirmed=False)['kickoff'])
        self.assertEqual(event(homeScore={'normaltime': 1, 'afterExtraTime': 2}, awayScore={'normaltime': 1, 'afterExtraTime': 1})['home_aet'], 1)

    def test_live_and_unknown_never_publish_scores(self):
        for kind in ('inprogress', 'interrupted', 'postponed', 'canceled', 'unknown'):
            e = event(status={'type': kind})
            self.assertFalse(e['played'])
            self.assertIsNone(e['home_score'])

    def test_final_details_and_hash(self):
        lineups, incidents = fixture()
        detail = normalize_details(lineups, incidents, event())
        self.assertTrue(detail['complete'], detail['missing'])
        apps = {p['player_external_id']: p for p in detail['appearances']}
        self.assertEqual((apps['1']['on_minute'], apps['1']['off_minute']), (0, 70))
        self.assertEqual((apps['2']['on_minute'], apps['2']['off_minute'], apps['2']['yellow'], apps['2']['red']), (70, 100, True, True))
        self.assertTrue(apps['3']['bench'])
        self.assertIsNone(apps['3']['off_minute'])
        self.assertEqual(apps['4']['off_minute'], 120)
        self.assertIsNone(detail['players'][0]['birth'])
        own = next(g for g in detail['goals'] if g['own_goal'])
        self.assertEqual((own['side'], own['player_external_id'], own['added_time']), ('away', '1', 2))
        self.assertTrue(next(g for g in detail['goals'] if g['minute'] == 111)['aet'])
        modified = copy.deepcopy(detail)
        modified['goals'].reverse()
        modified['goals'][0]['source_order'] = 999
        self.assertEqual(semantic_hash(detail), semantic_hash(modified))

    def test_missing_participants_and_empty_details_are_incomplete(self):
        lineups, incidents = fixture()
        incidents['incidents'][1]['player'] = {'id': 999}
        d = normalize_details(lineups, incidents, event())
        self.assertFalse(d['complete'])
        self.assertTrue(any('goal' in m for m in d['missing']))
        self.assertFalse(normalize_details({'home': {'players': []}}, {'incidents': []}, event())['complete'])
        self.assertFalse(normalize_details(lineups, {}, event())['complete'])

    def test_empty_incidents_for_scoreless_final(self):
        lineups, _ = fixture()
        scoreless = event(homeScore={"normaltime": 0}, awayScore={"normaltime": 0})
        self.assertTrue(normalize_details(lineups, {"incidents": []}, scoreless)["complete"])

    def test_used_substitute_requires_an_incident(self):
        lineups, _ = fixture()
        scoreless = event(homeScore={"normaltime": 0}, awayScore={"normaltime": 0})
        substitute = lineups['home']['players'][1]
        substitute['statistics'] = {'minutesPlayed': 20}
        result = normalize_details(lineups, {'incidents': []}, scoreless)
        self.assertFalse(result['complete'])
        self.assertIn('substitute 2 played but substitution is missing', result['missing'])
        self.assertTrue(next(a for a in result['appearances'] if a['player_external_id'] == '2')['bench'])
        self.assertEqual(result['substitutions'], [])
        substitute['statistics']['minutesPlayed'] = 0
        self.assertTrue(normalize_details(lineups, {'incidents': []}, scoreless)['complete'])
        substitute['statistics']['minutesPlayed'] = 20
        incident = {'incidentType': 'substitution', 'isHome': True, 'time': 70,
                    'playerIn': {'id': 2}, 'playerOut': {'id': 1}}
        self.assertTrue(normalize_details(lineups, {'incidents': [incident]}, scoreless)['complete'])

    def test_invalid_payloads_fail(self):
        for payload in ({}, {'events': {}}, {'events': [None]}):
            with self.assertRaises(ValueError):
                normalize_events(payload)
        with self.assertRaises(ValueError):
            normalize_details({'home': {'players': 'bad'}}, {'incidents': []}, event())


if __name__ == '__main__':
    unittest.main()
