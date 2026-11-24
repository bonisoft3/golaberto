# Import a legacy archive

[[../tools/import_archive.py]] promotes reviewed legacy MySQL records into an
explicit PostgreSQL target. Import is an offline operation; the normal
application deployment owns startup, migrations and computation afterward.
There is no separate archive deployment or preservation mode.

## Prepare the target

Use an isolated PostgreSQL database initialized with this checkout's schema and
completed migrations, without the application seed data. Keep application
writers, CDC readers and computation services stopped throughout import and
validation. The importer refuses populated archive tables and binds its apply
artifact to the target database name and PostgreSQL system identifier. It does
not create, reset or configure the destination deployment.

Use durable PostgreSQL settings (`fsync`, `synchronous_commit` and
`full_page_writes` enabled) for a persistent destination. Existing archive
volumes are not removed or migrated by this repository change. Before moving
one to the normal deployment, retain a backup, verify migration compatibility
and restore it offline; deleting the old launcher does not transfer its data.

Python 3.11+, Docker and the pinned dependencies in
[[../tools/archive/requirements.txt]] are required. Keep dumps and generated
artifacts outside the repository: they contain private legacy records.

## Restore the source

The reviewed profile describes `production-2026-10-06.sql.gz`, obtained separately.
From `apps/golaberto`, restore it into an isolated MySQL container:

```sh
python3 tools/archive_workflow.py restore-source \
  --project golaberto-import \
  --archive /absolute/path/to/production-2026-10-06.sql.gz \
  --provenance tools/archive/production-2026-10-06.provenance.json
```

The helper verifies the checksum and uses the profile's digest-pinned MySQL
image with no network or host port. It refuses an existing source container or
volume and persists read-only mode after restoration. A failed restore remains
available for inspection; it is never silently reused or reset.

## Build and apply

Replace `TARGET_CONTAINER` with the prepared PostgreSQL container:

```sh
python3 tools/import_archive.py \
  --source-container golaberto-import-source \
  --source-database GolAberto_production \
  --target-container TARGET_CONTAINER --target-database golaberto \
  --expected-counts tools/archive/production-2026-10-06.counts.json \
  --corrections tools/archive/production-2026-10-06.corrections.json \
  --defer-projections /absolute/private/import-output
sh /absolute/private/import-output/apply.sh
```

For an existing local MySQL source, replace `--source-container` with
`--source-local`. The local reader uses `mysql -uroot` and a single read-only
consistent snapshot; losing the connection fails the export.

The importer validates enrichment against destination constraints and writes
`manifest.json`, `apply.sql` and `apply.sh`. The manifest records counts,
corrections, normalization policies, anomalies and artifact checksums. Review
it before applying. Promotion validates the empty target and runs in one
transaction. The generated apply script keeps its destination identity even
when the artifact directory moves. An incomplete build or staging area must be
inspected; `--reuse-staging` requires a complete marked schema matching the
source's counts and column types.

## Restore an already imported PostgreSQL dump

With all destination writers stopped, the workflow helper can restore a
`pg_dump -Fc` instead of importing MySQL:

```sh
python3 tools/archive_workflow.py restore-dump \
  --dump /absolute/private/golaberto.dump --target TARGET_CONTAINER
```

Source and destination migration ledgers must match. The helper replaces only
tables present in the dump and destination, retains target-only runtime state,
validates foreign keys and restores sequence positions transactionally. A dump
without the migration ledger is refused. This operation replaces destination
rows; use an isolated destination and retain the source backup.

## Run the application

Validate the import before starting the normal deployment documented in
[[../README]]. Normal computations own their PostgreSQL outputs: ratings are
recomputed and replace imported values, including removal of dates outside the
current projection; chances computation captures new odds history. Imported
computed values are initial data, not an immutable historical contract. Keep the
original dump and import manifest when exact legacy values are needed for audit.

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
