# Import a legacy archive

This workflow restores a private MySQL dump and promotes its domain records into
a fresh GolAberto database, then launches the stack over it. It needs Python
3.11+, mise, Docker and Docker Compose 2.24+ with BuildKit. The supplied profile
describes `production-2026-10-06.sql.gz`; obtain that dump separately. No dump,
passwords, sessions or user exports belong in the repository.

```sh
cd apps/golaberto
mise install
ARCHIVE_PATH=/absolute/path/to/production-2026-10-06.sql.gz ./saytw --script tools/archive.nu up
```

A database already imported elsewhere travels as `pg_dump -Fc` of it instead,
taken from a stack whose migrations are this checkout's:

```sh
ARCHIVE_DUMP=/absolute/path/to/golaberto.dump ./saytw --script tools/archive.nu up
```

The target is migrated as below and must match the dump: their pgroll ledgers
name the same migrations, or the script refuses, since a data-only restore into
other columns would fill or drop them silently. A dump without a ledger, of a
database the migrate service never ran on, is refused for the same reason. Then,
in one transaction, the application's tables (every schema but pgroll's) are
emptied, since the migrations seed rows the dump holds too, and the dump's rows
restored with triggers off, so nothing is enqueued for the projections to
replay. There is no MySQL restore or
import; the full archive's 1 GB dump restored in about twenty minutes. Tables
the migrations do not make, such as the credentials the auth service creates at
runtime or a staging `legacy` schema, are left out and named. On a remote
machine the local certificate covers `localhost` only: reach it through
`ssh -L 8543:localhost:8543`.

[`tools/archive.nu`](../tools/archive.nu) runs the steps below and, when run
again, resumes at the first one not yet done: an imported database is launched
as it is, without its source, on images and migrations rebuilt from this
checkout; a restored source is reused; a finished import build is applied. A
failed build or staging is refused, with what to inspect, rather than reused or
removed. Its environment:

| Variable | Default | |
| --- | --- | --- |
| `ARCHIVE_PATH` | — | the legacy dump; required until the source is restored |
| `ARCHIVE_DUMP` | — | instead, a `pg_dump -Fc` of an imported database |
| `ARCHIVE_PROJECT` | `golaberto-archive` | the Compose project, and the image tag |
| `CADDY_TLS_HOST_PORT` | `8543` | the HTTPS port; the app is at `https://localhost:<port>` |
| `ARCHIVE_OUTPUT` | `<cache>/golaberto-archive/<project>` | the private import artifacts |

`./saytw --script tools/archive.nu stop` stops the trial without deleting its
volumes, and `./saytw --script tools/archive.nu -- compose …` runs any other Compose
command with the archive overlay, which every command against the trial needs;
the `--` keeps saytw from reading Compose's arguments as its own.

The archive and its artifacts need substantial disk space. The reviewed trial
has 319k games, 3.29m appearances, 8.2m ratings and 2.16m odds cells. On Docker
Desktop on Apple Silicon the restore took about three minutes and the import,
apply and launch about nine; the derived projections then take longer to catch
up.

## What it does

**Checks and images.** For a new project, the one with no target volume yet,
the archive tests run, the project check refuses any existing containers or
volumes, and an existing `ARCHIVE_OUTPUT` is refused: the workflow never deletes
or resets data. The images are built on every run; a cached build costs
seconds. An empty `MONOREPO_COMPOSE_MODE` selects pinned published platform
images rather than building the monorepo. The archive database image derives
from the generated one and removes only the baked `900_seed.sql` before
PostgreSQL initialization; all schema migrations, constraints, foreign keys and
readable-address triggers remain.

**Restore.** The dump's SHA-256 is verified against the provenance before any
resource is created. The source is a digest-pinned MySQL container,
`<project>-source`, with no network, a new named volume and no host port; restore
ends by persisting `super_read_only`, and a source without it, once it answers,
is a restore that stopped midway, which the script refuses rather than
reuses. Import reads use
read-only consistent snapshots.

**Empty target.** The target's volume is `<project>_archive-postgres`, and
Compose preserves it on restart. Its PostgreSQL port is reachable only inside
the Compose network; the overlay removes the host-port publication. The ordinary
migration runner records its `00_initdb` pgroll baseline and completes the later
migrations before promotion. Initdb SQL runs only on a fresh volume; rebuilding
an image never upgrades an existing database by itself. Nothing else starts
before the import: even an auth-created guest makes the destination nonempty.

**Import.** The importer validates enrichment against temporary copies of the
destination's actual constraints before loading millions of rows, and writes
`manifest.json` and `apply.sql` to `ARCHIVE_OUTPUT`. The manifest records raw and
projected counts, corrections with exact before guards, normalization and
retention policies, anomaly records and artifact checksums; it contains public
bylines and comments and must remain private. Promotion verifies the database
name, PostgreSQL system identifier and empty public archive tables, then runs as
one transaction; a second attempt against a populated destination fails before
mutation. The SQL embeds its CSV payloads and is bound to this target: never
point it at a replacement or shared destination. The importer marks the
`legacy` schema once every table is staged; a rerun passes `--reuse-staging` only
for a marked schema, which the importer re-verifies against the source's counts
and schema, and an unmarked one, a staging failure, is retained for inspection,
not erased. The script applies a build once its manifest is written: the
reviewed profile (checksum, counts, guarded corrections) is the review, and the
manifest stays in `ARCHIVE_OUTPUT` for audit.

**Launch.** Derived projections and queues must finish before judging page
completeness. The preservation overlay disables ratings replacement, whose
default sink removes historical rows absent from its recent window, and removes
the chances completion hook that captures computed odds snapshots. Chances run at
startup and on CDC changes to their declared inputs, using retained ratings.
This profile serves original ratings and odds; it does not maintain new rating
history automatically. An ordinary seeded launch instead recomputes
ratings/player rankings on their input changes and captures chances history.
Those default jobs must stay disabled for an archive preservation trial; player
rankings and rating evaluations are not refreshed here.

## Verify

The supplied profile should produce these counts before runtime adds guest users:

| Public table | Rows |
| --- | ---: |
| game | 318,970 |
| player_game | 3,290,664 |
| goal | 225,720 |
| team_rating | 8,195,365 |
| team_odds_history | 2,157,538 |
| team | 3,426 |
| team_player | 305,425 |
| zone | 16,379 |
| app_user | 1,192 |
| comment / team_comment | 420 / 51 |
| game_change | 660,958 |

The game edit history keeps 660,958 of the source's 692,410 versions: a version
that changes nothing is not a change. The profile's `game_versions` corrections
keep the later of 24 same-second double saves, show the 58 edits of one deleted
account without an author, and drop 12 versions naming a team or phase the
source no longer has.

Raw staging retains all 949,303 goals, the one explicitly excluded non-match,
20 duplicate roster memberships and 33 comments on unsupported subject types.
Ratings use the runtime's team/date UUIDv5 identity. Professional source category
1 maps to a NULL championship category, as required by the computation engine.
The 183 unresolved exit-before-entry appearances retain their original values;
their 53 negative season totals are data anomalies, not guessed playing minutes.

Another source dump needs its own reviewed checksum, counts and guarded
correction file; mismatches fail rather than applying this profile's repairs to
different records.
