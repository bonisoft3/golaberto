# Import a legacy archive

This workflow restores a private MySQL dump and promotes its domain records into
a fresh GolAberto database. Run it from `apps/golaberto` in this checkout with
Python 3.11+, Node, mise, Docker and Docker Compose 2.24+ with BuildKit. Install
the checkout's pinned tools with `mise install`. The supplied
profile describes `production-2026-10-06.sql.gz`; obtain that dump separately.
No dump, passwords, sessions or user exports belong in the repository.

The archive and resulting private artifacts require substantial disk space.
The reviewed trial has 319k games, 3.29m appearances, 8.2m ratings and 2.16m odds
cells; allow hours for restoration and import. The tested environment was Docker
Desktop on Apple Silicon. Choose an unused HTTPS port and a new project and image
tag. Generated images use the checkout's pinned platform dependencies.

```sh
export ARCHIVE_VENV=/absolute/path/to/private/archive-venv
python3 -m venv "$ARCHIVE_VENV"
. "$ARCHIVE_VENV/bin/activate"
python -m pip install -r tools/archive/requirements.txt
ARCHIVE_WORKFLOW_COMPOSE_TEST=1 \
  python -m unittest discover -s tools -p '*archive*test.py'

export ARCHIVE_PROJECT=golaberto-archive-local
export BAYT_IMAGE_TAG=archive-local
export MONOREPO_COMPOSE_MODE=
export CADDY_TLS_HOST_PORT=8543
export ORIGIN=https://localhost:8543
export ARCHIVE_PATH=/absolute/path/to/production-2026-10-06.sql.gz
export IMPORT_OUTPUT=/absolute/path/to/new-private-import-output

python tools/archive_workflow.py check-project --project "$ARCHIVE_PROJECT"
archive_compose() {
  docker compose -p "$ARCHIVE_PROJECT" \
    -f .bayt/compose.launch.closure.yaml \
    -f tools/archive/compose.preserve.yaml "$@"
}
```

The empty `MONOREPO_COMPOSE_MODE` selects pinned published platform images rather
than building the entire monorepo. The helper refuses any existing project
containers or volumes. It never deletes or resets data. Keep the source, private
artifacts and database volumes outside version control; `IMPORT_OUTPUT` must be
a directory that does not exist yet.

## Build and initialize the empty target

Build the generated database image first. The archive image derives from it and
removes only the baked `900_seed.sql` before PostgreSQL initialization. All schema
migrations, constraints, foreign keys and readable-address triggers remain.

```sh
docker compose -p "$ARCHIVE_PROJECT" \
  -f .bayt/compose.launch.closure.yaml build golaberto-database
if [ ! -f .certs/localhost.pem ]; then
  mkdir -p .certs
  mise exec -- mkcert -cert-file .certs/localhost.pem \
    -key-file .certs/localhost-key.pem localhost 127.0.0.1 ::1
fi
mise exec -- mkcert -install
archive_compose build --with-dependencies golaberto-launch

python tools/archive_workflow.py restore-source \
  --project "$ARCHIVE_PROJECT" --archive "$ARCHIVE_PATH" \
  --provenance tools/archive/production-2026-10-06.provenance.json

archive_compose up -d --no-build --wait golaberto-database
archive_compose run --rm --no-deps golaberto-migrate
export TARGET_CONTAINER=$(archive_compose ps -q golaberto-database)
export SOURCE_CONTAINER="$ARCHIVE_PROJECT-source"
```

The source uses a digest-pinned MySQL image, no network, a new named volume and
no host port. Restore verifies the dump's SHA-256 before creating resources,
then enables `super_read_only`. Import reads use read-only consistent snapshots.
The target uses `${ARCHIVE_PROJECT}_archive-postgres`; Compose preserves it on
restart. Its PostgreSQL port is accessible only inside the isolated Compose
network; the overlay removes the generated host-port publication. The ordinary
migration runner records its `00_initdb` pgroll baseline
and completes subsequent migrations before promotion. Initdb SQL runs only on a
fresh volume; rebuilding an image never upgrades an existing database by itself.

Do not start auth, streams or computations before importing: even an auth-created
guest makes the destination nonempty. Use the preservation overlay for every
subsequent Compose command, including restarts and image builds.

## Build, inspect and apply the import

```sh
ARCHIVE_IMPORT_TEST_TARGET_CONTAINER="$TARGET_CONTAINER" \
  ARCHIVE_WORKFLOW_COMPOSE_TEST=1 \
  python -m unittest discover -s tools -p '*archive*test.py'

python tools/import_archive.py \
  --source-container "$SOURCE_CONTAINER" \
  --source-database GolAberto_production \
  --target-container "$TARGET_CONTAINER" --target-database golaberto \
  --expected-counts tools/archive/production-2026-10-06.counts.json \
  --corrections tools/archive/production-2026-10-06.corrections.json \
  --defer-projections "$IMPORT_OUTPUT"
```

Review `manifest.json` and `apply.sql` in `IMPORT_OUTPUT`. The manifest records
raw and projected counts, corrections with exact before guards, normalization
and retention policies, anomaly records and artifact checksums. It contains
public bylines and comments and must remain private. The importer validates
enrichment against temporary copies of the actual destination constraints before
loading millions of rows. Promotion verifies the database name, PostgreSQL system
identifier and empty public archive tables, then runs as one transaction. A
second attempt against a populated destination fails before mutation.

```sh
sh "$IMPORT_OUTPUT/apply.sh"
docker exec -i "$TARGET_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U postgres -d golaberto -c 'ANALYZE;'
```

The apply script names the explicit target container and finds `apply.sql` beside
it, so the private artifact directory can move. The SQL embeds its CSV payloads
and still checks the original PostgreSQL system identifier. Never point it at a
replacement or shared destination. `--reuse-staging` is only for this same immutable source and
already verified private `legacy` schema; a staging failure is retained for
inspection, not automatically erased.

## Verify and launch

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

Raw staging retains all 949,303 goals, the one explicitly excluded non-match,
20 duplicate roster memberships and 33 comments on unsupported subject types.
Ratings use the runtime's team/date UUIDv5 identity. Professional source category
1 maps to a NULL championship category, as required by the computation engine.
The 183 unresolved exit-before-entry appearances retain their original values;
their 53 negative season totals are data anomalies, not guessed playing minutes.

```sh
archive_compose up -d --no-build --no-recreate golaberto-launch
archive_compose ps
archive_compose logs --tail=100 golaberto-transform golaberto-compute
```

Open `ORIGIN`; local HTTPS uses the app's normal certificate setup. Each new trial
origin has its own browser session. Derived projections and queues must finish
before judging page completeness. The preservation overlay disables ratings
replacement, whose default sink removes historical rows absent from its recent
window, and removes the chances completion hook that captures computed odds
snapshots. Chances run at startup and on CDC changes to their declared inputs, using
retained ratings. This profile serves original
ratings and odds; it does not maintain new rating history automatically. Ordinary
seeded launch instead recomputes ratings/player rankings on their input changes
and captures chances history. Those default jobs must remain disabled for an archive
preservation trial; player rankings and rating evaluations are not refreshed here.

Stop containers without deleting volumes when finished. Keep the same overlay
when resuming. Another source dump needs its own reviewed checksum, counts and
guarded correction file; mismatches fail rather than applying this profile's
repairs to different records.
