# Historical rating source experiment

Status: exploratory; no source filtering is enabled. Golaberto now selects the
DuckDB snapshot runtime, so streaming source compaction is deferred.

Run each script against an archive copy with `psql -X -v ON_ERROR_STOP=1 -f FILE`.
The scripts use repeatable-read or isolated temporary tables and roll back.
`measure.sql` compares the current chances ASOF lookups against a reduced source;
`contract.sql` demonstrates why that reduction must be maintained as requests and
history change. `change-points.sql` counts consecutive equal rating values.

The measured archive contains 8,195,365 ratings. Its current 39,120 distinct
team/time lookups select 19,287 distinct ratings; the reduced snapshot has zero
lookup mismatches. Latest-only ratings change values for 25,350 lookups and are
not equivalent. Insertions, corrections, deletions and backdated requests require
backfill from full history: snapshot equivalence is not continuous maintenance.
