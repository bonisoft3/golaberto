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
  referees, each with its own page. The front page opens on
  upcoming and recently played games across competitions, followed by the
  featured championship's top six and title chances.
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
- **Bounded live reads.** Screens request their filtered rows instead of
  downloading the archive. Supported queries use local synchronized subsets;
  domain comparisons and ordered pages use bounded server reads and live
  invalidation. Those server reads require a connection.
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
  screen in both themes; `integrate` runs 51 acceptance cases in a browser
  against the whole cluster, and the computations against the archive's own
  seasons.

## Running it

The homepage leads with up to 20 upcoming fixtures and 20 recent results across
competitions. It follows the original site's team-strength, match-importance
and proximity ranking. Upcoming fixtures span three hours ago to fourteen days
ahead; played results use fourteen days on either side of the clock shifted back
three hours, as in the reference. Both feeds refresh every 30 seconds and retain
global rank order under shared date headings and phase headings. Each feed
highlights the union of its five displayed games with greatest raw quality
and the greatest weighted-quality game per phase and date among eligible
candidates. Important team names use the primary color and semibold weight,
while scores and separators use the theme accent and bold weight. Ordinary
names and scores use the quieter secondary color and normal weight. Highlight
flags belong only to the bounded home projection and refresh atomically.
Dates and
kickoff times use Brasília time. The featured championship's
table and the championship catalogue follow the game feeds.

Launch automatically upgrades existing databases through the pgroll migration
ledger before starting readers and pipelines, while preserving their data.

The compute worker is disabled in the default development launch (zero
replicas). Its JavaScript and WASM implementation remains available for future
offline batching. Pages use stored ratings, odds and game importance; local
edits do not recalculate those values while compute is disabled. The event
pipelines that update fixtures, results and standings continue to run.

With Docker:

```sh
cd apps/golaberto
../../plugins/sayt/sayt.sh launch      # the whole cluster, served over https
COMPOSE_PROJECT_NAME=golaberto-checks CADDY_TLS_HOST_PORT=8444 \
  ../../plugins/sayt/sayt.sh integrate # the acceptance suite in a disposable stack
```

The Docker daemon must be running. On macOS with Colima, run `colima start`
first and use the `colima` Docker context (`docker context use colima`).
Before opening the app in a browser, trust its local development certificate
once from this directory:

```sh
../../plugins/sayt/sayt.sh --script tools.nu mise exec -- mkcert -install
```

Enter your macOS administrator password when prompted, then restart the browser and open
`https://localhost:8443`. Bypassing a certificate warning does not allow the
service worker to register.

Launch preserves existing database volumes. Use `docker compose down` to
stop the app; add `-v` only when you intend to erase its local database.

The real development and acceptance-test dataset lives in
`services/database/sql/900_seed.sql`, outside CUE compilation. Pronto copies
it into the fresh-database migrations; batched inserts preserve the same
records, defaults and database constraints. Existing databases are not reseeded.
Regenerate it after changing the local crawl snapshots with
`python3 tools/seed.py services/database/sql/900_seed.sql`. The `test` gate
checks that the committed fixture can be reproduced.

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

## Refreshing the imported archive

The local Rails database and the public site can contain different fixtures
and results. `tools/crawl_championship.py` reads a whole public competition,
including all divisions. After importing the legacy archive, prepare a
targeted refresh with:

```sh
python3 tools/crawl_championship.py /tmp/golaberto-refresh /championship/show/1544-europa-uefa-nations-league-2026-2027
python3 tools/refresh_archive.py /tmp/golaberto-refresh/1544-*.json --output /tmp/golaberto-refresh/refresh.sql
```

Back up the database and review the SQL before applying it with `psql -v
ON_ERROR_STOP=1`. It uses the import's deterministic upstream IDs, inserts
missing phases, groups and games, and updates schedules and results. It keeps
championship metadata, memberships, existing zones and game details absent
from the crawl. Missing team references abort the transaction. Replaying an
unchanged snapshot produces no game updates. Normal CDC pipelines own cards,
standings, ratings, importance and homepage ranks; the refresh does not write
those projections. This command requires the imported archive and deliberately
rejects the small development seed's different IDs.

## Licence

Everything in `apps/golaberto` is free software under the GNU General Public
License, version 2, as golaberto is; see `apps/golaberto/COPYING`. The odds engine's source,
with the patch that builds it for WebAssembly, is in `apps/golaberto/tools/odds-wasm/upstream`.

Archive routes fetch only the filtered rows they show. Championships, teams,
stadiums, referees and long histories use forty-row pages; changing a search
returns to page one. Previous and Next keep the full archive available. The
route-loads integration check visits all fourteen route patterns in fresh
browser contexts and verifies bounded requests and pagination. Route-query
checks cover the supporting ordered SQL indexes.
