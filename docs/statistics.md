# Statistics

Ratings and chances are declared as Duckstream sources and sinks in
`program.cue`. Native servers use RisingWave; Cloudflare and Pages use DuckDB snapshots. Both
execute queries authored in `duckstream/team_ratings.sql`,
`duckstream/player_ratings.sql`, and
`duckstream/chances.sql`. The Duckstream compiler lowers authored SQL directly
to the committed DuckDB queries and schema manifests.

## SQL-only projections

Game cards, team game lines and player counters use `duckstream/cards.sql` and
`duckstream/player_stats.sql`. They run through the same compiler and snapshot
capture as ratings, with no numerical WASM step. DuckDB performs their joins
and aggregation outside the serving PostgreSQL process; bounded steps page the
completed relations into staged publication. Native deployments use the same
RisingWave relations. Their retired Conduit pipelines and portable recount drains
are not registered, so each projection has one computation owner.

GameCard and TeamGame publish in one transaction. PlayerStat publishes only its
declared names and counters; existing ratings, search and per-90 projections
retain their columns. Replacement removes absent keys while preserving
independently owned columns on surviving rows. The retained PostgreSQL recount
functions are regression oracles, not startup drains. Golden tests compare both
logical and physical DuckDB plans with those functions, including all 885
upstream player counter records. The [[evidence/sql-projections.json|archive projection check]]
compares every output row against the PostgreSQL SELECT oracle and runs physical
SQL at a 32 MB native DuckDB budget. Grouped aggregates partition complete key
groups into sixteen hash buckets; this adds scans and durable stages while
bounding each accumulator table. Global aggregates remain unsplit. This native
check does not establish hosted process or publication capacity.

## Computation boundary

RisingWave maintains joins and aggregates. Source carriers preserve row-local
UTC conversion, phase-specific calendar-year boundaries, epoch rounding and f32 rounding.
The historical ratings input starts seven calendar years before the UTC month
containing the latest played match: October 2026 starts at October 1, 2019;
November advances that start to November 1, 2019. Current-month matches enter
immediately, so the input spans seven years plus the elapsed current month.
This application policy is expressed in Duckstream SQL with `FLOOR(MAX(utc) TO MONTH)`.
Team ratings replace the computation's current output, including retracting dates
that disappear when a result is undone or the window moves. Keeping omitted rows
with upsert leaves obsolete ratings eligible for the chances query's ASOF join.
Imported ratings outside this computed projection are removed by normal publication.
The fitter's internal four-year window and latest-match-relative player windows
are unchanged. Upstream's unlinked `/eval` phase RPS debug endpoint is not materialized.
Chances use an ASOF join: a rating at midnight becomes eligible one microsecond
later, preserving the original strictly-before rule even for a midnight match.
Duplicate ratings for the same team/day fail capture. Native mode maintains
a validation relation incrementally; snapshot mode checks the captured ratings.
The pinned engine cannot compile ASOF equality keys containing strings or UUID
objects, so the carrier represents each UUID as four exact 32-bit integers.
All four participate in equality; no identity bits are discarded.
Queries and deterministic row ordering are checked against the previous
DuckDB implementation with the monthly history boundary applied explicitly
in the test oracle. Earlier full-archive parity evidence predates this policy;
it does not establish identical numerical results for the monthly window.
The separate [[evidence/monthly-history.json|monthly archive run]] records the
new baseline and verifies that the October new-match fixture changes only the
last fit and the new observation, leaving earlier dates unchanged.

Pure JavaScript constructs requests and shapes results. The existing WASM
module fits ratings and simulates odds. It is unchanged. Cortex coordinates
Durex durable work; each complete output, latest-version guard, completion
hook and receipt commits in one PostgreSQL transaction. Electric updates the
open browser after publication. Internal publication does not use Airlock.

The compute service keeps a bounded private Zstd-compressed `bytea` cache of
successful pure WASM answers, dispatched across a bounded WASI worker pool.
Identity includes exact request bytes (including the seed), optional output
field selection, module bytes, command name and WASI execution host. A restart
can reuse retained answers; a changed request or module cannot. Eviction only
causes recomputation. The cache is not the durable publication receipt and does
not decide freshness.

## Delivery and latency

