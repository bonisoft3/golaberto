# Writes the SQL fixture a fresh cluster starts from, as golaberto.com.br
# records it (championships, phases, clubs, stadiums, zones).
#
#   python3 tools/seed.py services/database/sql/900_seed.sql
import collections, datetime, json, re, sys
from seed_sql import write
out = sys.argv[1]
def uid(kind, n): return f"{kind:02x}000000-0000-4000-8000-{n:012d}"
# The archive's game pages and lists print the day and hour in UTC, whatever
# zone their header names; its player pages convert, and agree with the
# fixtures. A game's day is where it was played, Brasília's for this archive.
def when(day, hm):
    if not hm:
        return {"day": day}
    instant = datetime.datetime.fromisoformat(f"{day}T{hm}:00+00:00")
    local = instant.astimezone(datetime.timezone(datetime.timedelta(hours=-3)))
    return {"day": local.date().isoformat(), "kickoff": instant.strftime("%Y-%m-%dT%H:%M:%S.000000Z")}
# The side whose team scored a goal: an own goal counts for the other side.
def scorer_side(q): return q["side"] if not q["own_goal"] else ("away" if q["side"] == "home" else "home")
# A goal as a seed row; an old season's goal may carry no minute.
def goal_row(n, game_id, player_id, q):
    return dict(id=uid(14, n), game_id=game_id, player_id=player_id, side=q["side"],
                **({"minute": q["minute"]} if q["minute"] is not None else {}),
                **{k: True for k in ("penalty", "own_goal") if q[k]})
KIND = dict(category=1, championship=2, phase=3, group=4, zone=5, stadium=6, team=7, team_group=8, referee=11)

categories = ["Sub-20", "Feminino"]
stadiums = [("Maracanã","Estádio Jornalista Mário Filho","Rio de Janeiro","Brasil"),("Allianz Parque",None,"São Paulo","Brasil"),
            ("Mineirão","Estádio Governador Magalhães Pinto","Belo Horizonte","Brasil"),("Arena da Baixada","Estádio Joaquim Américo Guimarães","Curitiba","Brasil"),
            ("Morumbis","Estádio Cícero Pompeu de Toledo","São Paulo","Brasil"),("Arena Fonte Nova",None,"Salvador","Brasil"),
            ("Beira-Rio","Estádio José Pinheiro Borda","Porto Alegre","Brasil"),("Arena do Grêmio",None,"Porto Alegre","Brasil"),
            ("MetLife Stadium",None,"East Rutherford","Estados Unidos")]
S = {s[0]: uid(KIND["stadium"], i+1) for i, s in enumerate(stadiums)}
clubs = [("Flamengo-RJ","Clube de Regatas do Flamengo","Rio de Janeiro","1895-11-17","Maracanã"),
 ("Palmeiras-SP","Sociedade Esportiva Palmeiras","São Paulo","1914-08-26","Allianz Parque"),
 ("Athletico-PR","Club Athletico Paranaense","Curitiba","1924-03-26","Arena da Baixada"),
 ("Fluminense-RJ","Fluminense Football Club","Rio de Janeiro","1902-07-21","Maracanã"),
 ("Bahia-BA","Esporte Clube Bahia","Salvador","1931-01-01","Arena Fonte Nova"),
 ("Cruzeiro-MG","Cruzeiro Esporte Clube","Belo Horizonte","1921-01-02","Mineirão"),
 ("Atlético-MG","Clube Atlético Mineiro","Belo Horizonte","1908-03-25",None),
 ("Santos-SP","Santos Futebol Clube","Santos","1912-04-14",None),
 ("Coritiba-PR","Coritiba Foot Ball Club","Curitiba","1909-10-12",None),
 ("Bragantino-SP","Red Bull Bragantino","Bragança Paulista","1928-01-08",None),
 ("São Paulo-SP","São Paulo Futebol Clube","São Paulo","1930-01-25","Morumbis"),
 ("Botafogo-RJ","Botafogo de Futebol e Regatas","Rio de Janeiro","1904-08-12",None),
 ("Vitória-BA","Esporte Clube Vitória","Salvador","1899-05-13",None),
 ("Corinthians-SP","Sport Club Corinthians Paulista","São Paulo","1910-09-01",None),
 ("Mirassol-SP","Mirassol Futebol Clube","Mirassol","1925-11-09",None),
 ("Vasco-RJ","Club de Regatas Vasco da Gama","Rio de Janeiro","1898-08-21",None),
 ("Grêmio-RS","Grêmio Foot-Ball Porto Alegrense","Porto Alegre","1903-09-15","Arena do Grêmio"),
 ("Internacional-RS","Sport Club Internacional","Porto Alegre","1909-04-04","Beira-Rio"),
 ("Remo-PA","Clube do Remo","Belém","1905-02-05",None),
 ("Chapecoense-SC","Associação Chapecoense de Futebol","Chapecó","1973-05-10",None)]
