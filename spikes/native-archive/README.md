# Native archive bootstrap spike

This is a one-source trial for the October 17 PostgreSQL 18 plain dump. It is
not a general archive converter. `import.py` checks the source SHA-256, an
explicit table allowlist, destination columns and the current generated pgroll
ledger before writing. It refuses credential-bearing table or column names.

Initialize a disposable database with the current Golaberto database image,
then run its normal migrate image to completion. With that database in a Docker
container and no other process writing to it, from the repository root run:

```sh
python3 apps/golaberto/spikes/native-archive/import.py \
  --source /absolute/path/to/golaberto.sql \
  --target-container <fresh-database-container>
```

The command **replaces data in the 55 listed tables**. It does not import the
source's pgroll, mecha, schedule, clock, dirty-queue or credential tables. It
retains fresh schema and runtime state, checks every current foreign key and
source row count before committing, and advances five projection revision
sequences to at least the archive values. The archive contains private app data;
keep the dump and any generated artifacts private. A failure before commit
rolls back the table changes and transactional sequence restarts. A failure
log, when needed, is a private temporary file.

On 9 November the fresh native ARM64 database initialized and applied all 59
current pgroll migrations. A prototype data-only import committed in 397.7 seconds under
a 1 GiB database limit, and all 55 source table counts and current foreign keys
matched. A second fresh database restored the exported custom archive through
`archive_workflow.py restore-dump` in 377.5 seconds under the same limit; all
55 table counts, five sequence next values and 135 foreign keys matched. The
fresh schedule, Graphile ledger and actor tables remained intact. It held 318,970 games, 3,426 teams, 90,867 players, 1,514
championships, 8,195,365 team ratings and 3,290,664 player-game rows. The last
played kickoff was 2026-10-05 18:45 UTC; the latest scheduled kickoff was
2027-05-30 19:00 UTC. PGDATA used 9.3 GiB. This checks database bootstrap, not
Feldera startup, application behavior, or equivalence to the later PGlite copy.

The source SHA-256 is
`39ce0d8aea4da54fe0e61ae56d255cfb9872e0f730ef82a36c567517956f726a`.
The native image was `bayt-golaberto-database:latest`, ARM64 image ID
`sha256:c62ea4c2942642aed0e4d92e3747626eed752bf6e9e7a72d21e579b6ff938d81`;
its 58 initdb SQL files matched the generated files byte for byte. The image is
a local build, not a portable tag. The earlier direct restore used
`bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b`.

A data-only custom-format dump for the existing archive workflow can be made
from the imported trial with:

```sh
python3 apps/golaberto/spikes/native-archive/export.py \
  --source-container <fresh-database-container> \
  --output /private/path/golaberto-data-only.dump
```

The exporter includes only the 55 reviewed tables, five revision sequences and
two pgroll ledger tables. It rejects credential-bearing table or column names,
checks the output's data entries and checks its ledger against the source.
The trial artifact is
`/Users/davi/code/golaberto-data/native-fresh-2026-11-09/golaberto-data-only.dump`
(760,814,056 bytes), SHA-256
`1135c6de36a70c2ba4dadef940757d0962ed700f93393be75906fc09da299d70`.
It contains private app data, even though it contains no credential tables.
