# Crawls a phase's chances into tools/crawl/odds-<phase>.json: for each team,
# the probability of finishing in each position as golaberto.com.br's own
# simulation states it, beside the games played when it was read, so the
# chances turn has a reference computed from the same table it seeds.
#
#   python3 tools/crawl_odds.py tools/crawl <phase path>

import json
import re
import sys

from crawl_championship import clean, get

ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
TEAM = re.compile(r'/team/\d+-[^"]+">([^<]+)</a>')
ODDS = re.compile(r'data-odds-array="\[([^\]]*)\]"')
CELLS = re.compile(r"<td>(\d+)</td>")

if __name__ == "__main__":
    out, path = sys.argv[1], sys.argv[2]
    body = get(path)
    teams = []
    for row in ROW.findall(body):
        team, odds = TEAM.search(row), ODDS.search(row)
        if team and odds:
            points, played = (int(c) for c in CELLS.findall(row)[:2])
            teams.append({"team": clean(team.group(1)), "points": points, "played": played,
                          "positions": [float(v) for v in odds.group(1).split(",")]})
    phase = path.rstrip("/").split("/")[-1]
    json.dump({"phase": path, "teams": teams}, open(f"{out}/odds-{phase}.json", "w"), ensure_ascii=False, indent=1)
    print(len(teams), sum(t["played"] for t in teams) // 2, "games played")
