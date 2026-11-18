---
type: howto
title: Release the archive to Cloudflare
description: "GolAberto with its full archive on Cloudflare: restore a data directory, check it locally under wrangler dev, then deploy and load the database Durable Object; validate archive-scale snapshot computation separately."
---

# Release the archive to Cloudflare

GolAberto's edge release is pronto's [edge target](../../../plugins/pronto/docs/release-targets.md#cloudflare):
a Worker in front of a separate renderer and a database Durable Object running mecha's
[edge cluster](../../../libraries/mecha/packages/mecha-edge/README.md) over
PGlite, its data directory in the object's SQLite. The archive is too big to
rebuild from the migrations, so its data directory comes from the archive
trial's database ([archive import](archive-import.md)), derived tables
included. The generated release packages admitted Duckstream
computations in three private immutable companion Workers: a Reader Durable Object
materializes an immutable PostgreSQL image, a Query Durable Object runs DuckDB,
and a Compute Durable Object runs the static SES cage and the same numerical
WASM modules. Private service bindings connect them to the database
coordinator. Cortex retains captures and retries in the database object and
publishes each result with its receipt. A separate computation coordinator object
owns execution and retry alarms; request serving and clock alarms do not await
those computations.
Standings, game cards, team-game projections and player counters use Duckstream SQL.
On Cloudflare their relational work runs in the separate DuckDB
object; on native Kubernetes/GKE it runs in RisingWave. Player-counter publication
updates only its declared columns, preserving independently computed rating
metrics. SQL drains still maintain rounds and display enrichment.
Cloudflare uses snapshot recounts. Guests can browse; passkey accounts with an
editor grant can write through the same CRUD boundary used by hosted verification.

The current archive release includes five completed computation receipts. Home,
championship, standings, odds and rating-chart reads passed hosted browser checks after
the reset. These checks establish serving health, not sustained concurrent load
or completion of a new full-archive computation after a match edit. See
[[evidence/production-review/bounded-runtime.json|release evidence]].

The live archive's storage and serving path is page-backed: PostgreSQL files
stay in the Durable Object's SQLite and PGlite reads the needed blocks through
`SqliteFS`. Its repeatable-read public snapshot queries those files; it does not
copy every table into JavaScript. Stored statistics were computed offline.

The bounded computation path freezes PostgreSQL file metadata under the source
serializer and preserves changed blocks through SQLite copy-on-write. A separate
Reader Worker imports that immutable image and materializes private PostgreSQL
relations without occupying the serving Worker. Transfers carry at most 128 rows
or 256 KiB per chunk. Reader ownership remains durable across release changes
until the owning companion acknowledges cleanup. DuckDB stores inputs,
intermediate relations, numerical checkpoints and unpublished outputs in its
own Durable Object's SQLite, with a 32 MB engine budget and disk spill. Ratings
and chances declare resumable `steps`; each step commits its scratch changes,
output and checkpoint atomically. Large evaluation inputs are encoded from
ordered DuckDB pages into a bounded 24 MiB WASM input buffer; they never become
a complete JavaScript row array. The numerical WASM modules are unchanged.
Publication stages bounded output chunks in PostgreSQL and commits all sinks
with their receipt in one transaction.

Standings execution batches up to 32 consecutive groups, bounded by 128 members,
8,192 input rows and a conservative 4 MiB encoded-input estimate. Each output page
is limited to 128 rows and 256 KiB. The existing ranking and form functions process
each group; only the accepted prefix advances the durable cursor. Oversized groups
and partial group checkpoints use paginated execution. The 64 scratch partitions
bound preparation; batched reads share a scan for groups in the same partition
and combine at most four scan branches per query. Bounding returned rows alone
does not bound the memory held by concurrent scan operators. These limits do not
introduce parallel publication or change ranking semantics.

The previous directory used raw 8 KiB blocks. Read-only Cloudflare metadata measured
8.716 GB against the 10 GB per-object limit; full ratings publication needed more
headroom. Earlier 128 KiB compressed publication profiles used diagnostic
storage, not the production format.

The app publisher requests 8 KiB deflate storage and completes
[[../../../libraries/mecha/packages/pglite-workerd/README#the-data-directory|bounded storage maintenance]]
before PostgreSQL migrations or computation boot. For an in-place release, data,
authentication, source generation and receipts remain in the same object. During conversion,
database requests return 503; a durable cursor resumes after interruption, and
an unsupported format marker prevents older code opening mixed encodings.

A full-archive local workerd rehearsal converted 989,968 blocks in 967 requests,
reducing SQLite usage from 8.689 GB to 4.310 GB in 288 seconds. Each request took
less than one second. Independent hashes verified all 8,109,729,936 logical bytes
and file metadata; PostgreSQL reopened after conversion. These are local timings,
not a promised hosted maintenance duration. The November 6 in-place release converted
the live directory without replacing its generation or authentication state. SQLite
usage fell from 8.79 GB after the first conversion batch to 4.38 GB on completion.
The local conversion hashes remain separate evidence. See [[evidence/production-review/bounded-runtime.json|the capacity evidence]].

The ratings index migration keeps the primary key and the covering
`(team_id, measure_date DESC, id)` index used by chart and latest-rating reads.
It removes two overlapping indexes, reducing native index storage by 690 MB
on the archive fixture. Browser notifications use a transaction-wide row budget;
larger updates invalidate the affected shapes for an automatic refetch.

Automatic full-archive publication remains above the measured edge CPU budget.
The monthly baseline trial reached 301 seconds of process CPU without committing;
recovery verified unchanged public rows and intact staged results. For a fresh
installation, prepare and publish the baseline locally before uploading its
closed database directory. This avoids running the initial bulk transaction in
Cloudflare; it does not establish capacity for later large month transitions.
 Identical staged rows are
filtered before inserts, avoiding conflict locks and heap writes. The
[[statistics#computation-boundary|application's seven-year history window advances monthly]],
while current-month matches enter immediately. The prior per-match window shift
changed about 1.27 million stored ratings in the October 5→7 fixture. Monthly
anchoring removes that cause of per-match rewrites; bootstrap and month transitions
can still publish large changes. Coalescing combines pending changes into a
subsequent snapshot, without reducing the work within that snapshot. The complete
write transaction must fit hosted CPU and storage limits.

A publication design must either establish a bounded transaction on the serving
database or prepare versioned sink generations and atomically switch their
visibility. The latter also needs compatible dependent queries, source captures
and frontend synchronization. Committing chunks directly into current public
tables would weaken the declared multi-sink transaction contract; splitting
statements inside one transaction would still hold the source serializer.

Full-archive ratings and chances outputs under the earlier per-match window
policy match the independent numerical references exactly, with diagnostic capture/fork provenance retained in the
capacity evidence. The monthly policy also has calendar parity and a complete archive history run.
The October fixture changes 2,232 historical rows (1,116 updates and 1,116 inserts),
with no changes before October 5; see [[evidence/monthly-history.json|monthly evidence]]. Chances
completed all 15,518 groups and 1,134,231 output
rows. An uninterrupted import of 8,672,468 source rows also passes after lowering
DuckDB's automatic checkpoint threshold to 1 MB. These local proofs do not
establish full hosted publication capacity: production has 3,290,664 player
appearances and chances reads 8,195,365 rating rows. See
[[journal.html#production-review-20261024|the live-code inspection and production counts]].

A bounded seeded demo does not establish full-archive computation capacity.
The 7 GB archive below requires a separate check of capture transport, DuckDB
working memory, query results and numerical execution: each Worker isolate has
128 MB for JavaScript and WASM. Separate Workers isolate those allocations but
cannot pool their limits for one query or job. Completed captures are reclaimed,
while pending retry inputs and small publication receipts remain durable. A
new computation version can bootstrap a snapshot even when restored derived
tables are already populated; check that bootstrap against an isolated archive
copy before adopting the release on live archive data. See
[[../../../libraries/mecha/docs/compute#cloudflare-snapshot-execution|the execution contract]].

The release enables [[../../../plugins/omnishell/docs/native-worker-ssr|native M-SSR]]
at `https://golaberto.bonisoft3.com`. Public pages render against the existing
database object's current read-only snapshot; enabling SSR preserves its
namespace. The app publisher explicitly requests the storage conversion above.
`meta.edgeClock: "disabled"` keeps the archive’s
stored cron schedules inactive on this archive release; computation alarms
remain active. Native deployment clocks continue to run normally.

The app-owned [[../tools/publish-cloudflare.ts|publisher]] keeps the generated
renderer in its own Worker. PostgreSQL owns the read-only snapshot through the
streamed response lifetime and the renderer reads through private RPC. This
separates DOM allocations from the database isolate's memory budget. Combining
them reduced RPC latency, but a hosted render still exceeded memory after the
large aggregation drains had moved out. The separate renderer is therefore a
resource boundary; latency is measured in the release evidence.

Speculative requests use existing cached HTML without starting a render or
refreshing a stale entry. A prefetch cache miss returns `204` with `no-store`;
actual navigation retains the generated cache and revalidation behavior.

It needs Docker, mise and a Cloudflare account on Workers Paid: the archive is
about 7 GB in the object's SQLite (10 GB per object), and loading it writes
about 900,000 rows.

## 1. The data directory

Dump the trial's database without writing to it, then restore the dump into a
PGlite data directory, the roles first (a dump carries none):

```sh
docker exec golaberto-archive-golaberto-database-1 pg_dump -U postgres -d golaberto \
  --schema=public --schema=mecha --schema=golaberto_history --schema=golaberto_upload --schema=pgroll \
  --no-owner --no-publications --no-subscriptions --no-security-labels > <work>/golaberto.sql
cd libraries/mecha/packages/pglite-workerd
mise exec -- deno run -A restore.ts <work>/golaberto.sql <work>/pgdata \
  --roles ../../../../apps/golaberto/services/database/migrations/001_roles.sql
```

`legacy`, the import's staging, stays out; `golaberto_upload` comes along
because `team`'s logo triggers and foreign key name it, and `pgroll` because
its ledger says which migrations the trial ran. The restore takes about 12
minutes for 7.1 GB.

## 2. The release

```sh
cd apps/golaberto
./saytw release@cloudflare --from=<work>/pgdata --snapshot
```

`--snapshot` builds `dist/cloudflare`, applies the archive storage and CPU policies,
and stops before publishing. The build
is pronto's [`edge.ts`](../../../plugins/pronto/bundle/edge.ts): the page,
PGlite for workerd (baked from mecha's pinned sources, about 9 minutes the
first time), and `dist/cloudflare/pgdata`, a copy of the directory with the
cluster's pgroll migrations its ledger lacks applied, as the trial's migrate
step would ([`migrate.ts`](../../../libraries/mecha/packages/pglite-workerd/migrate.ts));
`900_seed.sql` is no pgroll migration, and the archive holds its rows.

Cloudflare holds `JWT_SECRET`. The shared publisher verifies and preserves the
existing deployed signing secret on every release, regardless of a local key.
For a first deployment it uses `JWT_SECRET` if supplied, or generates a key and
stores it in Cloudflare. Never commit a secret. `--keep-jwt-secret` additionally
requires an existing deployed secret; it refuses reset and temporary deployments.

When intentionally replacing the entire installation, use `--reset` instead.
The app publisher forwards it to the standard directory loader and does not
require the old local JWT secret. This discards the hosted database; it is not
an in-place update. Prepare the new baseline before invoking it.

The [[../tools/bootstrap-cloudflare.ts|offline bootstrap helper]] publishes
verified output JSONL through the real coordinator. Its manifest pins each
computation version, complete source fingerprints, output hashes and producer
evidence. It validates source data again before publication and stores the
ordinary publication receipt; it does not mark pending work complete by hand.
The producer remains responsible for computing correct outputs from those inputs.
The app helper additionally checks every team-chance label against its declared
Team source, including completed-receipt reuse. Hash agreement alone cannot
establish that an output was computed from the claimed input.

```sh
deno run -A --config tests/deno.json --lock tests/deno.lock --frozen \
  tools/bootstrap-cloudflare.ts dist/cloudflare <work>/pgdata <work>/manifest.json \
  --require-complete
```

Drain dependent SQL enrichments, then reopen with the release's real coordinator
and drains and verify no pending claims. Copy only the closed prepared directory
into `dist/cloudflare/pgdata`; do not rebuild afterward and silently change its
computation versions. A lost reset acknowledgement is reconciled only after the
loader verifies an incomplete, empty hosted directory.

## 3. Check it locally

Under the wrangler mecha pins, with local secrets, behind a TLS door:
browsers open six HTTP/1.1 connections to an origin, and each tab holds one
shape request open per table it syncs, so over plain `http` a screen's reads
queue behind them. Cloudflare serves HTTP/2.

```sh
W="$(mise -C libraries/mecha/packages/pglite-workerd where npm:wrangler)/node_modules/.bin/wrangler"
$W dev --config apps/golaberto/dist/cloudflare/wrangler.jsonc \
  --config apps/golaberto/dist/cloudflare/renderer.jsonc --port 8798 \
  --config apps/golaberto/dist/cloudflare/compute/reader/wrangler.jsonc \
  --config apps/golaberto/dist/cloudflare/compute/queries/wrangler.jsonc \
  --config apps/golaberto/dist/cloudflare/compute/execution/wrangler.jsonc \
  --var JWT_SECRET:local --var IMPORT_TOKEN:local --persist-to <work>/state
# another shell: a TLS door with HTTP/2 (caddy is GolAberto's pin)
"$(mise -C apps/golaberto where github:caddyserver/caddy)/caddy" run --adapter caddyfile --config <work>/Caddyfile
```

The door's certificate is the locally trusted mkcert pair GolAberto's own
launch writes to `apps/golaberto/.certs/`, so a browser opens it without a
warning; `<work>/Caddyfile`, with that directory's absolute path:

```caddyfile
{
	admin off
	auto_https disable_redirects
}
https://localhost:8443 {
	tls <golaberto>/.certs/localhost.pem <golaberto>/.certs/localhost-key.pem
	reverse_proxy 127.0.0.1:8798
}
```

Load the directory into the object through `/import`, with
[`load.ts`](../../../libraries/mecha/packages/pglite-workerd/load.ts) given
`http://127.0.0.1:8798` and the bearer `local`; it resumes where a run stopped
and ends by hashing every chunk in the object, then marks the directory
complete. On 2026-10-10: 7.1 GB in 79 s, verified in 33 s, and a cold object
answered its first guest in 0.7 s. Then browse `https://localhost:8443`.

## 4. Publish

```sh
cd apps/golaberto
mise exec -- deno run -A --config ../../plugins/pronto/bundle/deno.json \
  ../../plugins/pronto/bundle/publish-edge.ts dist/cloudflare --mecha ../../libraries/mecha
```

The snapshot is already prepared by the app's generated release recipe. Publish
that artifact through the shared
[[../../../plugins/pronto/bundle/publish-edge.ts|publisher]]. It deploys the private
Query and Compute companions before the renderer, database and app Workers, using
their content-derived names to bind the execution contract. Deployment uses the
pinned Wrangler (run `wrangler login` first), preserves the deployed signing
secret, sets a new `IMPORT_TOKEN`, and loads the directory into the deployed
object. A release after the first loads nothing: the object's directory is
complete, and it is live data from then on.

For a release without offline preparation, `./saytw release@cloudflare --from=<work>/pgdata`
builds, prepares and publishes in one invocation. The generated mirror workflow
uses the same recipe, so it also applies compressed storage and the CPU policy.
Do not run the app preparation helper twice on an artifact: it rejects an already
transformed database entry. Rebuild a fresh snapshot when changing the generated code.

Use `--reset` only for an intentional replacement installation. Add
`--keep-jwt-secret` to the shared publisher to require an existing deployed
signing secret; these options are mutually exclusive. On 2026-10-10 the first publish
loaded 7.1 GB in 695 s (10.2 MiB/s from the releasing machine) and verified it
in the object in 70 s; a guest's first request reached an object the platform
had evicted in about 2 s, a warm one in 0.25 s, with no memory or CPU kill.

## 5. Check it

The public hostname is `golaberto.bonisoft3.com`, declared in
`code.meta.domain` so generated releases retain the Worker's custom domain.
Enable Early Hints in the `bonisoft3.com` zone under Speed → Settings → Content
Optimization. The [[../../../plugins/pronto/docs/release-targets#cloudflare|edge target]]
already emits the route's content-addressed preload headers. Check a repeated
HTML request over HTTP/2 for an interim `103` before the final `200`; headers on
the final response alone do not prove Early Hints is active. Cloudflare may omit
103 if the final headers arrive first.

```sh
cd apps/golaberto
mise exec -- deno run -A tools/edge_check.ts https://golaberto.bonisoft3.com --idle 300
```

[`tools/edge_check.ts`](../tools/edge_check.ts) reads what the screens read, as
a guest, derived tables, campaign points and player pages included, each twice
(the second from the Worker's cache), after waiting for the platform to evict
the object, and fails on any empty or failed read. An empty recent feed is
accepted only when the played games also fall outside its 14-day, 3-hour window;
historical played games must still return rows.

## What it does not do

- **Archive-scale live computation is blocked.** Keeping JSON result columns
  uncompressed lowers the full archive games query's WASM heap from
  150,536,192 to 72,548,352 bytes for 305,088 rows. The subsequent full ratings
  probe still loses its Worker connection at appearances stage 12; the cause
  has not been established. [[evidence/production-review/query-memory.json|Query evidence]]
  records the successful mitigation and remaining failure. This is not an
  end-to-end capacity proof or a measurement of total hosted isolate memory.
- **Capture pauses database requests.** The source object serializes the whole
  transaction that copies the computation's inputs. The full chances capture
  took about 315 seconds locally after compression coalescing, with about 287
  seconds of total process CPU; this is not a measurement of hosted isolate
  billing. A concurrent request waited roughly 294 seconds in the follow-up
  probe. Independent Query and Compute objects isolate subsequent work, but
  cannot make that source capture preemptible. Production admission requires
  both bounded query memory and a capture design that preserves request
  responsiveness. See [[evidence/production-review/source-capture.json|capture evidence]].
- **Snapshot execution recomputes retained inputs.** It supplies no incremental
  RisingWave state at the edge.
- **Archive logos** still use their original URLs; this release does not migrate them into blob storage.

## Verify a live statistics update

`./saytw verify@cloudflare` checks deployed routes and browser journeys. To also
exercise `test-standings-live`, set `GOLABERTO_VERIFY_GAME_ID` to an existing match
and provide an authenticated editor session through `SAY_VERIFY_ARGS_SESSION`
(the JSON `{token,user}` returned by authentication). An existing category is
required. `GOLABERTO_VERIFY_SETTLE_MS` sets the deadline for each statistics
transition; it defaults to five minutes. Each CRUD request has a 30-second deadline;
a failed cleanup retains the recovery record.

The journey creates a disposable categorized competition, phase and group using
the selected match's teams and calendar day. Categorized competitions are excluded
from the ratings query, isolating this fixture from global ratings. After its
zero-goal standing appears, the journey inserts a 1–0 match through ordinary CRUD.
It checks that the published standing and the original browser document show one
home goal, deletes the match and checks that both return to zero. It then removes
the memberships, group, phase and competition; group deletion also cascades its
odds history. Existing archive matches and their correction history are not edited.

Compensation runs after failed assertions as well. Conditional deletes compare
returned rows and their transaction IDs, refusing concurrent edits. An insert
whose response was lost can still commit later: absence alone is not proof of
rollback, so an unknown insert outcome retains the recovery record and parents. A process kill
cannot run `finally`: the printed recovery JSON identifies the fixture records
until cleanup succeeds. Screenshots capture before, changed and restored states
beside that file. Without a selected match, verification explicitly reports the
mutation case as skipped and runs the ordinary deployment sweep.

After stopping the previous verifier, `GOLABERTO_VERIFY_RECOVERY` can name its
recovery JSON to resume an intact fixture. The editor, deployment, source match,
insert receipts, fixture rows and editable children must still match. Five saved
inserts with an unsubmitted match resume the normal 0→1→0 journey. Six saved
inserts with the unchanged owned match present start an inverse journey in a new
document: observe one goal, conditionally delete the match, observe zero, insert
the same fixture match and observe one again. The restored match and all parent
fixtures are then removed. Copy the recovery JSON to a private new path before
resuming if the previous screenshots must remain available.

Partial setup, unknown write outcomes, external edits, additional editable children
and correction history are rejected without writes or cleanup. An absent match
before the inverse delete does not authorize recreation. A failed or unconfirmed
delete retains the recovery record and parents; a lost restoration insert response
also retains them unless a matching transaction receipt proves the write is owned.
Only declared date fields accept equivalent date-only and UTC-midnight forms;
timestamps and actual calendar-day changes remain distinct. A fresh successful
journey supplies its own mutation and restoration proof; resuming does not turn
a previous failed run into a pass.

Run this fixture journey in an isolated verification environment without concurrent
editors. Child checks and conditional deletion are separate requests: the parent
transaction guard cannot prevent a concurrent child insert from being cascade
deleted. The checks detect existing edits, not arbitrary concurrent changes to
the fixture graph.

Keep the browser host awake for long verification runs. On macOS, prefix the
verification command with `caffeinate -is` so the sleep assertion ends with that
process. A suspended browser can resume requests carrying expired shape tokens;
the client recovers, but the strict network gate still reports those responses.

A successful mutation journey proves standings publication and live synchronization
on that deployment. It does not establish completion of ratings or odds,
month-transition capacity, or sustained concurrent load.
