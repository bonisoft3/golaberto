# Crawls golaberto.com.br's 2026 Série A into tools/crawl/, one request a
# second: every game of the season (a played game's score, an unplayed one's
# chances) and the table the site shows, so a seed never needs the network and
# the derived standings have a reference to be graded against.
#
#   python3 tools/crawl.py tools/crawl [--table-only] [--details]

import json
import os
import re
import sys

from crawl_championship import GAME, clean, details, get, odds

BASE = "/championship/show/1523-brasil-campeonato-brasileiro-2026"


def games():
    out = []
    for rnd in range(1, 39):
        body = get(f"{BASE}/games/4476/round/{rnd}")
        body = body[body.find("</select>"):]
        played = date = None
        for m in GAME.finditer(body):
            if m.group("section"):
                played = clean(m.group("section")) == "Jogados"
            elif m.group("round"):
                continue
            elif m.group("date"):
                date = clean(m.group("date")).split(" - ")[0]
            else:
                game = {"round": rnd, "upstream": int(m.group("id")), "date": date,
                        "time": clean(m.group("time")), "home": clean(m.group("home")),
                        "away": clean(m.group("away")), "played": played}
                if played:
                    game["score"] = [int(clean(m.group("hs"))), int(clean(m.group("as_")))]
                else:
                    game["chances"] = odds(m.group("hs") + m.group("x") + m.group("as_"))
                out.append(game)
    return out


def table():
    body = get(f"{BASE}/phases/4476-turno-e-returno")
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body, re.S):
        cells = [clean(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(cells) >= 10 and cells[0].isdigit():
            # The name cell leads with the last five results as glyphs.
            team = re.sub(r"^\W+", "", cells[1])
            rows.append({"pos": int(cells[0]), "team": team, "points": int(cells[2]), "played": int(cells[3]),
                         "wins": int(cells[4]), "draws": int(cells[5]), "losses": int(cells[6]),
                         "goals_for": int(cells[7]), "goals_against": int(cells[8]), "goal_diff": int(cells[9])})
    return rows


os.makedirs(sys.argv[1], exist_ok=True)
os.chdir(sys.argv[1])
if "--table-only" not in sys.argv:
    json.dump(games(), open("brasileiro2026.json", "w"), ensure_ascii=False, indent=1)
json.dump(table(), open("brasileiro2026-table.json", "w"), ensure_ascii=False, indent=1)
if "--details" in sys.argv:
    season = json.load(open("brasileiro2026.json"))
    json.dump([details(g) for g in season if g["played"]], open("brasileiro2026-games.json", "w"), ensure_ascii=False, indent=1)
