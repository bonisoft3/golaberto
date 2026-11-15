"""Writes tests/sofascore-normalize.json: inputs for rules/sofascore/normalize.js
and what normalize.py answers for them, so the parity test needs no Python.

Run with the project's pinned Python from apps/golaberto:
    python3 tools/sofascore/normalize_fixtures.py
"""

import copy
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from normalize import normalize_details, normalize_events  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parents[2] / "tests" / "sofascore-normalize.json"


def raw_event(**changes):
    raw = {"id": 1, "homeTeam": {"id": 10, "name": "A"}, "awayTeam": {"id": 20, "name": "B"}, "tournament": {"id": 30},
           "roundInfo": {"round": 1}, "startTimestamp": 1704153600, "status": {"type": "finished"},
           "homeScore": {"normaltime": 1, "current": 2, "extra1": 1, "extra2": 0, "penalties": 4},
           "awayScore": {"normaltime": 1, "current": 1, "extra1": 0, "extra2": 0, "penalties": 3}}
    raw.update(changes)
    return raw


def entry(pid, sub=False, **player):
    return {"player": {"id": pid, "name": f"Player {pid}", **player}, "substitute": sub}


def lineups_fixture():
    return {"home": {"players": [entry(1), entry(2, True), entry(3, True)]}, "away": {"players": [entry(4), entry(5)]}}


def incidents_fixture():
    return {"incidents": [
        {"id": 17, "incidentType": "period", "time": 120},
        {"id": 16, "incidentType": "goal", "incidentClass": "regular", "isHome": True, "time": 111, "player": {"id": 2}},
        {"id": 15, "incidentType": "card", "incidentClass": "yellowRed", "isHome": True, "time": 100, "player": {"id": 2}},
        {"id": 14, "incidentType": "substitution", "isHome": True, "time": 70, "playerIn": {"id": 2}, "playerOut": {"id": 1}},
        {"id": 13, "incidentType": "goal", "incidentClass": "ownGoal", "isHome": False, "time": 45, "addedTime": 2, "player": {"id": 1}},
        {"id": 12, "incidentType": "goal", "incidentClass": "penalty", "isHome": True, "time": 10, "player": {"id": 1}},
        {"incidentType": "goal", "incidentClass": "regular", "isHome": True, "time": 999, "player": {"id": 1}},
    ]}


EVENTS = {
    "extra time and penalties": [raw_event()],
    "unconfirmed start": [raw_event(startTimeConfirmed=False)],
    "time to be decided": [raw_event(timeTBD=True), raw_event(id=2, startTimeTBD=True), raw_event(id=3, timeConfirmed=False)],
    "after extra time totals": [raw_event(homeScore={"normaltime": 1, "afterExtraTime": 2}, awayScore={"normaltime": 1, "afterExtraTime": 1})],
    "statuses": [raw_event(id=i + 1, status={"type": t}) for i, t in enumerate(
        ("inprogress", "interrupted", "postponed", "canceled", "unknown", "notstarted", "suspended", "awarded", "FINISHED", "cancelled", "abandoned"))],
    "descriptions": [raw_event(id=1, status={"type": "finished", "description": "Awarded"}),
                     raw_event(id=2, status={"type": "notstarted", "description": "Walkover"}),
                     raw_event(id=3, status={"type": "inprogress", "description": "Abandoned"}),
                     raw_event(id=4, status={"type": "finished", "description": None}),
                     raw_event(id=5, status={"type": "finished", "description": 7})],
    "Sao Paulo day boundary": [raw_event(id=1, startTimestamp=1704162600), raw_event(id=2, startTimestamp=1704162600, startTimeConfirmed=False)],
    "fractional starts": [raw_event(id=1, startTimestamp=1704153600.5), raw_event(id=2, startTimestamp=1704153600.0000005),
                          raw_event(id=3, startTimestamp=1704153600.0000015), raw_event(id=4, startTimestamp=-1.5),
                          raw_event(id=5, startTimestamp=-86400.25)],
    "stage keys": [raw_event(id=1, tournament={}), raw_event(id=2, tournament={"id": 30, "uniqueTournament": {"id": 7}}),
                   raw_event(id=3, roundInfo={"round": 2, "slug": "quarterfinals"}),
                   raw_event(id=4, roundInfo={"round": 3, "slug": "final", "prefix": "Copa"}),
                   raw_event(id=5, roundInfo={"slug": "são-paulo \"x\"\n"}),
                   raw_event(id=6, roundInfo={"prefix": 2.5, "slug": ""}),
                   raw_event(id=7, roundInfo={"prefix": 1e-05}),
                   raw_event(id=8, roundInfo={"slug": ["a", {"b": None}]}),
                   raw_event(id=9, tournament={"id": "0"}),
                   raw_event(id=10, tournament={"id": None})],
    "seasons": [raw_event(id=1, season={"id": 52}), raw_event(id=2, season={}), raw_event(id=3, season={"id": "0042"})],
    "string identities": [raw_event(id="0012", homeTeam={"id": "10", "name": "A"}, awayTeam={"id": "9223372036854775807", "name": "B"})],
    "scores": [raw_event(id=1, homeScore={"current": 2}, awayScore={"current": 1}),
               raw_event(id=2, homeScore={"display": 0}, awayScore={"display": 3}),
               raw_event(id=3, homeScore={"normaltime": 1, "penalties": 4}, awayScore={"normaltime": 1}),
               raw_event(id=4, homeScore={"normaltime": 1, "extra1": 1}, awayScore={"normaltime": 1}),
               raw_event(id=5, homeScore={"FINAL_RESULT": 0}, awayScore={"finalResult": 0}),
               raw_event(id=6, homeScore={}, awayScore={}),
               raw_event(id=7, homeScore={"normaltime": 2, "afterExtraTime": 1}, awayScore={"normaltime": 1, "afterExtraTime": 1})],
    "runtime event": [{"id": 10, "homeTeam": {"id": 1, "name": "Home"}, "awayTeam": {"id": 2, "name": "Away"}, "status": {"type": "finished"},
                       "startTimestamp": 1761523200, "homeScore": {"current": 0}, "awayScore": {"current": 0}, "tournament": {"id": 5}, "roundInfo": {"round": 1}}],
    "empty round": [],
}

