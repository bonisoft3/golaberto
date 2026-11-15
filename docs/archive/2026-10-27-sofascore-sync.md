# SofaScore updates with bounded polling

Status: archived. The implementation and current operating contract are in [[../sofascore-sync]]. Endpoint verification and rollout remain separate gates. This record preserves the decision and evidence as of its date.

Decision date: 2026-10-27.

## Contract

Update enabled championships from SofaScore. The reader chose completed results
within 30 minutes, without live scores, including lineups, goals, substitutions
and player appearances. Fixtures, kickoff changes and match status are included.
Do not crawl the historical archive or all SofaScore competitions by default.

The freshness target starts when SofaScore makes a complete final result
available to the supported endpoint. Use a maximum 20-minute summary interval,
a planner tick of at most one minute, and a nine-minute reserve for fetching,
applying and capacity delays. Apply the result before waiting for lineup or
incident completion. Fetch details immediately after detecting the final result;
late or unavailable source details have a separate pending/degraded status.
Provider outages, cache delays, access failures and exhausted request budgets
must make missed freshness visible rather than silently claim this target.

Minimize requests first, then transferred bytes, then unnecessary database work.
A 304 saves response bytes; it still consumes a request. A local content hash
avoids writes; it cannot detect a remote change without a request.

## Evidence and capability boundary

