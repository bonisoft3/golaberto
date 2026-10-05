"""Prepare a transactional refresh of public championship crawls.

This targets an archive imported with the legacy integer-ID UUID mapping,
not the small development seed. It writes SQL for review; it never connects
to a database, deletes archive rows, or writes pipeline-owned projections.
The crawler's anonymous requests render kickoff times in UTC.
"""

import argparse
import datetime as dt
import json
from pathlib import Path
import re
import uuid
from zoneinfo import ZoneInfo
from zone_values import color as zone_color, positions as zone_positions


def uid(kind, number):
    if not isinstance(number, int) or number <= 0:
        raise ValueError(f"invalid upstream ID: {number!r}")
    return f"a{kind:02x}00000-0000-4000-8000-{number:012x}"


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def upsert(table, columns, rows, update, conflict="id"):
    if not rows:
        return ""
    values = ",\n".join("(" + ",".join(map(literal, row)) + ")" for row in rows)
    old = ",".join(f"{table}.{c}" for c in update)
    new = ",".join(f"EXCLUDED.{c}" for c in update)
    action = "DO NOTHING" if not update else (
        "DO UPDATE SET " + ",".join(f"{c}=EXCLUDED.{c}" for c in update)
        + f" WHERE ({old}) IS DISTINCT FROM ({new})"
    )
    return f"INSERT INTO {table} ({','.join(columns)}) VALUES\n{values}\nON CONFLICT ({conflict}) {action};"


def prepare(snapshots):
    statements = ["\\set ON_ERROR_STOP on", "SET lock_timeout='5s';",
                  "SET statement_timeout='120s';", "BEGIN;",
                  "SELECT pg_advisory_xact_lock(hashtext('golaberto-public-refresh'));" ]
    seen_games = set()
    for snapshot in snapshots:
        match = re.fullmatch(r"/championship/show/(\d+)-[^/]+", snapshot["path"])
        if not match:
            raise ValueError("expected a public championship crawl path")
        championship = uid(2, int(match[1]))
        statements.append(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM championship WHERE id={literal(championship)}) THEN RAISE EXCEPTION 'Import the legacy archive first'; END IF; END $$;")
        phases, groups, memberships, zones, games = [], [], [], [], []
        for phase in snapshot["phases"]:
            phase_id = uid(3, phase["upstream"])
            phases.append((phase_id, championship, phase["name"], phase["position"]))
            teams = {}
            for position, group in enumerate(phase["groups"]):
                for team in group["teams"]:
                    team_id = uid(7, team["upstream"])
                    if team["name"] in teams and teams[team["name"]] != team_id:
                        raise ValueError("ambiguous team name within a phase")
                    teams[team["name"]] = team_id
                if group["upstream"] is None:
                    # Finished single-group phases hide their source ID. Keep
                    # their imported membership rather than inventing an ID.
                    guard = f"BEGIN IF (SELECT count(*) FROM stage_group WHERE phase_id={literal(phase_id)} AND name={literal(group['name'])}) <> 1 THEN RAISE EXCEPTION 'Cannot resolve an unnamed source group'; END IF; END"
                    statements.append("DO " + literal(guard) + ";")
                    continue
                group_id = uid(4, group["upstream"])
                groups.append((group_id, phase_id, group["name"], position))
                for team in group["teams"]:
                    team_id = uid(7, team["upstream"])
                    member_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://www.golaberto.com.br/group/{group['upstream']}/team/{team['upstream']}"))
                    memberships.append((member_id, group_id, team_id))
                for index, zone in enumerate(group["zones"]):
                    name = zone["name"]
                    places = zone_positions(zone)
                    zones.append((uid(5, group["upstream"] * 10000 + index * 100), group_id, name[:60], zone_color(zone["color"]), min(places), max(places), index, json.dumps(places)))
            for game in phase["games"]:
                game_id = uid(9, game["upstream"])
                if game_id in seen_games:
                    raise ValueError("duplicate game in input snapshots")
                seen_games.add(game_id)
                date = dt.datetime.strptime(game["date"], "%d/%m/%Y").date()
                kickoff = None
                if game["time"]:
                    instant = dt.datetime.combine(date, dt.datetime.strptime(game["time"], "%H:%M").time(), dt.timezone.utc)
                    kickoff = instant.isoformat()
                    date = instant.astimezone(ZoneInfo("America/Sao_Paulo")).date()
                score = game["score"] if game["played"] else [None, None]
                games.append((game_id, phase_id, game["round"], date.isoformat(), kickoff,
                              teams[game["home"]], teams[game["away"]], game["played"], *score))
        statements.extend([
            upsert("phase", ["id", "championship_id", "name", "position"], phases, ["name"]),
            upsert("stage_group", ["id", "phase_id", "name", "position"], groups, ["name"]),
            upsert("team_group", ["id", "group_id", "team_id"], memberships, [], "group_id,team_id"),
            upsert("zone", ["id", "group_id", "name", "color", "first", "last", "position", "positions_json"], zones, []),
            upsert("game", ["id", "phase_id", "round", "day", "kickoff", "home_id", "away_id", "played", "home_score", "away_score"], games,
                   ["phase_id", "round", "day", "kickoff", "home_id", "away_id", "played", "home_score", "away_score"]),
        ])
    statements.append("COMMIT;")
    return "\n\n".join(s for s in statements if s) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshots", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.write_text(prepare([json.loads(path.read_text()) for path in args.snapshots]))