nations = [("Espanha","España"),("Argentina","Argentina"),("Suíça","Schweiz"),("Colômbia","Colombia")]
teams = [dict(id=uid(KIND["team"], i+1), name=n, full_name=f, city=c, country="Brasil", foundation=d, **({"stadium_id": S[s]} if s else {})) for i,(n,f,c,d,s) in enumerate(clubs)]
teams += [dict(id=uid(KIND["team"], 101+i), name=n, full_name=f, country=n, team_type="national") for i,(n,f) in enumerate(nations)]
T = {t["name"]: t["id"] for t in teams}

# (name, region, region_name, begins, ends, point_win, category)
champs = [("Campeonato Brasileiro","national","Brasil","2026-01-28","2026-12-02",3,None),
 ("Campeonato Brasileiro - Série B","national","Brasil","2026-03-21","2026-11-28",3,None),
 ("Copa do Brasil","national","Brasil","2026-02-18","2026-11-15",3,None),
 ("Campeonato Brasileiro","national","Brasil","1971-08-07","1971-12-19",2,None),
 ("Campeonato Brasileiro Feminino","national","Brasil","2026-03-14","2026-09-20",3,"Feminino"),
 ("Copa Libertadores","continental","América do Sul","2026-02-04","2026-11-28",3,None),
 ("Copa Sudamericana","continental","América do Sul","2026-03-03","2026-11-21",3,None),
 ("Champions League","continental","Europa","2026-07-07","2027-05-29",3,None),
 ("Copa do Mundo FIFA","world","Mundial","2026-06-11","2026-07-19",3,None),
 ("Premier League","national","Inglaterra","2026-08-21","2027-05-23",3,None),
 ("La Liga","national","Espanha","2026-08-14","2027-05-23",3,None),
 ("Serie A","national","Itália","2026-08-22","2027-05-30",3,None),
 ("Bundesliga","national","Alemanha","2026-08-28","2027-05-22",3,None),
 ("Campeonato Brasileiro","national","Brasil","2006-04-15","2006-12-03",3,None)]
C = [uid(KIND["championship"], i+1) for i in range(len(champs))]
cat = {n: uid(KIND["category"], i+1) for i, n in enumerate(categories)}
championships = []
for cid,(n,r,rn,b,e,pw,c) in zip(C, champs):
    row = dict(id=cid, name=n, region=r, region_name=rn, begins=b, ends=e, point_win=pw)
    if c: row["category_id"] = cat[c]
    # The home page leads with the season golaberto's readers follow most.
    if cid == C[0]: row["featured"] = True
    championships.append(row)

# (championship index, phase name, position, groups: [(name, [teams])])
phases_src = [(0,"Turno e Returno",0,[("Grupo Único",[c[0] for c in clubs])]),
 (2,"Primeira Fase",0,[]),(2,"Oitavas de Final",1,[]),(3,"Primeira Fase",0,[]),
 (5,"Fase de Grupos",0,[]),(5,"Oitavas de Final",1,[]),(8,"Fase de Grupos",0,[]),(8,"Final",2,[("Final",["Espanha","Argentina"])]),
 (9,"Temporada",0,[]),(1,"Turno e Returno",0,[]),(8,"Oitavas de Final",1,[])]
phases, groups, tgs = [], [], []
for pi,(ci,pn,pos,gs) in enumerate(phases_src):
    pid = uid(KIND["phase"], pi+1)
    phases.append(dict(id=pid, championship_id=C[ci], name=pn, position=pos))
    for gname, members in gs:
        gid = uid(KIND["group"], len(groups)+1)
        groups.append(dict(id=gid, phase_id=pid, name=gname))
        for t in members: tgs.append(dict(id=uid(KIND["team_group"], len(tgs)+1), group_id=gid, team_id=T[t]))