EVENT_ERRORS = {
    "no events": {},
    "events not a list": {"events": {}},
    "event not an object": {"events": [None]},
    "same teams": {"events": [raw_event(awayTeam={"id": 10, "name": "B"})]},
    "unnamed team": {"events": [raw_event(homeTeam={"id": 10})]},
    "status without type": {"events": [raw_event(status={})]},
    "missing start": {"events": [{k: v for k, v in raw_event().items() if k != "startTimestamp"}]},
    "boolean start": {"events": [raw_event(startTimestamp=True)]},
    "null tournament": {"events": [raw_event(tournament=None)]},
    "null season": {"events": [raw_event(season=None)]},
    "list unique tournament": {"events": [raw_event(tournament={"id": 1, "uniqueTournament": []})]},
    "negative score": {"events": [raw_event(homeScore={"normaltime": -1}, awayScore={"normaltime": 0})]},
    "fractional score": {"events": [raw_event(homeScore={"normaltime": 1.5}, awayScore={"normaltime": 0})]},
    "null home score": {"events": [raw_event(homeScore=None)]},
}


def details_cases():
    base = raw_event()
    scoreless = raw_event(homeScore={"normaltime": 0}, awayScore={"normaltime": 0})
    cases = {"complete final": (lineups_fixture(), incidents_fixture(), base)}
    incidents = incidents_fixture()
    incidents["incidents"][1]["player"] = {"id": 999}
    cases["unknown scorer"] = (lineups_fixture(), incidents, base)
    cases["empty home lineup"] = ({"home": {"players": []}}, {"incidents": []}, base)
    cases["incidents missing"] = (lineups_fixture(), {}, base)
    cases["incidents null"] = (lineups_fixture(), {"incidents": None}, base)
    cases["scoreless without incidents"] = (lineups_fixture(), {"incidents": []}, scoreless)
    used = lineups_fixture()
    used["home"]["players"][1]["statistics"] = {"minutesPlayed": 20}
    cases["used substitute without incident"] = (used, {"incidents": []}, scoreless)
    unused = copy.deepcopy(used)
    unused["home"]["players"][1]["statistics"]["minutesPlayed"] = 0
    cases["substitute who did not play"] = (unused, {"incidents": []}, scoreless)
    cases["used substitute with incident"] = (used, {"incidents": [{"incidentType": "substitution", "isHome": True, "time": 70, "playerIn": {"id": 2}, "playerOut": {"id": 1}}]}, scoreless)
    rich = {"home": {"players": [entry(1, shortName="P. One", dateOfBirthTimestamp=-315619200, country={"name": "Brazil"}, height=180, position="F"),
                                 entry(2, True, shortName="", country={}), entry(1), {"player": {"id": 6, "name": "No flag"}},
                                 {"player": {"id": 7}, "substitute": False}]},
            "away": {"players": [entry(4), entry(5, True)]}}
    rich_incidents = {"incidents": [
        {"incidentType": "period", "timeSeconds": 5460},
        {"id": 21, "incidentType": "goal", "incidentClass": "regular", "pos": 0, "timeSeconds": 600, "player": {"id": 1}},
        {"id": 22, "incidentType": "goal", "incidentClass": "missedPenalty", "isHome": True, "time": 30, "player": {"id": 1}},
        {"id": 23, "incidentType": "card", "incidentClass": "red", "isHome": False, "time": 60, "player": {"id": 4}},
        {"id": 24, "incidentType": "card", "incidentClass": "yellow", "isHome": False, "time": 61, "player": {"id": 5}},
        {"id": 25, "incidentType": "card", "incidentClass": "yellow", "isHome": True, "time": 62},
        {"id": 26, "incidentType": "card", "incidentClass": "yellow", "isHome": True, "time": 63, "player": {"id": 99}},
        {"id": 27, "incidentType": "substitution", "pos": 1, "time": 70, "addedTime": 3, "playerIn": {"id": 5}, "playerOut": {"id": 4}},
        {"id": 28, "incidentType": "substitution", "isHome": True, "time": 70, "addedTime": 1, "playerIn": {}, "playerOut": None},
        {"id": 29, "incidentType": "goal", "incidentClass": "regular", "time": 80, "period": "2nd", "player": {"id": 1}},
        {"id": 30, "incidentType": "injuryTime", "time": 90, "addedTime": 4},
        {"id": 31, "incidentType": "goal", "incidentClass": "penaltyShootout", "isHome": True, "time": 121, "player": {"id": 1}},
        {"id": 32, "incidentType": "goal", "incidentClass": "regular", "isHome": True, "player": {"id": 1}},
    ]}
    played = raw_event(homeScore={"normaltime": 2}, awayScore={"normaltime": 0})
    cases["mixed incidents"] = (rich, rich_incidents, played)
    cases["away lineup missing"] = ({"home": {"players": [entry(1)]}}, {"incidents": []}, raw_event(status={"type": "notstarted"}))
    return cases