Native ingestion uses RisingWave PostgreSQL CDC over row-local current-state
carriers. Source transactions maintain these carriers through indexed triggers;
they are not work queues. RisingWave maintains the difference from the last durable
capture. Cortex coalesces pending changes for one second and retains affected
partition inputs before acknowledgment. Odds finish per phase; ratings remain
a global numerical fit. Other phase partitions are not loaded or republished.

The seeded live-browser trial observed a 73.06% to 59.55% title-probability update
in 20.5 seconds without reload, and restored the original value after undo.
Ratings changes can legitimately affect additional phases. This is local
correctness evidence, not a latency or capacity guarantee.

The SQL closes calculation inputs
over their required identities: archived games join both teams, goals join their
player, and ranked odds groups require every member’s team to be present. Missing
dependencies withhold those rows until CDC catches up, instead of capturing a
permanently invalid numerical request.
Publication and its receipt
are one PostgreSQL transaction. Indexed sink guards repair owned rows removed
by cascades, while immutable captures and serial execution prevent stale retries
from overwriting newer completed work. See [[../../../libraries/mecha/docs/compute|the runtime contract]].

Conduit and Redis remain for the round pipeline. Ratings, chances, standings,
game cards and player counters are owned by Duckstream. Pages and explicit
snapshot deployments retain their existing snapshot path.

Standings uses Duckstream SQL for joins and aggregates, followed by bounded per-group
ranking, recent form and zone selection. The archive oracle matches all 58,440
rows across 19 fields. Cloudflare persists bounded batches of groups separately, so native execution
time does not predict hosted latency. See [[evidence/standings.json|standings validation]].

The tested server deployment uses Linux containers; native Windows is not
validated. DuckDB portability does not establish portability of the whole
stack.

## Cloudflare snapshot cost

The hosted archive standings trial took approximately 42 minutes per insert or
rollback. Sampled progress attributes roughly fourteen minutes to copying the
physical database (about 7.6 GB logical), fourteen to source ingestion, one to
finishing the SQL relations, nine to the bounded ranking finish, and the remainder
to publication and visibility. These are sampled stage boundaries, not a CPU
profile. That trial used a full physical copy for every capture. The Cloudflare
reader now retains a pristine baseline and transfers only changed physical blocks
after its initial bootstrap; see [[../../../libraries/mecha/docs/compute#cloudflare-snapshot-execution|the reader contract]].
A one-match change still causes logical source loading and a standings recount.
Coalescing reduces captures; it does not make the algorithm incremental. The
previous hosted timing does not measure the incremental physical transport.

Source transfer permits up to 1,024 rows within the existing 256 KiB row-payload
ceiling, while DuckDB inserts remain split into 32-row sub-batches. An alarm
reuses acknowledged source progress and reloads durable progress after an error
or restart. Output publication limits are unchanged. Physical reader status uses
an index on unfinished files and skips that lookup after import completion.
The [[evidence/production-review/source-transfer-profile.json|local Workerd benchmark]]
transferred 16,384 narrow rows in 16 rather than 128 data pages, taking 286 rather
than 1,028 ms with the same measured WASM heap. This does not establish hosted
latency or total isolate memory. Wide rows remain limited by bytes.

An old 128-row Reader remains compatible with the new Query runtime. A new
Reader emitting larger chunks must not feed an old Query runtime. Immutable
worker owners retain in-flight work, so deployment must preserve or explicitly
drain those owners before switching; changing a binding is not a migration of
an existing capture. The benchmarked larger chunks are not yet deployed.

The hosted memory-limit resets were reported by coordinator alarms, with a
subsequent drop in source PostgreSQL WASM allocation. Companion tails recorded
no corresponding errors, but neither observation identifies the allocation that
exceeded the whole-isolate limit. Bounded requests and retry recovery do not
prove that memory pressure is fixed.

## Scaling limits

In native RisingWave mode, steady-state relational work uses maintained deltas; capture and publication
are bounded by changed outputs and affected computation partitions. A global
rating dependency can still affect many phases, and the WASM fitter remains
batch-oriented. Initial carrier installation, source reconstruction and captured
baseline transfer cost a full scan. The current Durex worker is serial; WASM
parallelism is inside its calculation runner. Archive-scale throughput is not
measured.

The normal deployment maintains all statistics after [[archive-import|importing legacy records]]. Imported derived results are initial data, not immutable history: ratings publication replaces them and chances publication captures new odds history.

Run `sayt generate` to regenerate the SQL artifacts, `sayt test` for query
and numerical equivalence, and `sayt integrate` for the running application.