zones = [dict(id=uid(KIND["zone"], i+1), group_id=groups[0]["id"], name=n, color=c, first=f, last=l) for i,(n,c,f,l) in enumerate(
 [("Campeão","champion",1,1),("Libertadores - Fase de Grupos","qualify",1,4),("Libertadores - Segunda Fase","playoff",5,5),("Copa Sudamericana","promotion",6,11),("Rebaixamento","relegation",17,20)])]

# The 2026 Série A's games, from the crawl: a played game's score, an unplayed
# one's day and hour.
crawled = json.load(open("tools/crawl/brasileiro2026.json"))
games = []
for i, c in enumerate(crawled):
    d, m, y = c["date"].split("/")
    row = dict(id=uid(9, i + 1), phase_id=phases[0]["id"], round=c["round"], **when(f"{y}-{m}-{d}", c["time"]),
               home_id=T[c["home"]], away_id=T[c["away"]], played=c["played"])
    if c["played"]:
        row["home_score"], row["away_score"] = c["score"]
    games.append(row)

# The 2026 Série A's line-ups and goals, from the crawl: a player is a name in
# a team's line-up, positioned by where they played most.
details = {d["upstream"]: d for d in json.load(open("tools/crawl/brasileiro2026-games.json"))}
game_of = {c["upstream"]: games[i] for i, c in enumerate(crawled)}
players, player_of, positions = [], {}, {}
squad, appearances, goals_rows = [], [], []
appeared = set()
for c in crawled:
    d = details.get(c["upstream"])
    if d is None:
        continue
    g = game_of[c["upstream"]]
    for side in ("home", "away"):
        team = g[f"{side}_id"]
        for p in d[side]:
            key = (team, p["player"])
            if key not in player_of:
                player_of[key] = uid(12, len(player_of) + 1)
                squad.append(dict(id=uid(15, len(squad) + 1), championship_id=C[0], team_id=team, player_id=player_of[key]))
            # Where a player played, not where the bench listed them.
            if not p["bench"]:
                positions.setdefault(key, []).append(p["position"])
            # A name listed twice in one line-up is one appearance.
            if (g["id"], player_of[key]) in appeared:
                continue
            appeared.add((g["id"], player_of[key]))
            row = dict(id=uid(13, len(appearances) + 1), game_id=g["id"], player_id=player_of[key], side=side, on_minute=p["on"])
            if p["bench"]:
                row["bench"] = True
            else:
                row["off_minute"] = p["off"]
            if p["yellow"]:
                row["yellow"] = True
            if p["red"]:
                row["red"] = True
            appearances.append(row)
    for q in d["goals"]:
        key = (g[f"{scorer_side(q)}_id"], q["player"])
        if key not in player_of:
            raise SystemExit(f"game {c['upstream']}: scorer {q['player']} is in neither line-up")
        goals_rows.append(goal_row(len(goals_rows) + 1, g["id"], player_of[key], q))
POSITIONS = {"g", "dr", "dc", "dl", "dm", "cm", "am", "fw"}
for (team, name), pid in player_of.items():
    seen = [p for p in positions.get((team, name), []) if p in POSITIONS]
    row = dict(id=pid, name=name)
    if seen:
        # Ties go to the position listed first, so a rerun writes the same seed.
        row["position"] = max(dict.fromkeys(seen), key=seen.count)
    players.append(row)

# Whole championships crawled from the archive (tools/crawl_championship.py):
# their phases, groups, zones and games replace the seed's empty shells.
def zone_role(name):
    n = name.lower()
    if "rebaix" in n or "relegat" in n or "descenso" in n:
        return "relegation"
    if n in ("campeão", "champions", "campeón") or n.startswith("campeão"):
        return "champion"
    if "play" in n or "segunda fase" in n or "repescagem" in n:
        return "playoff"
    if "europa" in n or "sudamericana" in n or "conference" in n or "acesso" in n or "promo" in n:
        return "promotion"
    return "qualify"


extra_games = []
# A running count per kind: the lists shrink when a shell is replaced, so a
# key minted from a list's length could repeat one already minted.
minted = {"phase": 100, "group": 100, "zone": 100}


