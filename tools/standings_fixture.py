# Writes duckstream/standings-fixtures.json: compiled standings run over
# the crawled 2026 Série A (tools/crawl/), asserting the table golaberto.com.br
# shows for the same games.
#
#   python3 tools/standings_fixture.py

import json

games = json.load(open("tools/crawl/brasileiro2026.json"))
table = json.load(open("tools/crawl/brasileiro2026-table.json"))

teams = sorted({g["home"] for g in games})
team_id = {t: f"team-{i:02d}" for i, t in enumerate(teams)}
def iso(date):
    return "-".join(reversed(date.split("/")))


played = sorted((g for g in games if g["played"]), key=lambda g: iso(g["date"]))
fixture = {
    "group": {"id": "group", "phase_id": "phase"},
    "members": [{"group_id": "group", "team_id": team_id[t], "add_sub": 0, "bias": 0, "team": {"name": t}} for t in teams],
    "games": [
        {
            "phase_id": "phase",
            "home_id": team_id[g["home"]],
            "away_id": team_id[g["away"]],
            "home_score": g["score"][0],
            "away_score": g["score"][1],
            "home_aet": None,
            "away_aet": None,
            "home_pen": None,
            "away_pen": None,
            "day": iso(g["date"]),
            "kickoff": None,
        }
        for g in played
    ],
    "phases": [{
        "id": "phase",
        "sort": "pt,w,gd,gf,gp,g_away,name",
        "bonus_points": 0,
        "bonus_points_threshold": 0,
        "championship": {"point_win": 3, "point_draw": 1, "point_loss": 0},
    }],
    "zones": [
        {"group_id": "group", "color": c, "first": f, "last": l}
        for c, f, l in [("champion", 1, 1), ("qualify", 1, 4), ("playoff", 5, 5), ("promotion", 6, 11), ("relegation", 17, 20)]
    ],
}
expected = [
    [r["team"], r["points"], r["played"], r["wins"], r["draws"], r["losses"], r["goals_for"], r["goals_against"], r["goal_diff"]]
    for r in sorted(table, key=lambda r: r["pos"])
]


# Upstream's comparator cases the 2026 table never reaches.
def member(team, name, add_sub=0):
    return {"group_id": "g", "team_id": team, "add_sub": add_sub, "bias": 0, "team": {"name": name}}


def result(home, away, hs, as_, day):
    return {"phase_id": "p", "home_id": home, "away_id": away, "home_score": hs, "away_score": as_,
            "home_aet": None, "away_aet": None, "home_pen": None, "away_pen": None, "day": day, "kickoff": None}


def ladder(sort, members, results):
    return {"group": {"id": "g", "phase_id": "p"}, "members": members, "games": results, "zones": [],
            "phases": [{"id": "p", "sort": sort, "bonus_points": 0, "bonus_points_threshold": 0,
                        "championship": {"point_win": 3, "point_draw": 1, "point_loss": 0}}]}


ladders = [
    # A goal average capped or rounded to thousandths ties teams upstream's
    # float division separates.
    ("a team that conceded nothing ranks by goals scored",
     ladder("g_average,name", [member("t1", "One"), member("t2", "Two"), member("t3", "Three")],
            [result("t1", "x", 3, 0, "2026-01-01"), result("t2", "y", 5, 0, "2026-01-01")]),
     ["Two", "One", "Three"]),
    # A separator above the letters put "Abc" before "Ab" when the name was
    # not the ladder's last key.
    ("a name that prefixes another sorts first", ladder("name,pt", [member("t1", "Abc"), member("t2", "Ab")], []),
     ["Ab", "Abc"]),
    # Upstream's sub-table starts every team from its add_sub.
    ("head to head counts add_sub",
     ladder("pt,head,name", [member("a", "Zeta", -3), member("b", "Alpha"), member("c", "Mid")],
            [result("a", "b", 1, 0, "2026-01-01"), result("c", "y", 1, 0, "2026-01-02")]),
     ["Mid", "Alpha", "Zeta"]),
]

sparse = ladder("name", [member("t" + str(i), chr(64+i)) for i in range(1,5)], [])
sparse["zones"] = [{"group_id": "g", "color": "qualify", "first": 1, "last": 3, "positions": "1,3"}]
cases = [
    {"name": "2026 Serie A", "input": fixture,
     "fields": ["team_name", "points", "played", "wins", "draws", "losses", "goals_for", "goals_against", "goal_diff"], "expected": expected},
    {"name": "narrowest zone", "input": fixture, "fields": ["zone"],
     "expected": [[value] for value in ["champion", "qualify", "qualify", "qualify", "playoff", "promotion", "promotion", "promotion", "promotion", "promotion", "promotion", "", "", "", "", "", "relegation", "relegation", "relegation", "relegation"]]},
    {"name": "sparse zones", "input": sparse, "fields": ["zone"], "expected": [["qualify"], [""], ["qualify"], [""]]},
] + [{"name": name, "input": case, "fields": ["team_name"], "expected": [[value] for value in want]} for name, case, want in ladders]
with open("duckstream/standings-fixtures.json", "w") as f:
    json.dump(cases, f, ensure_ascii=False, indent=2)
    f.write("\n")
