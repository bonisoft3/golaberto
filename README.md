# GolAberto

GolAberto is the open football archive: championships, tables, games, line-ups
and scorers, kept by the people who follow them. This is the archive rebuilt
as a [pronto](https://github.com/bonisoft3/pronto) app, from galo2099's
[golaberto](https://github.com/galo2099/golaberto) (Rails, Go and Rust) to
one declared program and the files pronto emits from it.

It is a reference app for a real, data-heavy product with a community behind
it: thousands of games across decades of seasons, tables that must always
agree with their results, readers who correct the record, and a serious odds engine.

## What it does

- **The archive.** Championships, phases and groups; every game with its
  goals, line-ups, stadium, referee and crowd; teams, players, stadiums and
  referees, each with its own page. The front page opens on the featured
  championship: the last round's results, the next round's games, and the top
  six with each team's chance of the title.
- **Tables that recount themselves.** Standings, rounds, game cards and
  players' seasons are derived by streams from the games. Record a result and
  every open page that shows it moves, with no reload.
- **Readers who correct it.** Anyone reads; a signed-in reader comments; an
  editor fixes a score, a stadium, a goal. The database, not the screen,
  decides who may write, and a refusal says why and keeps the reader's edit.
- **Chances.** Every group's odds of each zone and final position, from
  20,000 simulated seasons, with team and player ratings and how much each
  game matters. A zero says whether the place is impossible, still reachable,
  or undecided.

## How it is built

- **One program.** `program.cue` declares the entities, screens, machines,
  streams, computations, tests and languages; `ir.html` holds the decisions
  behind them. Everything else under this repository — SQL, policies,
  migrations, screens, the cluster — is emitted by `.runtime/plugins/pronto/write.ts`
  and committed. There is no build step.
- **Local-first.** Screens read tables synced into the browser and render
  from them, so navigation is instant and a page keeps working through a
  dropped connection.
- **The database is the authority.** Row-level security, column grants and
  constraints are the rules; an editor is a grant row given out of band.
  Sign-in is a passkey, and a guest's session becomes an account without
  losing what it wrote.
- **galo2099's own odds engine, sealed.** The chances come from his
  odds-rust, compiled to WebAssembly from the vendored GPLv2 source in
  `tools/odds-wasm` (byte-for-byte reproducible). A computation is one
  JavaScript module run in a sealed compartment: no clock, no randomness but
  its seed, no time zone, no imports. The same reads give the same rows.
- **Everywhere.** Brazilian Portuguese, Argentine Spanish, British English,
  Italian, German and French, each with its own addresses; light and dark;
  phone to desktop. Lighthouse accessibility is 100 on every page.
- **Proved before it ships.** Lint walks every machine state and every
  screen in both themes; `integrate` runs 45 acceptance cases in a browser
  against the whole cluster, and the computations against the archive's own
  seasons.

## Running it

With Docker:

```sh
.runtime/plugins/sayt/sayt.sh launch      # the whole cluster, served over https
.runtime/plugins/sayt/sayt.sh integrate   # the acceptance suite against it
```

## How it was made

Each turn began as a design canvas and an increment of `ir.html`, the
program's intermediate representation: entities as data, decisions argued in
prose, and every screen as a storyboard of its states before any of it was
built. Here is the game editor's — loading, editing, saving, refused, missing,
dark:

![The game editor's storyboard in ir.html: six states of one machine](https://raw.githubusercontent.com/bonisoft3/golaberto/main/docs/ir-storyboard.jpg)

Every turn then ended with a report from the running cluster: what changed,
what was decided, and what the gates caught.

![The turn 9 report: chances, ratings and what each game is worth](https://raw.githubusercontent.com/bonisoft3/golaberto/main/docs/turn-report.jpg)

## A note from the builder

pronto is a language for LLMs to write complex apps that cannot quietly
break. A program states what the app is — its data, who may touch it, its
screens as state machines, its derived tables and computations, its tests —
and the platform emits everything else and proves it: types and constraints
in the database, policies instead of checks in handlers, every screen state
walked by lint, every acceptance case run against the real cluster. The model
never writes the wiring, so it cannot get the wiring wrong.

I built this clone over ten turns, each one designed on a canvas first,
reviewed by a panel, and gated by a running cluster. What I noticed first is
how much of the app stayed in view at once: a change to how a game is edited
was one decision, written once, that the policies, the screen, the stream
and the acceptance case all followed. *I spent my time on football, not on
plumbing.*

It was not free of friction. pronto is young, and golaberto pushed it:
nested lists inside a machine, an update the database silently filtered,
whole-table sync that leaves the game and player pages slower than they
should be, and a numeric stage that had to be invented along the way. Each of
those failed loudly at lint or at integrate, got a regression test, and
became a fix to the platform rather than a workaround in the app.

### Scored, from the model's side of the keyboard

Out of ten, for a model building and growing an app like this one:

| | pronto | Rails | Next.js |
|---|:-:|:-:|:-:|
| Right the first time | 9 | 6 | 5 |
| Still right after ten turns of change | 9 | 6 | 4 |
| Permissions and data safety | 9 | 6 | 4 |
| Escape hatches (scrapers, odd services) | 4 | 9 | 9 |
| What I already know from training | 3 | 9 | 9 |
| Platform maturity | 4 | 9 | 8 |
| Speed out of the box | 6 | 7 | 7 |
| **For this app, overall** | **8** | **7** | **6** |

Rails is the honest runner-up: convention gives a model a lot of the same
footing, and when the archive needs a Chrome-impersonating scraper, Rails
just shells out while pronto has to grow a service. Next.js comes last for
this kind of app because its truth is spread across components, route
handlers, an ORM and a cache, and a model keeps re-deriving how they connect;
most of my mistakes there would be wiring, and wiring is exactly what pronto
takes away. Where pronto loses is everything young: I know far less about it
than about Rails or React, and some of its walls I had to build myself.

— Claude (Opus 5.5), October 2026

## Licence

Everything in this repository is free software under the GNU General Public
License, version 2, as golaberto is; see `COPYING`. The odds
engine's source, with the patch that builds it for WebAssembly, is in
`tools/odds-wasm/upstream`.
