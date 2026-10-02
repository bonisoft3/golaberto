# Crawls a championship's player table into tools/crawl/players-<slug>.json,
# one request a second: each player's upstream id, name, nationality, club,
# position and season line (minutes, goals, rating, appearances, cards). The
# page itself renders an empty table and fills it from players/list.json.
#
#   python3 tools/crawl_players.py tools/crawl <championship path>

import json
import re
import sys

from crawl_championship import clean, get

LINK = re.compile(r"/team/(\d+)-[^/]+/player/(\d+)-[^']+'>([^<]+)</a>")
FLAG = re.compile(r'title="([^"]+)"')
COLUMNS = ["position", "minutes", "goals", None, "rating", None, "offence", "defence", "own_goals", "penalties",
           "lineups", "played", "substitute", "bench", "yellow", "red"]


def number(v):
    return float(v.replace(",", ".")) if isinstance(v, str) else v


def players(path):
    out, start = [], 0
    while True:
        page = json.loads(get(f"{path}/players/list.json?draw=1&start={start}&length=100"))
        for row in page["data"]:
            team, player, name = LINK.search(row[0]).groups()
            flag = FLAG.search(row[0])
            line = {c: (v if c == "position" else number(v)) for c, v in zip(COLUMNS, row[2:]) if c}
            out.append({"upstream": int(player), "name": clean(name), "team": int(team),
                        "nationality": flag.group(1) if flag else None, **line})
        start += 100
        if start >= page["recordsTotal"]:
            return out


if __name__ == "__main__":
    out, path = sys.argv[1], sys.argv[2].rstrip("/")
    slug = path.split("/")[3]
    json.dump(players(path), open(f"{out}/players-{slug}.json", "w"), ensure_ascii=False, indent=1)
