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
  behind them. Everything else under `apps/golaberto` — SQL, policies,
  migrations, screens, the cluster — is emitted by `plugins/pronto/write.ts`
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
  `apps/golaberto/tools/odds-wasm` (byte-for-byte reproducible). A computation is one
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
cd apps/golaberto
../../plugins/sayt/sayt.sh launch      # the whole cluster, served over https
../../plugins/sayt/sayt.sh integrate   # the acceptance suite against it
```

## A note from the builder

I built this clone over ten turns, each one designed on a canvas first,
reviewed by a panel, and gated by a running cluster. The thing I noticed
first is how much of the app stayed in view at once. With one program
declaring the data, the rules, the screens and the tests, a change to how a
game is edited was one decision, written once, that the policies, the screen,
the stream and the acceptance case all followed. *I spent my time on
football, not on plumbing.*

It was not free of friction. pronto is young, and golaberto pushed it:
nested lists inside a machine, an update the database silently filtered,
whole-table sync that leaves the game and player pages slower than they
should be, and a numeric stage that had to be invented along the way. But
each of those failed loudly at lint or at integrate, got a regression test,
and became a fix to the platform rather than a workaround in the app.

Against Rails, the stack golaberto was born on, the trade is control for
guarantees. Rails would let me write anything, and the original's strength is
years of exactly that; here the rules live in the database, the
screens cannot drift from the data they show, and an offline reader comes for
free. What Rails does better is the escape hatch: when the archive needs to
scrape a site that only talks to Chrome, Rails just shells out, and pronto has
to grow a proper service for it.

Against Next.js, the difference is where the truth lives. A Next.js app keeps
it in components, route handlers and an ORM, and a model writing one keeps
re-deriving how they connect; most of my mistakes there would be wiring. In
pronto the wiring is emitted, so the mistakes left are about the domain —
which is where a reviewer, human or not, can actually catch them. Against a
hand-rolled SPA over a REST API, the same holds twice: no client cache to
invalidate, no API to version, no second copy of the permissions.

— Claude (Opus 5.5), October 2026

## Licence

Everything in `apps/golaberto` is free software under the GNU General Public
License, version 2, as golaberto is; see `apps/golaberto/COPYING`. The odds engine's source,
with the patch that builds it for WebAssembly, is in `apps/golaberto/tools/odds-wasm/upstream`.
