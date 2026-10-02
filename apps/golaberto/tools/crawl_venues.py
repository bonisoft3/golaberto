# Crawls the stadiums the crawled teams play at and the archive's referees into
# tools/crawl/stadiums.json and tools/crawl/referees.json, one request a second:
# a stadium's name and the games listed on its page, a referee's name, where
# they are from, and the games they whistled — each game with its championship,
# day, teams and score, for the stadiums-and-referees turn to seed from.
#
#   python3 tools/crawl_venues.py tools/crawl

import html
import json
import re
import sys

from crawl_championship import clean, get

GAME = re.compile(
    r"<div class='game_toplay'>.*?</div>"
    r"|<a href=\"/championship/show/[^\"]+\">(?P<champ>[^<]+)</a>"
    r"|<div style='font-size: 11px'>(?P<date>\d\d/\d\d/\d{4}[^<]*)</div>"
    r"|<a id=\"game_id_(?P<id>\d+)\".*?game_time'>(?P<time>.*?)</div>"
    r".*?home_name'>(?P<home>.*?)</div>"
    r".*?home_score'>(?P<hs>.*?)</div>"
    r".*?away_score'>(?P<as_>.*?)</div>"
    r".*?away_name'>(?P<away>.*?)</div>",
    re.S,
)
REFEREE = re.compile(r'href="/referee/show/(\d+)-[^"]+">([^<]+)</a>')


def games(body):
    out, champ, date = [], None, None
    for m in GAME.finditer(body[body.find('class="content"'):]):
        if m.group("champ"):
            champ = clean(m.group("champ"))
        elif m.group("date"):
            date = clean(m.group("date")).split(" - ")[0]
        elif m.group("id"):
            score = [clean(m.group("hs")).lstrip("*"), clean(m.group("as_")).lstrip("*")]
            out.append({"upstream": int(m.group("id")), "championship": champ, "date": date, "time": clean(m.group("time")),
                        "home": clean(m.group("home")), "away": clean(m.group("away")),
                        "score": [int(s) for s in score] if all(s.isdigit() for s in score) else None})
    return out


def stadium(upstream):
    body = get(f"/stadium/show/{upstream}")
    name = clean(re.search(r'class="content">\s*(?:<[^>]+>\s*)*([^<]+)<', body).group(1))
    return {"upstream": upstream, "name": name, "games": games(body)}


def referee(upstream, name):
    body = get(f"/referee/show/{upstream}")
    place = re.search(r"Localidade:\s*([^<]*)<", body)
    return {"upstream": upstream, "name": html.unescape(name).strip(), "place": clean(place.group(1)) if place else None,
            "games": games(body)}


if __name__ == "__main__":
    out = sys.argv[1]
    teams = json.load(open(f"{out}/teams.json"))
    ids = sorted({t["stadium"]["upstream"] for t in teams if t["stadium"]})
    json.dump([stadium(i) for i in ids], open(f"{out}/stadiums.json", "w"), ensure_ascii=False, indent=1)
    listed = dict(REFEREE.findall(get("/referee/list")))
    json.dump([referee(int(i), n) for i, n in sorted(listed.items(), key=lambda kv: int(kv[0]))],
              open(f"{out}/referees.json", "w"), ensure_ascii=False, indent=1)
