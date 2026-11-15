"""Writes tests/sofascore-reconcile.json: inputs for rules/sofascore/reconcile.js
and what reconcile.reconcile_events and reconcile.event_patch answer for them, so
the parity test needs no Python.

Run with the project's pinned Python from apps/golaberto:
    python3 tools/sofascore/reconcile_fixtures.py
"""

import copy
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from normalize import normalize_events  # noqa: E402
from reconcile import event_patch, reconcile_events  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parents[2] / "tests" / "sofascore-reconcile.json"
SOURCE = {"unique_tournament_id": 7, "season_id": 9, "event_scope": "competition"}


def raw(**changes):
    value = {"id": 1, "homeTeam": {"id": 10, "name": "A"}, "awayTeam": {"id": 20, "name": "B"}, "tournament": {"id": 30},
             "roundInfo": {"round": 1}, "startTimestamp": 1704153600, "status": {"type": "finished"},
             "homeScore": {"normaltime": 1, "current": 2, "extra1": 1, "extra2": 0, "penalties": 4},
             "awayScore": {"normaltime": 1, "current": 1, "extra1": 0, "extra2": 0, "penalties": 3}}
    value.update(changes)
    return value


def ctx(games=(), bindings=None, stages=None):
    return {"bindings": bindings if bindings is not None else [{"kind": "team", "external_id": "10", "local_id": "home"},
                                                               {"kind": "team", "external_id": "20", "local_id": "away"}],
            "stages": stages if stages is not None else {"30": "phase"}, "games": list(games)}


def game(**changes):
    value = {"id": "existing", "external_id": "1", "phase_id": "phase", "home_id": "home", "away_id": "away",
             "played": False, "sync_status": None}
    value.update(changes)
    return value


CASES = {
    "new fixture with a final": {"raw_events": [raw()], "ctx": ctx()},
    "existing bound fixture": {"raw_events": [raw()], "ctx": ctx([game()])},
    "existing fixture with a legacy status": {"raw_events": [raw(status={"type": "postponed"})], "ctx": ctx([game(sync_status="scheduled")])},
    "played fixture regresses to live": {"raw_events": [raw(status={"type": "inprogress"})], "ctx": ctx([game(played=True)])},
    "stage not bound": {"raw_events": [raw(tournament={"id": 37}, roundInfo={"slug": "playoff"})], "ctx": ctx(stages={"37": "regular"})},
    "slug stage bound": {"raw_events": [raw(tournament={"id": 37}, roundInfo={"slug": "playoff", "round": 2})],
                         "ctx": ctx(stages={"37": "regular", '37|{"slug": "playoff"}': "playoff"})},
    "fixture conflicts with stage": {"raw_events": [raw()], "ctx": ctx([game(phase_id="regular")])},
    "team not bound": {"raw_events": [raw()], "ctx": ctx(bindings=[{"kind": "team", "external_id": "10", "local_id": "home"}])},
    "same team on both sides": {"raw_events": [raw()], "ctx": ctx(bindings=[{"kind": "team", "external_id": "10", "local_id": "home"},
                                                                         {"kind": "team", "external_id": "20", "local_id": "home"}])},
    "unbound candidate": {"raw_events": [raw()], "ctx": ctx([game(external_id=None)])},
    "game bound by binding only": {"raw_events": [raw()], "ctx": ctx([game(id="g", external_id=None)],
                                                                   bindings=[{"kind": "team", "external_id": "10", "local_id": "home"},
                                                                             {"kind": "team", "external_id": "20", "local_id": "away"},
                                                                             {"kind": "game", "external_id": "1", "local_id": "g"}])},
    "terminal outcomes": {"raw_events": [raw(id=i + 1, status={"type": t}) for i, t in enumerate(("canceled", "abandoned", "awarded"))], "ctx": ctx()},
    "incomplete final": {"raw_events": [raw(homeScore={}, awayScore={})], "ctx": ctx()},
    "non-ASCII stage key": {"raw_events": [raw(tournament={"id": 37}, roundInfo={"slug": "fase-única"})],
                            "ctx": ctx(stages={'37|{"slug": "fase-\\u00fanica"}': "phase"})},
    "season and tournament agree": {"raw_events": [raw(season={"id": 9}, tournament={"id": 30, "uniqueTournament": {"id": 7}})], "ctx": ctx()},
    "season differs": {"raw_events": [raw(season={"id": 8})], "ctx": ctx()},
    "tournament differs": {"raw_events": [raw(tournament={"id": 30, "uniqueTournament": {"id": 6}})], "ctx": ctx()},
    "season is not an object": {"raw_events": [raw(season=9)], "ctx": ctx()},
    "season without id": {"raw_events": [raw(season={})], "ctx": ctx()},
    "event is not an object": {"raw_events": [3], "ctx": ctx()},
    "stages scope keeps bound stages and fixtures": {"raw_events": [raw(id=1), raw(id=2, tournament={"id": 31}), raw(id=3, tournament={"id": 32})],
                                                    "ctx": ctx([game(id="b", external_id="3", phase_id="other")]), "scope": "stages"},
    "fixtures scope keeps bound events": {"raw_events": [raw(id=1), raw(id=2)], "ctx": ctx([game(external_id="2")]), "scope": "fixtures"},
    "event response for another fixture": {"raw_events": [raw(id=2)], "ctx": ctx(), "family": "event", "requested_event": "1"},
    "event response for its fixture": {"raw_events": [raw(id=1)], "ctx": ctx(), "family": "event", "requested_event": "1"},
}


def main():
    cases = []
    for name, case in CASES.items():
        source = dict(SOURCE, event_scope=case.get("scope", "competition"))
        family, requested = case.get("family", "round"), case.get("requested_event")
        try:
            normalized = normalize_events({"events": copy.deepcopy(case["raw_events"])})
        except (ValueError, KeyError, TypeError, AttributeError):
            normalized = None
        entry = {"name": name, "input": {"family": family, "source": source, "requested_event": requested,
                                         "raw_events": case["raw_events"], "events": normalized, "ctx": case["ctx"]}}
        try:
            events = reconcile_events(family, source, requested, copy.deepcopy(case["raw_events"]), copy.deepcopy(case["ctx"]))
            context = dict(copy.deepcopy(case["ctx"]), source={"detail_after": None})
            patches = []
            for event in events:
                patch = event_patch(copy.deepcopy(event), context)
                patch.pop("details_due")
                patches.append(patch)
            entry["expect"] = {"events": events, "patches": patches}
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            entry["error"] = str(error)
        cases.append(entry)
    OUT.write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(cases)} cases written to {OUT}")


if __name__ == "__main__":
    main()