def mint(kind):
    minted[kind] += 1
    return uid(KIND[kind], minted[kind])


def team_of(name, country):
    if name not in T:
        T[name] = uid(7, 200 + len(T) + 1)
        teams.append(dict(id=T[name], name=name, country=country))
    return T[name]


# Two knockout games of the 2026 World Cup as golaberto.com.br records them
# (games 365759 and 365902): a round of sixteen settled on penalties, and the
# final settled in extra time.
wc = {p["name"]: p["id"] for p in phases if p["championship_id"] == C[8]}
for phase, rnd, day, hm, home, away, score, aet, pen in [
        ("Oitavas de Final", 5, "2026-07-07", "20:00", "Suíça", "Colômbia", (0, 0), (0, 0), (4, 3)),
        ("Final", 29, "2026-07-19", "19:00", "Espanha", "Argentina", (0, 0), (1, 0), None)]:
    row = dict(id=uid(10, len(extra_games) + 1), phase_id=wc[phase], round=rnd, **when(day, hm), home_id=T[home], away_id=T[away], played=True,
               home_score=score[0], away_score=score[1], home_aet=aet[0], away_aet=aet[1])
    if pen:
        row["home_pen"], row["away_pen"] = pen
    extra_games.append(row)
final = extra_games[-1]

# A season's game pages, where crawled: its stadium, referee, attendance and
# goals, set on the game once the stadiums and players exist.
venue_facts = []
# (championship index, crawl, country, whether its game pages were crawled)
for index, path, country, paged in [(9, "tools/crawl/1536-inglaterra-premier-league-2026-2027.json", "Inglaterra", False),
                                    (1, "tools/crawl/1527-brasil-campeonato-brasileiro-serie-b-2026.json", "Brasil", False),
                                    (13, "tools/crawl/16-brasil-campeonato-brasileiro-2006.json", "Brasil", True)]:
    crawl = json.load(open(path))
    facts = {d["upstream"]: d for d in json.load(open(path.replace(".json", "-games.json")))} if paged else {}
    cid = C[index]
    phases[:] = [p for p in phases if p["championship_id"] != cid]
    for position, cp in enumerate(crawl["phases"]):
        pid = mint("phase")
        phases.append(dict(id=pid, championship_id=cid, name=cp["name"], position=position))
        for cg in cp["groups"]:
            gid = mint("group")
            groups.append(dict(id=gid, phase_id=pid, name=cg["name"]))
            for ct in cg["teams"]:
                tgs.append(dict(id=uid(8, len(tgs) + 1), group_id=gid, team_id=team_of(ct["name"], country)))
            for cz in cg["zones"]:
                zones.append(dict(id=mint("zone"), group_id=gid, name=cz["name"], color=zone_role(cz["name"]), first=cz["first"], last=cz["last"]))
        for cgame in cp["games"]:
            # A qualifying round's clubs belong to no group.
            team_of(cgame["home"], country)
            team_of(cgame["away"], country)
            d, m, y = cgame["date"].split("/")
            row = dict(id=uid(10, len(extra_games) + 1), phase_id=pid, **when(f"{y}-{m}-{d}", cgame["time"]), home_id=T[cgame["home"]], away_id=T[cgame["away"]], played=cgame["played"])
            if cgame["round"]:
                row["round"] = cgame["round"]
            if cgame["played"]:
                row["home_score"], row["away_score"] = cgame["score"]
            extra_games.append(row)
            if cgame["upstream"] in facts:
                venue_facts.append((row, C[index], country, facts[cgame["upstream"]]))

torres = uid(12, len(player_of) + 1)
player_of[(T["Espanha"], "F. Torres")] = torres
players.append(dict(id=torres, name="F. Torres", position="fw"))
squad.append(dict(id=uid(15, len(squad) + 1), championship_id=C[8], team_id=T["Espanha"], player_id=torres))
goals_rows.append(dict(id=uid(14, len(goals_rows) + 1), game_id=final["id"], player_id=torres, side="home", minute=106, aet=True))

# What the archive says of each team and player beyond the games
# (tools/crawl_teams.py, tools/crawl_players.py): a team's full name, city,
# foundation and stadium where the seed states none, and a player's country.
MONTHS = {m: i + 1 for i, m in enumerate(["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
                                          "Setembro", "Outubro", "Novembro", "Dezembro"])}
