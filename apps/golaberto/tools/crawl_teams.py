# Crawls the team pages of every team the championship crawls name into
# tools/crawl/teams.json, one request a second: full name, city, country,
# foundation, home stadium and the city's coordinates. The Série A clubs are
# named without ids in brasileiro2026*.json, so they are found through the
# championship's own team links.
#
#   python3 tools/crawl_teams.py tools/crawl

import glob
import json
import re
import sys

from crawl_championship import TEAM, clean, get

SERIE_A = "/championship/show/1523-brasil-campeonato-brasileiro-2026"
FIELD = re.compile(r"(Cidade|País|Fundação):\s*([^<]*)<br")
STADIUM = re.compile(r'Estádio:\s*<a href="/stadium/show/(\d+)-[^"]*">([^<]+)</a>')
CITY = re.compile(r'const cities = \[\["[^"]*","[^"]*","[^"]*",(-?[0-9.]+),(-?[0-9.]+)')


def ids(out):
    found = {}
    for path in glob.glob(f"{out}/1*.json"):
        for phase in json.load(open(path))["phases"]:
            for group in phase["groups"]:
                for team in group["teams"]:
                    found[team["upstream"]] = team["name"]
    for upstream, name in TEAM.findall(get(SERIE_A)):
        found[int(upstream)] = clean(name)
    return found


def team(upstream, name):
    body = get(f"/team/show/{upstream}")
    body = body[body.find('class="content"'):]
    fields = {k: clean(v) for k, v in FIELD.findall(body)}
    stadium = STADIUM.search(body)
    city = CITY.search(body)
    return {
        "upstream": upstream,
        "name": name,
        "full_name": clean(re.search(r"<h3>([^<]+)</h3>", body).group(1)),
        "city": fields.get("Cidade") or None,
        "country": fields.get("País") or None,
        "founded": fields.get("Fundação", "").split(" (")[0] or None,
        "stadium": {"upstream": int(stadium.group(1)), "name": clean(stadium.group(2))} if stadium else None,
        "lat": float(city.group(1)) if city else None,
        "lng": float(city.group(2)) if city else None,
    }


if __name__ == "__main__":
    out = sys.argv[1]
    teams = [team(u, n) for u, n in sorted(ids(out).items())]
    json.dump(teams, open(f"{out}/teams.json", "w"), ensure_ascii=False, indent=1)
