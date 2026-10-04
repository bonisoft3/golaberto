---
pronto: alpha
name: golaberto
business: open, collaborative encyclopedia of football statistics — free to read, kept by its community of editors; no revenue
stage: production — two decades of an existing archive's shape and look, read by fans and researchers who notice a wrong score
team: squad
cluster: mecha
terminal: omnishell
loop: sayt
build: bayt
---

# GolAberto

GolAberto is an open database of football: every championship, its phases and
groups, every game with its goals and line-ups, and the tables those games
make. It is the clone of [golaberto.com.br](https://www.golaberto.com.br), whose
source is [galo2099/golaberto](https://github.com/galo2099/golaberto){.context}:
the same archive, the same look, the same pages in Portuguese first.

Nothing a reader sees is typed twice. A table is what its games say; a
player's goals are the goals recorded in games; a referee's record is the games
he whistled.

## Data

A [[Category]] is the class a championship is played in — professional, under-20,
women's — and a championship that names none is professional.

A [[Championship]] is one season of one competition: its name, the region it
belongs to (world, continental or national) and that region's name ("Brasil",
"Europa", "América do Sul"), the day it begins and the day it ends, and how
many points a win, a draw and a loss are worth. A season that begins in one
year and ends in the next is "2026/2027".

A [[Phase]] is one stage of a championship, in order: a league stage, a group
stage, a knockout round. It says how its table is sorted — points, then wins,
then goal difference, then goals for, then name, by default — and may give
bonus points to a team that scores at least some number of goals in a game.

A [[Group]] is one table inside a phase ("Grupo Único", "Grupo A").

A [[Zone]] paints a stretch of a group's table — first to fourth are the
Libertadores places, seventeenth to twentieth are relegated — with its name and
the kind of colour it wears: champion, promotion, qualification, play-off or
relegation.

A [[TeamGroup]] places a team in a group, with any points added or taken by
the organiser, and the note that explains them.

A [[Team]] is a club or a national team: its short name ("Flamengo-RJ"), its
full name, its city and country, the day it was founded and the stadium it
plays at.

A [[Stadium]] has a name, a full name, a city and a country.

A [[Referee]] has a name and where they are from.

A [[Player]] has a name, a full name, a birth date, a country, a height and a
position: goalkeeper, right back, centre back, left back, defensive
midfielder, central midfielder, attacking midfielder or forward.

A player's season is a [[PlayerStat]] for each championship and team they
played for: the games they started and came on in, the minutes, the goals,
penalties and own goals, and the cards — recounted from the line-ups and goals
as they are recorded, never typed.

A [[TeamPlayer]] says a player was in a team's squad for a championship.

A [[Game]] is a match in a phase, on a round: when it is played (and whether
the hour is known), the home and away teams and which of them had the ground,
the stadium, the referee, the attendance, and — once it is played — the score,
with extra-time and penalty scores when there were any.

A [[Goal]] is scored in a game by a player for a team, at a minute; it may be
a penalty, an own goal, or in extra time.

A [[PlayerGame]] is a player's part in a game: for which team, the minute they
came on and went off, and whether they were booked or sent off.

A reader who arrives is an [[AppUser]] from the first page, with a handle the
site gives them; nobody signs in to read. Signing in is one gesture with a
passkey, which keeps the reader's handle and everything they wrote as a guest.

A [[Comment]] is what a signed-in reader says about a game: their words, when
they said them, and who they are. A reader writes one in a [[CommentDraft]] of
their own, which the page keeps while they type.

## Screens

- [[principal]]: the front page. The archive's championships in three short
  lists — world, continental, national — the most recent first, each leading to
  its page, beside a word about how the site is kept.
- [[campeonatos]]: the catalogue of every championship, with its level and
  category, narrowed by a name typed or a level picked.
- [[campeonato]]: one championship: its name and season, its level and
  category, the points a result is worth, and every phase in order with its
  groups, each a table — position, points, games, results, goals and the last
  five — painted by its zones, and the games of the current round and the
  next.

- [[jogos]]: the games, upcoming and played, across the archive.
- [[jogo]]: one game: the score, its facts, the goals by minute, both
  line-ups, and what readers said about it, newest first, with a place to say
  something.

- [[equipes]]: every team, with its city and country, narrowed by a name typed.
- [[equipe]]: one team: its full name, city, country, the day it was founded
  and its stadium, its latest rating, current and past championships, and
  current and past players. Each championship links to the team in that season.
  Rating history has period choices and exact values; all-competition games
  have category and home/away filters. Readers can search player history,
  follow a recorded location on a map, and discuss the team.
- [[equipe-campeonato]]: one team in one championship: its fixtures and results,
  the tables of its groups, its roster including players yet to appear, and
  detailed probabilities for each zone and final position. Readers can switch
  to another team in the same championship, filter matches by phase and
  home/away, and search or sort the roster. Category is fixed for the championship.
  Fixtures show home and away teams around the score, without repeating the
  championship name. Team links stay on one line, use ellipsis when necessary,
  and expose the full name on hover. Recorded player contributions
  and per-90 statistics have full-roster totals. Points and position charts
  compare teams and link to matches; recorded zone probabilities show their
  history. Missing observations remain missing, while recorded zeroes show zero.
- [[jogador]]: one player: name, position and country; their season in each
  championship and team; and the games they played, with their minutes, goals
  and cards.

- [[estadios]]: every stadium, with its city and country, narrowed by a name
  typed.
- [[estadio]]: one stadium: its name, full name, city and country; the teams
  that play there; and the games played there, newest first.
- [[arbitros]]: every referee, with where they are from, narrowed by a name
  typed.
- [[arbitro]]: one referee: their name, where they are from, and the games
  they refereed, newest first.

Team names in championship tables link to the team in that championship;
team names in the directory link to the main profile. Every player's name in a line-up links to
theirs, and a game's stadium and referee to theirs.

A phase's current round and the next are a [[PhaseRound]]; which list of
games a reader is looking at is a [[GamesView]] of their own.

A group's table is a [[Standing]] per team, recounted from the games as they
are recorded, for every reader at once.

## Behavior

- The archive keeps its existing compact headings, tables and visual tokens
  in light and dark appearances, following the reader's system. The team pages
  take their functionality from golaberto.com.br without copying its design.
- Every page reads well on a phone, a tablet, a laptop and a desktop, with no
  sideways scrolling.
- Every page is in Brazilian Portuguese, Argentine Spanish and British English,
  each at its own address, and switching language keeps the reader where they
  are. The countries with the strongest football traditions come first; more
  languages follow.
- What a reader typed in the catalogue's search is still there when they come
  back to it.

- A game's score is all or nothing: a played game has both scores, an unplayed
  one has neither.
- A team never plays itself, and a goal belongs to one of the two teams that
  played the game.
- Points for a result are the championship's own: three for a win by default,
  two in the old tables.

![[acceptance.md]]

## Out of scope

- Betting of any kind: the chances the site shows are statistics, not odds to
  wager on.
- Maps of where teams are from and how far they travel: they need a map
  service outside the platform.
- Importing games from other sites.

The homepage leads with the most important upcoming fixtures and recently played games across competitions, following the original GolAberto home selection. Each feed names a championship once above its compact match rows, making every game’s competition clear without repeated labels or introductory copy. It keeps the featured table and championship links below those feeds.