def founded(text):
    d, m, y = text.split(" de ")
    return f"{int(y):04d}-{MONTHS[m]:02d}-{int(d):02d}"
crawled_teams = {t["name"]: t for t in json.load(open("tools/crawl/teams.json"))}
def stadium_of(name, **where):
    if name not in S:
        S[name] = uid(KIND["stadium"], len(S) + 1)
        stadium_rows.append(dict(id=S[name], name=name, **where))
    return S[name]
stadium_rows = [dict(id=S[n], name=n, **({"full_name": f} if f else {}), city=c, country=co) for n, f, c, co in stadiums]
for team in teams:
    c = crawled_teams.get(team["name"])
    if c is None:
        continue
    if c["full_name"] and not team.get("full_name"):
        team["full_name"] = c["full_name"]
    if c["city"] and not team.get("city"):
        team["city"] = re.sub(r"-[A-Z]{2}$", "", c["city"])
    if c["founded"] and not team.get("foundation"):
        team["foundation"] = founded(c["founded"])
    if c["stadium"] and "stadium_id" not in team:
        team["stadium_id"] = stadium_of(c["stadium"]["name"], city=team.get("city") or team["country"], country=team["country"])
# The referees the archive lists, and the stadiums, referees, attendances and
# goals of the seasons whose game pages were crawled.
referees = []
R = {}
def referee_of(name, place):
    if name not in R:
        R[name] = uid(KIND["referee"], len(R) + 1)
        referees.append(dict(id=R[name], name=name, **({"location": place} if place else {})))
    return R[name]
for r in json.load(open("tools/crawl/referees.json")):
    referee_of(r["name"], r["place"])
# A ground the archive has renamed since: one stadium, under its name today.
RENAMED = {"Morumbi": "Morumbis", "Beira-Rio - José Pinheiro Borba": "Beira-Rio", "Parque Antártica": "Allianz Parque"}
for row, championship, country, d in venue_facts:
    d["stadium"] = RENAMED.get(d["stadium"], d["stadium"])
    if d["stadium"]:
        row["stadium_id"] = stadium_of(d["stadium"], country=country)
    if d["referee"]:
        row["referee_id"] = referee_of(d["referee"], d["referee_place"])
    if d["attendance"] is not None:
        row["attendance"] = d["attendance"]
    for q in d["goals"]:
        # A season with no line-ups knows its scorers by name only: one of
        # another season is not assumed to be the same man.
        key = (row[f"{scorer_side(q)}_id"], q["player"], championship)
        if key not in player_of:
            player_of[key] = uid(12, len(player_of) + 1)
            players.append(dict(id=player_of[key], name=q["player"]))
            squad.append(dict(id=uid(15, len(squad) + 1), championship_id=championship, team_id=key[0], player_id=player_of[key]))
        goals_rows.append(goal_row(len(goals_rows) + 1, row["id"], player_of[key], q))

team_name = {t["id"]: t["name"] for t in teams}
upstream_name = {t["upstream"]: t["name"] for t in crawled_teams.values()}
listed = collections.Counter()
nationality = {}
for q in json.load(open("tools/crawl/players-1523-brasil-campeonato-brasileiro-2026.json")):
    key = (upstream_name[q["team"]], q["name"])
    listed[key] += 1
    nationality[key] = q["nationality"]
player_row = {r["id"]: r for r in players}
# The 2026 table names its players' countries; a scorer of another season is
# keyed by that season too and is not in it.
for (team, name, *season), pid in player_of.items():
    key = (team_name[team], name)
    # Two players of one name in one squad cannot be told apart by name.
    if not season and listed[key] == 1 and nationality[key]:
        player_row[pid]["country"] = nationality[key]

body = {"Category": [dict(id=v, name=k) for k,v in cat.items()], "Stadium": stadium_rows,
        "Team": teams, "Referee": referees, "Championship": championships, "Phase": phases, "Group": groups, "Zone": zones, "TeamGroup": tgs, "Game": games + extra_games, "Player": players, "TeamPlayer": squad, "PlayerGame": appearances, "Goal": goals_rows}
write(body, out)