The supplied example is
[round 1 of tournament 23, season 95836](https://www.sofascore.com/api/v1/unique-tournament/23/season/95836/events/round/1).
An ordinary direct HTTPS request on 2026-10-27 returned HTTP 403 with a JSON
`Forbidden` response. The same endpoint subsequently succeeded using the original
custom Rust fetcher: one call returned 41,860 body bytes containing ten finished
events and `hasNextPage: false`. Its events include numeric team IDs, names,
countries and gender, plus regulation score fields. No extra team lookup was
needed for these identities. The original CLI does not expose response headers,
so this test does not establish cache-validator or conditional-response behavior.

Before implementation, capture successful, permitted first-party responses and
headers for round discovery, a round including any pagination, lineups and
incidents. Verify endpoint paths, status meanings, period score semantics,
incident identities/order, detail completeness and empty/unavailable behavior.
The example round response is verified above; the other endpoint contracts
remain unverified in this environment. Do not base the design on a presumed
webhook, changes feed, revision number, conditional-response support or quota.

If a verified season/date batch or revision feed covers the same due matches
with fewer requests and acceptable bytes, the planner may use it. If one unresolved game remains and a verified event
summary supplies all needed fields in one smaller response, prefer it over
downloading the full round for the same request count. The initial
plan uses round batches and makes no dependency on that optimization. A source
revision may suppress detail audits only after proving that it covers those
details, not merely the score.

## Fetch plan

Bind a local championship to a provider tournament and season. Discover its
rounds, fetch each necessary round page once, and persist the fixture inventory.
The initial full inventory is necessary to find postponed games in older rounds
and fixtures whose dates changed. Subsequent polling follows persisted work,
not a full season recrawl.

A resource key includes provider, endpoint family, tournament, season, complete
round identity, page and any verified slug/prefix qualifiers. A bare round
number is insufficient for multi-stage cups. Persist all discovered round keys;
never watch only the provider's current round. Canonical keys prevent aliases
and multiple callers from fetching the same resource twice.

| Resource state | Default next check |
| --- | --- |
| Round has only fixtures more than seven days away | Weekly |
| Next fixture is one to seven days away | Daily |
| Next fixture is within 24 hours | Every four hours; also schedule its exact kickoff wake |
| A known fixture could be in progress | At kickoff, then at most every 20 minutes until resolved |
| Date is known but kickoff is unknown | Every 20 minutes across that competition-local match day and spillover; show the greater traffic cost |
| Explicitly postponed with no new kickoff | Daily; return to ordinary cadence when rescheduled |
| Round is entirely terminal | One next-day check, then the weekly active-season summary audit |
| Season has closed | Closure audit and a final audit 30 days later; then frozen until explicitly requested |

Refresh the round inventory daily while its season is active, using a verified
round-discovery contract. Once weekly, reconcile all round summaries in an
active season to catch moved fixtures, new knockout rounds and older score
corrections. A due active-round fetch also satisfies its fixture/audit check;
these are reasons for the same request, not separate requests.

Poll from kickoff rather than assuming every match finishes at kickoff plus
105 minutes: early endings, delays and extra time make that assumption unsafe.
No live score is applied to `game` while a fixture is still in progress. A
prolonged unresolved match raises an exception for review; budget exhaustion or
an explicit pause marks its freshness degraded. It must not poll forever
without being visible or be silently marked finished.

Schedule drift is checked at the cadences above. A newly advanced kickoff may
escape the usual final-result target until rediscovered. A strict 30-minute
status guarantee for every unscheduled change would require continuous polling
or a verified provider change feed; that is outside this low-traffic contract.

### Details after completion

Fetch a match's lineup collection and incident collection once when its final
result is first observed. Reuse players and teams embedded in those responses;
do not fetch each player's profile, individual statistics, team roster or image
when the requested fields are already available. `Player` requires only an ID
and name, so verified lineup-embedded identity can create a new mapped player;
leave absent optional biography and incompatible position codes unset. Derive
appearances and substitutions from the same collections.

Store separate completeness and semantic hashes for lineups and incidents. A
complete first pass gets one correction check 24 hours later. An incomplete
collection retries after 20 minutes, two hours, 24 hours and seven days, then
stops automatically and becomes a review item. Each due collection is fetched
independently, so missing incidents do not repeatedly download complete lineups.
A 404 is not automatically a known-empty collection. Use source capability
flags only after verifying their meaning.

A next-day correction check is independent of the round-summary hash. Scorers
and substitutions may change without a score change. Once the settling window
ends, automatic detail auditing stops. Later detail-only corrections require a
manual refresh or a future verified comprehensive revision feed. This is an
explicit traffic/correction-coverage tradeoff; the weekly summary audit cannot
guarantee detecting such detail corrections.

### Caching and flow control

- Use conditional GET with saved ETag or Last-Modified only when supported.
  Do not send a preliminary HEAD, add cache-busting parameters or use HEAD plus
  GET. Honor source cache freshness; surface a conflict with the freshness
  target if the source cannot provide it.
- Persist the next due time and all audit/retry reasons. A daily tick or service
  restart must not refresh everything. Scheduler, editor refresh and retry join
  the same active resource attempt. An idle planner tick issues zero requests.
- Start with one concurrent provider request and an explicitly configured
  provider-wide request budget. Allocate due final-result work before detail
  retries and cold audits. Preview the expected load before enabling seasons;
  report when configured capacity cannot meet the 30-minute target.
- For 429, honor Retry-After and persist a provider-wide cooldown. Use capped
  exponential backoff with jitter for timeouts and 5xx. A 401/403 pauses provider
  work and requires an access/configuration fix. Zero Retry-After on a 403 is
  not permission to retry in a tight loop.

## Durable implementation boundary

Reuse Golaberto's Pronto schedules and SQL drains in [[../../drains.cue]] for
the persisted planner. Execute fetch attempts in an app-owned Rust worker based
on the original Golaberto `sofascore-fetch-rust` crate, inspected at source commit
`efb8f2be8b7512bd6b0487199e608e2831a354de`. Carry over its source and lockfile;
build with `cargo --locked` for the deployment target. Do not copy the installed
macOS executable into a Linux image.

The original fetcher uses pinned `wreq` / `wreq-util` with a Chrome 149/macOS
TLS and HTTP/2 profile, its five established request headers, a 15-second total
timeout, and redirects limited to SofaScore HTTPS API URLs. Its README records
prior verification of events, lineups and incidents. The new worker must validate
the actual enabled-season endpoints using that transport. Keep source access
failures visible; there is no automatic switch to a second client.

The original CLI accepts one URL and emits successful raw bytes, but discards
response headers and treats 304 as an error. Factor its transport into a worker
that reuses one HTTP client across attempts. Accept a typed resource and validated
path, plus saved conditional validators. Return HTTP status, selected cache and
rate-limit headers, final URL, redirect-hop/request count, bounded opaque body,
elapsed time and byte counts. Count every upstream hop against the provider
budget, not just the logical attempt. Reuse a verified canonical URL on later
polls to avoid recurring redirects.
Handle 304 explicitly. Verify compression support rather than assuming it.
Persistence precedes JSON decoding, including malformed 200 responses. Preserve
bounded error evidence instead of only the original CLI's 200-byte error preview.

```mermaid
flowchart LR
  C[Pronto clock] --> P[Persisted due-resource planner]
  P --> A[Immutable fetch attempt]
  A --> W[Custom Rust fetch worker]
  W --> S[SofaScore]
  S --> R[Stored opaque response]
  R --> N[Normalize and reconcile]
  N --> T[Guarded domain transaction]
  T --> D[Existing CDC and derived data]
```

Use four small records rather than one job per entity:

| Record | Purpose |
| --- | --- |
| Provider control | Enabled state, request budget, concurrency and cooldown |
| Sync resource | Canonical key, due reasons/time, validators, last success/change, completeness, semantic hash and active attempt |
| Fetch attempt | Immutable ID/generation, claim/lease/fencing token, request parameters and validator snapshot, timestamps, HTTP outcome, bounded response snapshot, parser version and apply status |
| Provider binding / baseline | Entity-specific external-to-local mappings, season-scoped stage bindings, field ownership, previous imported values and provenance; review conflicts reference the response |

The planner creates at most one active attempt per resource. Manual refresh joins
that work and respects cooldowns and minimum intervals. The Rust worker claims
attempts transactionally with `FOR UPDATE SKIP LOCKED`, a lease longer than the
bounded HTTP operation, and a fencing token. Expired leases are recoverable after
a crash. Guard response persistence and application by attempt generation/token;
an old worker cannot overwrite a later result. Notifications may wake the worker,
but periodic due-queue inspection repairs a lost notification without calling the
API for an empty queue.

The planner owns retry times and provider-wide cooldown. Do not layer hidden
HTTP retries under scheduler retries. Every intended new poll gets a new attempt;
transport recovery preserves its existing attempt identity. Persist the response
before parsing/applying it. Parser failures, constraint failures and database
retries replay the local snapshot without another GET. A crash before response
persistence can repeat an idempotent GET; exactly-once network traffic is not
promised. A 304 retains the existing body and updates only synchronization
bookkeeping. Persist failures with their reason rather than substituting empty
results. Define bounded response retention and retain the normalized baseline
needed for conflict detection.

The worker gets only the database capabilities required to claim/persist attempts
and invoke the guarded application boundary. Provider credentials, if needed,
stay server-side. The validated host/path contract is owned by code, not arbitrary
editor-entered URLs or shell command text.

Direct Airlock HTTP would use a different transport, and its current bridge
contract supports mail rather than an arbitrary Rust fetch service. This design
therefore does not require a new generic Airlock bridge, HTTP-header extension or
job system. The app-owned worker owns the small, explicit lease/recovery contract.
Source batching comes from round endpoints; connection reuse alone does not
reduce the number of API requests.

Install the schedule, resource tables and bindings with a migration that runs
on the already imported local database. Fresh-database generated SQL is not an
upgrade path. Source runtime declarations and emitted artifacts remain owned
by Pronto/Sayt.

## Reconciliation and football semantics

### Recover existing identities before contacting the API

The public archive importer omits provider columns, but retains the source-domain
columns in private `legacy.*` staging. A read-only inspection on 2026-10-27 found:

| Source | Existing usable identity evidence |
| --- | --- |
| Retained PostgreSQL `legacy.players` | 23,607 nonempty, distinct SofaScore IDs; all 23,607 public player targets exist |
| Retained PostgreSQL `legacy.games` | 10,240 nonempty, distinct SofaScore IDs; all 10,240 public game targets exist |
| Retained PostgreSQL `legacy.teams` | No SofaScore column in this imported snapshot |
| Current MySQL `teams` | 825 linked rows, 822 distinct IDs; three duplicate-ID groups require review |
| Current MySQL `players` / `games` | 23,607 / 10,702 linked rows, with no duplicate source IDs in either table |
| Current MySQL phase/season configuration | Three nonempty phase tournament-ID lists and one championship source record |

These counts describe the inspected databases, not future fixtures. Bootstrap
from retained staging first; target source fields missing or newer there with a
small reviewed export from `Golaberto_development`. Do not rerun the destructive
full archive import or replace existing teams/players. Restrict the export to
provider identifiers/configuration and necessary identity evidence.

| Original field | Binding to the existing public UUID |
| --- | --- |
| `teams.sofascore_id` | SofaScore team ID → `legacy_uuid(7, teams.id)` |
| `players.sofascore_id` | SofaScore player ID → `legacy_uuid(11, players.id)` |
| `games.sofascore_id` | SofaScore event ID → `legacy_uuid(9, games.id)` |
| `phases.sofascore_tournament_ids` | Season-scoped stage/tournament keys → `legacy_uuid(3, phases.id)`; several source keys may share one phase |
| `sofascore_championship_sources` | Tournament + season → `legacy_uuid(2, championship_id)` |

The UUID conversion applies to the legacy **local row ID**, never to a SofaScore
ID. Check that every target exists and corresponds to the expected source record.
Import phase lists and source configuration only after validating scope; convert
usable stored phase/group bindings and field baselines to the existing UUIDs.
The original championship importer is competition-specific, so its hardcoded
competition rules and default country must not be copied into the generic updater.

For teams, players and games, use
`provider_binding(provider, entity_kind, external_id, local_id, state, provenance,
evidence, reviewed_by, reviewed_at)` with a unique external key and one active
canonical provider identity per local entity. A controlled alias/merge operation
is required for provider ID consolidation.

Use a separate stage-binding key scoped by provider, unique tournament, season
and the verified tournament/stage/round qualifiers. A source tournament ID may
recur in another season; a local phase may intentionally cover several source
tournament IDs. Allow those several compound source keys to resolve to the same
phase without aliases or entity merges. Confirm the championship/phase scope
before importing each legacy phase ID list.

Validate positive numeric IDs, duplicates and conflicting prior mappings before
confirmation. Quarantine only conflicting bindings so unrelated safe ones can
proceed.

The current team collisions are UAE/Sint Maarten, Katowice/GKS Bełchatów and
Bohemians/FC Yelimay. They are not aliases merely because the source assigned the
same ID. The retained archive also documents a Burundi/Burundi B fuzzy-match
error in [[../../tools/archive/production-2026-10-06.corrections.json]]. Add these
as mapping regressions; do not automatically choose the first matching row.

### Teams

Resolve an exact confirmed provider ID first. For teams without a binding, reuse
already fetched round/event payloads and known event→game bindings: the provider's
home-team ID corresponds to the local game's home UUID, and likewise for away.
Require coherent tournament/season context, distinct sides and consistent evidence
across linked matches. A conflicting ID, side reversal or country/squad mismatch
becomes a review item. This can recover team IDs without an extra event request.

For the remainder, generate local candidate suggestions from the championship's
memberships, names/aliases, country, city and club/national identity. Preserve
women, youth, reserve/B and geographic qualifiers during comparison. Names,
accents and abbreviations help rank suggestions; they do not authorize a merge.
An operator confirms an existing UUID or explicitly creates a new team. Persist
both accepted bindings and rejected candidates so the same ambiguity is not
presented repeatedly. An unresolved team blocks its affected fixture, not every
other mapped fixture in the round.

### Players

Resolve the SofaScore player ID globally through the recovered/confirmed mapping.
A transfer adds a team/season membership; it does not create a new player or
replace the global identity. Cache the mapping within each apply batch, and use
lineup-embedded IDs and names rather than requesting individual profiles.

For a new provider ID, look for unbound local candidates using full name/name,
exact date of birth when present, nationality and current/historical team-season
memberships. Search beyond the current team for transfers. Do not silently bind
on a fuzzy name, surname, shirt number or a guessed birth date. Even a unique
name/DOB candidate is proposed for confirmation when there is no existing provider
binding. Missing DOB remains null; do not convert it to the Unix epoch or infer
it from age.

If there is no plausible existing candidate, the operator may approve creation
individually or enable creation of clearly new players for the reviewed season.
Creation and its binding commit atomically under the unique external key, so
concurrent lineup imports cannot create duplicates. The current Player schema
needs only ID and name; optional biography can stay unset. If a plausible match
or conflicting provider identity exists, hold it for review instead of creating
a second player. An unresolved player keeps the affected detail transaction
pending; the final score can still update.

This means the ordinary path for the 23,607 existing source-linked players is
an exact local lookup. Only newly encountered or conflicted identities need
reconciliation, and no search/player-profile API requests are required for it.

### Games and editor ownership

Use recovered event bindings first. An unbound event may propose a local game
using confirmed team UUIDs, competition/phase and date/round context, with explicit
confirmation for ambiguous fixtures. Preserve the existing UUID and public slug
on rescheduling. A date or team name is never the durable game key.

For each owned field compare the previous imported value, the current local
value and the newly imported value. Auto-apply when the local value still
matches the baseline or already equals the source. Otherwise create a review
conflict. A first binding must explicitly select its field baseline/authority;
absence of a baseline is not permission to overwrite existing archive data.
Distinguish an absent baseline from a baseline whose actual value is null.
Record a SofaScore import byline instead of impersonating a human editor.

- Add an explicit game-status contract before importing cancellations,
  postponements, abandonment or awarded results. Today `played` alone cannot
  represent them. Update upcoming lists, match previews, standings and odds
  eligibility consistently; an abandoned game with a partial score must not
  become a final played result.
- Persist kickoff instants in UTC and retain the existing Brasília civil-date
  convention. Unknown kickoff remains null. Do not mistake a provider's
  provisional timestamp for a confirmed time. Store source precision/timezone
  evidence in the binding/snapshot.
- Apply `played` and both final regulation scores atomically. Local extra-time
  fields are goal increments, not cumulative totals: 1–1 at 90 minutes and 2–1
  after extra time becomes regulation 1–1 plus extra time 1–0. Shootout totals
  remain separate and shootout kicks do not become ordinary goals.
- Add a `Substitution` record with game, side, outgoing/incoming player, period,
  minute, added time and source order. The current domain has only integer
  appearance entry/exit minutes and cannot retain substitution pairs. Extend
  goal timing with period, added time and order as needed; source incident
  evidence preserves the original clock. Do not add a competing generic event
  model alongside this narrow representation. Use verified stable incident IDs
  for bindings when available; list positions are not stable identities. If the
  provider supplies no stable identity, reconcile the complete owned collection
  transactionally and hold ambiguous matches for review.
- `PlayerGame` distinguishes starters, used substitutes and unused bench. Its
  null exit minute currently defaults to 90 in player totals; a player completing
  extra time needs an explicit 120-minute exit. Preserve period/stoppage and
  substitution-pair evidence rather than losing it in a flattened minute.
- A missing scorer, incomplete incident collection or unavailable lineup does
  not authorize deletion. Apply reconciled complete details per event in one
  transaction, independently of the already committed score. Retractions may
  remove only unchanged provider-owned records, never manual records. Hold
  unresolved player-dependent detail writes for review without losing scores.

Use the existing guarded-upsert pattern in [[../../tools/refresh_archive.py]]:
update domain rows only with `IS DISTINCT FROM`. Keep poll timestamps, hashes
and validators outside domain tables and the computation input graph. A 304,
unchanged body or changed irrelevant metadata causes zero domain writes and
zero computation invalidations. Actual score/detail changes use existing CDC.
Do not promise recalculation of only one match: the current chances planner can
enumerate all ranked groups. Narrowing that computation is separate work.

## Request accounting

For each plan expose
`summary pages + discovery/audits + detail collections + retries + redirect hops`
before it runs.
Bootstrap/backfill traffic is shown separately from ongoing traffic. Pagination
counts as additional requests. The scheduler can optimize only verified
coverage; it must not stop at page one or infer deletion from an incomplete page.

Illustration, not a measured quota: ten matches in one round, nine polling
cycles and two detail endpoints. Round polling needs nine summary requests
instead of ninety event-summary requests at the same cadence. Fetching both
detail collections once and checking each once the next day adds forty requests
in either design: 49 instead of 130, before discovery, pagination, audits and
retries. If an endpoint does not cover the required fields, account for the
additional verified resource rather than promise this estimate.

No API call is made because someone opens a public page. An editor's update
request also uses the shared resource plan. A preview reports calls that will
be reused, calls actually needed and reasons; refresh cannot bypass cooldowns
or silently launch a whole-archive import.

## Delivery and acceptance

1. Port and validate the pinned custom Rust transport, including status/headers,
   raw response capture, 304, redirect restrictions and a long-lived client.
   Prove source access and successful endpoint contracts with saved minimal
   fixtures: scheduled, finished, postponed, AET, shootout, missing time,
   unavailable details and a corrected incident. Verify pagination and headers.
2. Recover retained source IDs, quarantine duplicate team bindings and ship the
   binding/reconciliation dry-run and request-cost preview. Trial one
   enabled season with no writes; confirm identities and score semantics.
3. Ship fixture/final-result synchronization, status/read changes and operational
   freshness reporting. Verify the 30-minute target with a controlled clock.
4. Ship post-final lineups/incidents, appearances/substitutions, ownership-aware
   corrections and the settling policy. Enable one season before expanding.

The operator view must show last result/detail success, oldest overdue item,
next due time/reason, active attempt, actual requests/payload bytes, 304 and
unchanged ratios, retry/cooldown state, changed domain rows, pending mappings
and conflicts. Worker readiness alone is not evidence of fresh data.

Acceptance includes exact recovery of retained player/game IDs; two seasons
sharing a provider stage ID and one phase with multiple source stage IDs;
redirect-hop budget accounting and canonical URL reuse; duplicate team quarantine; B/youth/women identity separation; cross-team player transfers; no
profile requests during matching; concurrent new-player creation; absent versus
null baselines; the custom fetcher status/header/raw-body protocol; and duplicate
ticks/workers/manual refresh coalescing; idle
zero-request ticks; restart without a full sweep; round/page identity; old-round
postponements and moved fixtures; 429 cooldown; 403 pause; out-of-order responses;
304 and semantic no-ops producing zero domain writes; malformed JSON retained
without repeated GETs; crash replay without re-fetch; final-result application independent of detail failure; missing versus
empty details; AET/shootout and 120-minute appearances; unchanged-summary detail
corrections; provider-only retractions; manual-edit protection; preserved slugs;
and installation against the retained imported database.

No updater, recurring automation or data mutation is introduced by this design.
