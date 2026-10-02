# Crawls one championship of golaberto.com.br into tools/crawl/<slug>.json, one
# request a second: its phases in order, each phase's groups with their teams
# (upstream ids kept, for the team pages a later crawl reads) and the zones
# their tables are painted in, and every game of every phase — a played game's
# score, an unplayed one's chances.
#
#   python3 tools/crawl_championship.py tools/crawl <championship path>
#   e.g. /championship/show/1536-inglaterra-premier-league-2026-2027

import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (golaberto-clone seed; one request per second)"}


def get(path, attempts=3):
    time.sleep(1.0)
    req = urllib.request.Request("https://www.golaberto.com.br" + path, headers=UA)
    try:
        return urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    except TimeoutError:
        # The archive is one small server: a slow answer is worth asking again.
        if attempts == 1:
            raise
        return get(path, attempts - 1)


def clean(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def odds(cell):
    return [float(v.replace(",", ".")) for v in re.findall(r'title="([0-9,]+)"', cell)]


GAME = re.compile(
    r"<div class='game_toplay'>(?P<section>.*?)</div>"
    r"|<div class='game_round'>(?P<round>.*?)</div>"
    r"|<div class='game_date'>(?P<date>.*?)</div>"
    r"|<a id=\"game_id_(?P<id>\d+)\".*?game_time'>(?P<time>.*?)</div>"
    r".*?home_name'>(?P<home>.*?)</div>"
    r".*?home_score'>(?P<hs>.*?)</div>"
    r".*?game_x'>(?P<x>.*?)</div>"
    r".*?away_score'>(?P<as_>.*?)</div>"
    r".*?away_name'>(?P<away>.*?)</div>",
    re.S,
)
GROUP = re.compile(r"<h3><span>(?:<a href=\"[^\"]*/group/(\d+)\">)?([^<]+)(?:</a>)?</span></h3>(.*?)(?=<h3><span>|<div class=\"nav_side\"|$)", re.S)
TEAM = re.compile(r'href="/championship/show/[^"]+/team/(\d+)-[^"]+">([^<]+)</a>')
ZONE = re.compile(r">\s*([^<>\[\]]+?):\s*\[([0-9, ]+)\]")


def games(base, phase_id):
    out, seen, page = [], set(), 1
    while True:
        try:
            body = get(f"{base}/games/{phase_id}/p/{page}")
        except urllib.error.HTTPError as e:
            # The page after the last one is a 404.
            if e.code != 404:
                raise
            return out
        body = body[body.find("class=\"content\""):]
        played = rnd = date = None
        fresh = 0
        for m in GAME.finditer(body):
            if m.group("section"):
                played = clean(m.group("section")) == "Jogados"
            elif m.group("round"):
                digits = re.findall(r"\d+", clean(m.group("round")))
                rnd = int(digits[0]) if digits else None
            elif m.group("date"):
                date = clean(m.group("date")).split(" - ")[0]
            elif int(m.group("id")) not in seen:
                seen.add(int(m.group("id")))
                fresh += 1
                game = {"upstream": int(m.group("id")), "round": rnd, "date": date, "time": clean(m.group("time")),
                        "home": clean(m.group("home")), "away": clean(m.group("away")), "played": played}
                if played:
                    score = [clean(m.group("hs")), clean(m.group("as_"))]
                    if not all(s.isdigit() for s in score):
                        continue
                    game["score"] = [int(s) for s in score]
                else:
                    game["chances"] = odds(m.group("hs") + m.group("x") + m.group("as_"))
                out.append(game)
        if fresh == 0:
            return out
        page += 1


def phase(base, phase_id, position):
    body = re.sub(r"<script.*?</script>", "", get(f"{base}/phases/{phase_id}"), flags=re.S)
    groups = []
    # The phase's own name is the plain cell of its phase bar.
    bar = body[body.find("class='tab_header'"):]
    bar = bar[:bar.find("</table>")]
    plain = [clean(c) for c in re.findall(r"<td>\s*([^<]+?)\s*</td>", bar)]
    if not plain:
        raise SystemExit(f"phase {phase_id}: no name in its phase bar")
    name = plain[0]
    for upstream, gname, block in GROUP.findall(body):
        if not upstream:
            # A phase's only group carries no link; its recount button names it,
            # where the page has one. An old season's page has neither, and the
            # group's id is then unknown rather than guessed.
            found = re.search(r'id="recalculate(\d+)"', block)
            upstream = found.group(1) if found else None
        teams = [{"upstream": int(t), "name": clean(n)} for t, n in TEAM.findall(block)]
        zones = []
        for zname, positions in ZONE.findall(block):
            places = [int(p) for p in positions.split(",") if p.strip()]
            zones.append({"name": clean(zname), "first": min(places), "last": max(places)})
        groups.append({"upstream": int(upstream) if upstream else None, "name": clean(gname), "teams": teams, "zones": zones})
    return {"upstream": int(phase_id), "name": name, "position": position, "groups": groups, "games": games(base, phase_id)}


# A goal's mark, in whichever language the archive answered in.
PENALTY = {"(P)", "(pen)"}
OWN_GOAL = {"(C)", "(own)"}
MARKS = PENALTY | OWN_GOAL

GOAL_ROW = re.compile(r"<tr class='game_show_goals'>(.*?)</tr>", re.S)
CELL = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
LINEUP = re.compile(r'<table style="width: 100%">(.*?)</table>', re.S)
PLAYER_ROW = re.compile(r'<tr class="game_show_goals game_show_away_score">\s*<td>(.*?)</td>(.*?)</tr>', re.S)


# The facts a game page states, under their label in either language the
# archive answers in.
FACT = re.compile(r"<tr><td>(Público|Estádio|Árbitro|Attendance|Stadium|Referee):</td><td>(.*?)</td></tr>", re.S)
LABEL = {"Attendance": "Público", "Stadium": "Estádio", "Referee": "Árbitro"}


def details(game):
    """A played game's goals, its two line-ups, and its stadium, referee and
    attendance, as the game page lists them."""
    body = get(f"/game/show/{game['upstream']}")
    facts = {LABEL.get(k, k): clean(v) for k, v in FACT.findall(body)}
    referee = re.fullmatch(r"(.*?)(?: \((\w+)\))?", facts.get("Árbitro", ""))
    goals = []
    for row in GOAL_ROW.findall(body):
        cells = [clean(c) for c in CELL.findall(row)]
        if len(cells) < 9:
            continue
        home, away = cells[0:4], cells[5:9]
        for side, (name, minute, mark) in (("home", (home[0], home[2], home[1] + home[3])), ("away", (away[3], away[1], away[0] + away[2]))):
            if name:
                if mark and mark not in MARKS:
                    raise SystemExit(f"game {game['upstream']}: unknown goal mark {mark!r}")
                goals.append({"side": side, "player": name, "minute": int(minute.rstrip("'")) if minute.rstrip("'") else None,
                              "penalty": mark in PENALTY, "own_goal": mark in OWN_GOAL})
    lineups = []
    for table in LINEUP.findall(body)[:2]:
        players = []
        for name, rest in PLAYER_ROW.findall(table):
            cells = CELL.findall(rest)
            on, off = int(clean(cells[1])), int(clean(cells[2]))
            # Named among the substitutes and never brought on: still in the
            # line-up, and still bookable.
            players.append({"player": clean(name), "position": clean(cells[0]), "on": on, "off": off, "bench": on == off == 0,
                            "yellow": "#edc240" in cells[4], "red": "red" in cells[5] or "#ff0000" in cells[5].lower()})
        lineups.append(players)
    return {"upstream": game["upstream"], "goals": goals, "home": lineups[0] if lineups else [], "away": lineups[1] if len(lineups) > 1 else [],
            "stadium": facts.get("Estádio") or None, "referee": referee.group(1) or None, "referee_place": referee.group(2),
            # The archive writes an unknown attendance as -1.
            "attendance": int(facts["Público"].replace(".", "")) if facts.get("Público") and not facts["Público"].startswith("-") else None}


def championship(path):
    base = path.split("/phases/")[0]
    first = get(base)
    ids = sorted({int(pid) for pid in re.findall(r'href="/championship/show/[^"]+/(?:phases|games)/(\d+)-', first)})
    return {"path": base, "phases": [phase(base, pid, i) for i, pid in enumerate(ids)]}


if __name__ == "__main__":
    # With --details, each played game's page as well, into <slug>-games.json.
    out, path = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    slug = path.rstrip("/").split("/")[3]
    crawled = championship(path)
    json.dump(crawled, open(f"{out}/{slug}.json", "w"), ensure_ascii=False, indent=1)
    if "--details" in sys.argv:
        played = [g for p in crawled["phases"] for g in p["games"] if g["played"]]
        json.dump([details(g) for g in played], open(f"{out}/{slug}-games.json", "w"), ensure_ascii=False, indent=1)
