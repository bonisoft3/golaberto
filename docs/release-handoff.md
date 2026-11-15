# Release handoff

Status: pending review before merge. Reported by the preceding Golaberto agent on
8 November 2026. On 9 November the user chose to combine the prepared release
with the Duckstream work in [PR #2325](https://github.com/worldsense/trash/pull/2325).
The original handoff is retained below, followed by verified release results.

## Release and ownership decisions

1. **Golaberto release.** The reported release branch is at `4d603aebba`, with
   `main` merged and committed, a clean working tree, and merged PR worktrees and
   branches removed. The prepared database is
   `~/code/golaberto-data/cf-2026-11-08/pgdata`, with its migration ledger
   established. The final main merge still needs regeneration and testing before
   publishing. This would be the first real Wrangler deployment with a container
   and the first live database carry. The previous agent reported having the
   exact publish command and environment in memory, but did not include them in
   this handoff: recover and verify those details before executing a release.
   See [[cloudflare-release]].
2. **#2171 handover.** Decide whether to push its branch, open a fresh PR, or hand
   it over to galo2099's PR. The reported branch is far ahead of its PR head
   because it includes main. Verify the branch and target heads before choosing.
3. **Platform releases.** The reported release order is Pronto, Omnishell, then
   Mecha, to enable Golaberto and Apexrun mirror synchronization. Omnishell's
   Mecha pin reportedly lags the client entry required by its bundle. Confirm
   the dependency pins and release order against current main before publishing.

## Follow-up work

4. Move Golaberto's Duckstream and Cloudflare tools into Pronto verbs. This blocks
   Golaberto's mirror under `check-mirror`. Give the four Pronto tests that still
   read Snapcards their own fixtures.
5. Investigate why edge-compute's native DuckDB build does not reproduce its
   manifest hashes in CI; this keeps Pronto's Cloudflare test platform local-only.
6. Implement the two designed platform pieces from
   [[decisions/2026-10-28-crawling]]: DuckStream views and bounded dead letters.
7. Investigate the reported live Durable Object resets under crawler traffic and
   recover the previously proposed render-caching fix. Treat the traffic cause
   and proposed remedy as hypotheses until checked against live evidence.
8. Retain these smaller compatibility issues in review: the Docker path for a
   live container database reportedly gets no reducers (pre-existing);
   `game_archive` column order differs between fresh and carried databases by
   design of pinned migration `035`; Apexrun's `ci-desktop` mirror job awaits an
   Omnishell release.

## Duckstream follow-up verification

In PR #2325's worktree, main was merged as `83b495fb2b`; `8c6b5d5b74` fixes the
worker retry integration test's untyped JSON response. The real-workerd retry
and public-snapshot tests passed after that fix. Before it, Golaberto CI passed,
while the PGlite job failed at that type check; all checks in CI run `42544554540` subsequently passed, including Golaberto,
PGlite/workerd, Bonisoft3, platform pins and distribution bootstrap.

Hosted HTTP checks passed, but browser hydration stalled while `/auth/guest`
remained pending. A direct guest request timed out after 30 seconds. The backend
cause is not established, and no new mutation/rollback proof was obtained. A later
probe still timed out. The operator `IMPORT_TOKEN` was rotated successfully; the
new token is held privately at `/tmp/golaberto-release-import-token` and must not
be copied into Git. An authenticated `/import/restart` request also timed out at
30 seconds, with a canceled request and no exception in the Worker tail. This is
not confirmation of a successful restart. No data reset or prepared-release
publication was performed.
The local Docker replay check passed; visual integration failed because the
compute service did not become healthy before its startup deadline. Do not
conflate this follow-up's deployment evidence with the separately prepared
release at `4d603aebba`.

## Release attempt from PR #2325

The pinned Cloudflare runtime build completed, but `release@cloudflare --snapshot`
with the November 8 prepared directory failed before publication. Its ledger
rejected `005_create_tables.sql` as changed. Comparing the prepared
`migrations.json` with this branch's release scripts also found differences in
`006_policies.sql`, `007_txid.sql`, `008_publication.sql`, `035_read_parity.sql`,
`046_team_projection_turn.sql`, and `801_schedule_seed.sql`. Do not relabel that
archive's migration history to bypass the check.

On 9 November the user chose to combine #2171 with #2325. Merge commit
`dd81f4a458` includes `4d603aebba`. The home-feed migration names are restored to
`050_home_feed_relationships` and `051_home_feed_relationship_names`, matching
the prepared archive; all six SQL/pgroll artifacts retain identical content.
Generation and lint passed. The architecture review found no actionable issue.
The Cloudflare snapshot release passed and applied 36 pending scripts to its
copy of the archive. The original prepared directory is unchanged.

The combined release published successfully on 9 November. Worker version
`fe66cce3-54bf-4f0a-81b5-71d9fc4f9a2e` serves the site, with the SofaScore
container deployed. The publisher verified 3,045 chunks across 1,648 files
(7,077.6 MiB). Its Docker preflight used a private release-scoped configuration
and the local `desktop-linux` builder; global Docker configuration is unchanged.

Hosted verification passed 453 assets, six catalogues, 24 document routes and
negative caching checks. The live homepage hydrated without page errors. Browser
verification is not green: the statistics journey timed out before creating its
fixture, and the score editor missed its readiness deadline. No mutation or
rollback proof has been obtained for this release. CI exposed a cards output
missing `fixture_available`, which rejects publication of the cards batch, and
an outdated snapshot scheduling assertion. Fixes passed generation, lint, build and the full app tests. Update Worker
`092c7eab-d0cf-4b92-a445-701190d656c3` published successfully, preserving the
uploaded archive. Its hosted HTTP sweep passed 454 assets, six catalogues and
24 document routes. The browser rerun created its isolated fixture and is
waiting for the initial statistics publication before the mutation and rollback.
The app job passed all 18 acceptance tests, then failed one of 90 constraints
on a SofaScore deadlock. Additive migration `20261111_sofascore_lock_order`
fixes control/source ordering and skips request rows already locked by result
delivery. Two-session regressions pass; a separate Rust test-readiness race is
also fixed. Generation, lint, build and full app tests passed after the fixes.
Main is merged through `38e40e450b` in `f74398e7f0`; all CI checks passed.
The initial live standings publication finished and cleared the failure marker;
the verification fixture is waiting for a later revision. Worker `d2144183-1f53-4bb0-acba-ac79e3bec300` published the migration with
unchanged compute and reader identities. Final HTTP verification passed 455
assets, six catalogues, 24 routes and negative caching. All CI checks passed
on `f74398e7f0`. The separate ordinary browser sweep passed all 41 journeys
and 41 screens. The live statistics verifier observed its baseline without a
reload, inserted the test match, and is waiting for revision 4 publication
before checking the changed value and rollback. The verifier subsequently
confirmed goals changed from 0 to 1 without reload; rollback subsequently passed without reload and the disposable fixture was removed. Full-archive snapshot transfer
and publication take tens of minutes; this is not a low-latency proof. A
Durable Object queue overload interrupted preparation, but retry resumed and
computation completed. The later browser sweep failed on Durable Object queue overloads and readiness timeouts; the complete verifier did not pass.

The first attempt to publish the forward migration was correctly refused: the
one-off editor grant had been recorded without a `.sql` suffix, classifying
it as a pgroll migration after all numbered migrations. After review, a separate
SQL-file step verified the original grant digest and renamed only that grant
receipt with `.sql`, preserving its digest and timestamp. No schema history was
rewritten. The publisher then applied `20261111_sofascore_lock_order`. Future
operator grant/revoke steps must use `.sql` names. The verification account
remains granted until its active browser run and cleanup finish.

Incremental physical reader work now retains a pristine per-computation baseline
and transfers changed blocks after bootstrap. Local workerd tests measured
81,485,919 initial bytes versus 8,192 for the next committed capture, including
restart and supersession checks. Storage, focused runtime, production-source lifecycle, app build, lint and app
test gates pass. Native integration exposed and prompted a fix to the cards
PostgreSQL source projection; its two-engine regression passes and full app
gates passed. Main is merged through `103b7232be`. Worker
`7be75cb9-d447-4905-8ca6-804e33d8b0e9` deployed this change, retaining the
archive. Its HTTP verification passed 461 assets, six catalogues, 19 routes and
the negative caching probe. Mutation/rollback verification is running against
reader `golaberto-reader-422c5db1468c` and compute
`golaberto-compute-41df235bab3d`; the first physical bootstrap completed and
retained revision 6 as its acknowledged baseline. All declared source rows have
loaded and all four queries completed. Standings preparation reached checkpoint
100 of 129 without a reported failure; publication and the subsequent delta
capture remain under verification. The browser run and its editor grant remain
active; remove the disposable fixture and revoke the grant after verification. All CI checks passed
on `c38d98d761`, including Golaberto and workerd. Delta transfer also skips unchanged files:
the local regression used 1,086 block pages initially and one on the next capture.
An isolated spike reproduced compiler memory pressure behind the native timeout;
the image now limits Cargo to two build jobs. Full app gates pass. The complete
local native rerun got past the management timeout, then rustc compiling
`aws-sdk-glue` was killed (SIGKILL). CI passes the host integration adapter;
it does not prove the Docker/Feldera integration path.
The local Docker VM has 7.7 GiB RAM. No global Docker resources were changed.

Commit `3bffaeaddf` removes per-page PostgreSQL transaction admission from the
physical transfer. It preserves per-page source-generation, reset and snapshot
guards and the final publication fence. The source regression proves zero source
transactions after first admission, one for the next restore/delta/materialization
cycle, and rejection of reset or missing snapshots. All 12 bundle lifecycle tests
pass. This main-Worker-only update retained reader `golaberto-reader-422c5db1468c`
and resumed its partial bootstrap. Initial live samples reduced median preparation
from about 4.2 seconds to 72 milliseconds; the complete hosted mutation/rollback
journey is still running. Commit `29d06c3235` removes unused request bodies
from the lifecycle fixture; five consecutive local runs and the Linux workerd
CI job passed. All CI checks passed on `29d06c3235`.
This does not eliminate logical source ingestion or batch computation.

Resolve or explicitly retain each pending item in review; remove this handoff
when its remaining contracts and limitations have moved into the reference docs.