DETAIL_ERRORS = {
    "players not a list": ({"home": {"players": "bad"}}, {"incidents": []}),
    "incidents not a list": (lineups_fixture(), {"incidents": "bad"}),
    "incident not an object": (lineups_fixture(), {"incidents": [1]}),
    "fractional minute": (lineups_fixture(), {"incidents": [{"incidentType": "goal", "time": 1.5}]}),
    "negative added time": (lineups_fixture(), {"incidents": [{"incidentType": "goal", "incidentClass": "regular", "time": 5, "addedTime": -1}]}),
    "lineup player not an object": ({"home": {"players": [{"player": None, "substitute": False}]}}, {"incidents": []}),
    "string scorer": (lineups_fixture(), {"incidents": [{"incidentType": "goal", "incidentClass": "regular", "time": 5, "player": "x"}]}),
    "card player not an object": (lineups_fixture(), {"incidents": [{"incidentType": "card", "incidentClass": "red", "time": 5, "player": [1]}]}),
    "fractional minutes played": ({"home": {"players": [{**entry(1), "statistics": {"minutesPlayed": 2.5}}]}}, {"incidents": []}),
}


def roundtrip(value):
    return json.loads(json.dumps(value))


def main():
    cases = []
    for name, events in EVENTS.items():
        payload = roundtrip({"events": events})
        cases.append({"name": name, "input": {"kind": "events", "payload": payload}, "expect": normalize_events(payload)})
    for name, payload in EVENT_ERRORS.items():
        payload = roundtrip(payload)
        try:
            normalize_events(payload)
        except (ValueError, AttributeError, TypeError, OverflowError) as e:
            cases.append({"name": name, "input": {"kind": "events", "payload": payload}, "raises": type(e).__name__})
        else:
            raise SystemExit(f"{name}: normalize_events did not raise")
    for name, (lineups, incidents, raw) in details_cases().items():
        lineups, incidents = roundtrip(lineups), roundtrip(incidents)
        event = normalize_events(roundtrip({"events": [raw]}))[0]
        cases.append({"name": name, "input": {"kind": "details", "lineups": lineups, "incidents": incidents, "event": event},
                      "expect": normalize_details(lineups, incidents, event)})
    event = normalize_events(roundtrip({"events": [raw_event()]}))[0]
    for name, (lineups, incidents) in DETAIL_ERRORS.items():
        lineups, incidents = roundtrip(lineups), roundtrip(incidents)
        try:
            normalize_details(lineups, incidents, event)
        except (ValueError, AttributeError, TypeError) as e:
            cases.append({"name": name, "input": {"kind": "details", "lineups": lineups, "incidents": incidents, "event": event}, "raises": type(e).__name__})
        else:
            raise SystemExit(f"{name}: normalize_details did not raise")
    OUT.write_text(json.dumps(cases, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"{len(cases)} cases written to {OUT}")


if __name__ == "__main__":
    main()
