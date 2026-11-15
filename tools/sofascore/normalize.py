"""Normalize SofaScore responses without performing I/O or reconciliation."""

import datetime as dt
import hashlib
import json
from zoneinfo import ZoneInfo


def _object(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _id(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).strip():
        return None
    text = str(value)
    if not text.isdigit() or not 0 < int(text) < 2**63:
        return None
    return str(int(text))


def _timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("timestamp must be numeric")
    return dt.datetime.fromtimestamp(value, dt.timezone.utc)


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _score(score, keys):
    for key in keys:
        if score.get(key) is not None:
            return _number(score[key], key)
    return None


def _scores(event):
    scores = [_object(event.get(key, {}), key) for key in ("homeScore", "awayScore")]
    normal = [_score(s, ("normaltime", "NORMAL_TIME", "FINAL_RESULT", "finalResult")) for s in scores]
    current = [_score(s, ("current", "display")) for s in scores]
    pens = [_score(s, ("penalties", "PENALTIES")) for s in scores]
    aet = []
    for s, n in zip(scores, normal):
        parts = [_score(s, (key,)) for key in ("extra1", "extra2")]
        total = _score(s, ("afterExtraTime", "extraTime", "EXTRA_TIME", "overtime", "OVER_TIME"))
        if any(v is not None for v in parts):
            aet.append(sum(v or 0 for v in parts))
        elif total is not None and n is not None and total >= n:
            aet.append(total - n)
        else:
            aet.append(None)
    if any(v is not None for v in aet) and not all(v is not None for v in aet):
        aet = [None, None]
    if any(v is not None for v in pens) and not all(v is not None for v in pens):
        pens = [None, None]
    if all(v is None for v in normal) and not any(v is not None for v in aet + pens):
        normal = current
    return normal, aet, pens


def normalize_events(payload):
    _object(payload, "payload")
    events = payload.get("events")
    if not isinstance(events, list):
        raise ValueError("events must be a list")
    result = []
    statuses = {"notstarted": "scheduled", "inprogress": "in_progress", "finished": "finished", "postponed": "postponed", "canceled": "cancelled", "cancelled": "cancelled", "abandoned": "abandoned", "awarded": "awarded", "interrupted": "in_progress", "suspended": "in_progress"}
    for raw in events:
        _object(raw, "event")
        home, away = (_object(raw.get(k), k) for k in ("homeTeam", "awayTeam"))
        ids = [_id(raw.get("id")), _id(home.get("id")), _id(away.get("id"))]
        if not all(ids) or ids[1] == ids[2] or not isinstance(home.get("name"), str) or not isinstance(away.get("name"), str):
            raise ValueError("event must have distinct identified teams and names")
        status_data = _object(raw.get("status"), "status")
        kind = status_data.get("type")
        if not isinstance(kind, str):
            raise ValueError("status type must be a string")
        description = str(status_data.get("description", "")).lower()
        status = statuses.get(kind.lower(), "unknown")
        if "award" in description or "walkover" in description:
            status = "awarded"
        elif "abandon" in description:
            status = "abandoned"
        when = _timestamp(raw.get("startTimestamp"))
        unknown_time = raw.get("startTimeConfirmed") is False or raw.get("timeConfirmed") is False or raw.get("startTimeTBD") is True or raw.get("timeTBD") is True
        normal, aet, pens = _scores(raw) if status == "finished" else ([None, None], [None, None], [None, None])
        played = status == "finished" and all(v is not None for v in normal)
        if not played:
            normal, aet, pens = [None, None], [None, None], [None, None]
        tournament = _object(raw.get("tournament", {}), "tournament")
        round_info = _object(raw.get("roundInfo", {}), "roundInfo")
        result.append({"external_id": ids[0], "home_external_id": ids[1], "away_external_id": ids[2], "home": home["name"], "away": away["name"], "stage_id": _id(tournament.get("id")), "season_id": _id(raw.get("season", {}).get("id")), "unique_tournament_id": _id(tournament.get("uniqueTournament", {}).get("id")), "stage_key": str(tournament.get("id")) + ("|" + json.dumps({k: round_info[k] for k in ("slug", "prefix") if round_info.get(k)}, sort_keys=True) if round_info.get("slug") or round_info.get("prefix") else ""), "round_key": round_info.get("round"), "day": (when.date() if unknown_time else when.astimezone(ZoneInfo("America/Sao_Paulo")).date()).isoformat(), "kickoff": None if unknown_time else when.isoformat().replace("+00:00", "Z"), "status": status, "played": played, "terminal": status in ("finished", "cancelled", "abandoned", "awarded"), "home_score": normal[0], "away_score": normal[1], "home_aet": aet[0], "away_aet": aet[1], "home_pen": pens[0], "away_pen": pens[1]})
    return result


def _minute(incident):
    value = incident.get("time")
    if value is None and incident.get("timeSeconds") is not None:
        value = _number(incident["timeSeconds"], "timeSeconds") // 60 + 1
    if value is None:
        return None
    return _number(value, "time")


def _side(incident):
    if isinstance(incident.get("isHome"), bool):
        return "home" if incident["isHome"] else "away"
    if incident.get("pos") in (0, 1) and not isinstance(incident.get("pos"), bool):
        return "home" if incident["pos"] == 0 else "away"
    return None


def normalize_details(lineups, incidents, event):
    _object(lineups, "lineups")
    _object(incidents, "incidents")
    _object(event, "event")
    missing, players, appearances, goals, substitutions = [], [], [], [], []
    by_id = {}
    used_substitutes = set()
    if not event.get("played") or event.get("status") != "finished":
        missing.append("event is not a played final")
    incident_list = incidents.get("incidents")
    if incident_list is None:
        missing.append("incidents missing")
        incident_list = []
    elif not isinstance(incident_list, list):
        raise ValueError("incidents must be a list")
    end = 120 if event.get("home_aet") is not None or event.get("away_aet") is not None else 90
    for inc in incident_list:
        _object(inc, "incident")
        if inc.get("incidentType") == "period":
            minute = _minute(inc)
            if minute is not None and 90 < minute < 999:
                end = 120
    for side in ("home", "away"):
        lineup = lineups.get(side)
        if lineup is None:
            missing.append(f"{side} lineup missing")
            continue
        _object(lineup, f"{side} lineup")
        entries = lineup.get("players")
        if entries is None or entries == []:
            missing.append(f"{side} lineup empty or missing")
            continue
        if not isinstance(entries, list):
            raise ValueError(f"{side} players must be a list")
        for entry in entries:
            _object(entry, "lineup entry")
            p = _object(entry.get("player"), "lineup player")
            pid = _id(p.get("id"))
            if not pid or not isinstance(p.get("name"), str) or not isinstance(entry.get("substitute"), bool):
                missing.append(f"{side} lineup player incomplete")
                continue
            if pid in by_id:
                missing.append(f"duplicate player {pid}")
                continue
            birth = p.get("dateOfBirthTimestamp")
            country = p.get("country")
            if country is not None:
                _object(country, "country")
            players.append({"external_id": pid, "name": p.get("shortName") or p["name"], "full_name": p["name"], "birth": _timestamp(birth).date().isoformat() if birth is not None else None, "country": country.get("name") if country else None, "height": p.get("height"), "position": p.get("position")})
            sub = entry["substitute"]
            statistics = entry.get("statistics")
            if statistics is not None:
                _object(statistics, "lineup statistics")
                minutes = statistics.get("minutesPlayed")
                if minutes is not None and _number(minutes, "minutesPlayed") > 0 and sub:
                    used_substitutes.add(pid)
            appearance = {"player_external_id": pid, "side": side, "on_minute": 0, "off_minute": None if sub else end, "bench": sub, "yellow": False, "red": False}
            appearances.append(appearance)
            by_id[pid] = appearance
    ordered_incidents = sorted(enumerate(incident_list), key=lambda item: ((_minute(item[1]) if _minute(item[1]) is not None else 999), item[1].get("addedTime") or 0, item[0]))
    for order, inc in ordered_incidents:
        typ, cls = inc.get("incidentType"), inc.get("incidentClass")
        if typ not in ("goal", "substitution", "card"):
            continue
        minute = _minute(inc)
        if minute is not None and minute >= 999:
            continue
        if typ == "goal" and cls in ("missed", "missedPenalty", "penaltyShootout"):
            continue
        side = _side(inc)
        added = inc.get("addedTime")
        if added is not None:
            _number(added, "addedTime")
        period = inc.get("period")
        base = {"external_id": _id(inc.get("id")), "side": side, "minute": minute, "added_time": added, "period": period, "source_order": order}
        if typ == "goal":
            pid = _id((inc.get("player") or {}).get("id"))
            own = cls == "ownGoal"
            expected_side = ("away" if side == "home" else "home") if own and side else side
            if cls not in ("regular", "penalty", "ownGoal") or minute is None or side is None or pid not in by_id or by_id[pid]["side"] != expected_side:
                missing.append(f"goal {order} incomplete")
            goals.append({**base, "player_external_id": pid, "penalty": cls == "penalty", "own_goal": own, "aet": minute is not None and minute > 90})
        elif typ == "substitution":
            incoming = _id((inc.get("playerIn") or {}).get("id"))
            outgoing = _id((inc.get("playerOut") or {}).get("id"))
            substitutions.append({**base, "player_off_external_id": outgoing, "player_on_external_id": incoming})
            if minute is None or side is None or incoming not in by_id or outgoing not in by_id or by_id[incoming]["side"] != side or by_id[outgoing]["side"] != side or not by_id[incoming]["bench"] or by_id[outgoing]["bench"]:
                missing.append(f"substitution {order} incomplete")
                continue
            by_id[incoming].update(on_minute=minute, off_minute=end, bench=False)
            by_id[outgoing]["off_minute"] = minute
        elif cls in ("yellow", "red", "yellowRed"):
            p = inc.get("player")
            if p is None:
                continue
            pid = _id(_object(p, "card player").get("id"))
            if pid not in by_id or side is None or by_id[pid]["side"] != side or minute is None:
                missing.append(f"card {order} incomplete")
                continue
            app = by_id[pid]
            if cls in ("yellow", "yellowRed"):
                app["yellow"] = True
            if cls in ("red", "yellowRed"):
                app["red"] = True
                if not app["bench"] and app["off_minute"] is not None:
                    app["off_minute"] = min(app["off_minute"], minute)
    for pid in sorted(used_substitutes):
        if by_id[pid]["bench"]:
            missing.append(f"substitute {pid} played but substitution is missing")
    if event.get("played"):
        for side in ("home", "away"):
            expected = event.get(f"{side}_score")
            extra = event.get(f"{side}_aet") or 0
            if expected is None or sum(g["side"] == side for g in goals) != expected + extra:
                missing.append(f"{side} goal count does not match final score")
    return {"players": players, "appearances": appearances, "goals": goals, "substitutions": substitutions, "complete": not missing, "missing": missing}


def semantic_hash(data):
    """Hash normalized values, ignoring diagnostic metadata and source ordering."""
    def canonical(value):
        if isinstance(value, dict):
            return {k: canonical(v) for k, v in value.items() if k not in ("source_order", "missing")}
        if isinstance(value, list):
            values = [canonical(v) for v in value]
            return sorted(values, key=lambda v: json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
        return value
    return hashlib.sha256(json.dumps(canonical(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
