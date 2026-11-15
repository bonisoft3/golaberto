# SofaScore synchronization

GolAberto imports fixtures and completed results, then lineups, goals,
substitutions and appearances, from SofaScore. Each resource's lifecycle is its
`sofa_resource` Mecha reducer, and the provider's standing its `sofa_provider`
reducer: when a resource wake, provider wake, fixture change or budget window fires,
the `sofascore-admission` drain calls `sofa.tick` to admit the resources their
reducers made due as `sofa_request` rows within the provider budget, each request's
machine fetches through the `sofascore` bridge, and the commit that records the answer
parses it with the `sofascore_normalize` and `sofascore_reconcile` functions, applies
it and tells the resource's reducer what it learned ([[decisions/2026-10-28-crawling]]).
Provider requests go only through the custom Rust transport ([[../tools/sofascore-fetch/README]]).

Enable individual championships after confirming their tournament, season, phase
and team bindings. The source identity and detail cutoff survive restarts and
re-enablement. Live scores are never recorded as final results. The Italy pilot
verified round inventory, round summaries, lineups and incidents through the Rust
transport and imported new completed matches. Verify other competitions' stage
and incident contracts before enabling them; successful access alone does not
establish the 30-minute freshness target under provider delays.

## Where it runs

`sayt launch` and every check run the bridge as its simulator
(`simulators/sofascore`): a fictional league clocked against now, plus the
end-to-end test's scripted cases. Nothing in a local stack reaches SofaScore. No
release target deploys the transport yet, and on Cloudflare the acquire effect
settles failed as not deployed, so live acquisition waits for a release that
lowers the bridge.

Every command below runs SQL through the database's private connection as the
service or superuser role; none of them makes a provider request, and public page
visits make none either.

```sh
psql "$DATABASE_URL" -X -c 'SELECT * FROM sofa.status'
psql "$DATABASE_URL" -X -c "SELECT r.family, r.resource_key, i.state->>'phase' AS phase,
  to_timestamp((i.state->>'due')::bigint/1000.0) AS due, i.state->>'failures' AS failures, r.last_error
  FROM sofa.resource r JOIN hybrid_sofa_resource.instance i ON i.id=r.id ORDER BY r.priority, i.state->>'due'"
psql "$DATABASE_URL" -X -c 'SELECT sofa.provider()'
```

`sofa.status` reports enabled sources, last success, overdue resources, request
counts, retained response bytes and unresolved reviews. A malformed response or a
mismatched provider season fails only its request's commit: Airlock keeps the
answer, the request stays acquiring, and `sofa.tick` sends a request that
never answers to review after 30 minutes. Other resources continue. Once the
parser or mapping is fixed, the redelivered answer applies without another GET.

## Recover identities locally

The original provider IDs are recovered before fetching matches. This does not
reimport the archive or change football records:

```sh
python3 tools/sofascore/identities.py export > identities-export.json
python3 tools/sofascore/identities.py recover identities-export.json > identities-plan.json
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v plan="$(cat identities-plan.json)" \
  -c "SELECT sofa.recover_bindings(:'plan'::jsonb)"
```

Keep exports outside the repository. Export reads MySQL `Golaberto_development`
through `mysql -u root` and retained PostgreSQL `legacy` staging. The export
accepts `--mysql-database` and a JSON `--psql-command` argument vector when the
clients need a different local database or PostgreSQL connection.

Teams, players and games retain their existing UUIDs. A positive numeric provider
ID is a separate identity, never an input to the legacy UUID namespace. Duplicate
IDs, missing targets and conflicting prior bindings are quarantined rather than
resolved by row order or fuzzy names. One operator-confirmed canonical binding
is allowed per provider entity and local entity. The export does not read existing
provider bindings: include them in the reviewed plan input when available.
`sofa.recover_bindings` rechecks conflicts and targets in one transaction and
refuses the whole plan on any. Source and stage configuration proposals in the
plan are review evidence; configure them explicitly with `sofa.enable` and stage
bindings.

Player IDs are global across clubs and seasons. Transfers add memberships, not
players. New IDs with plausible existing name/birth candidates require review.
Creation of clearly new players is disabled unless explicitly enabled for the
source. Lineup payloads supply the required identity fields; individual player
profile and search requests are unnecessary.

## Enable one championship

Obtain the local UUIDs from the existing championship and phase. For the supplied
Italy example, provider tournament 23 / season 95836 uses stage 33:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "SELECT sofa.enable('$SOFA_CHAMPIONSHIP_ID', '$SOFA_PHASE_ID', 23, 95836, '33')"
```

The phase must belong to that championship. Re-enabling with different provider
IDs fails atomically. Pass `create_players => true` only to permit creation when
reconciliation finds no plausible existing player. Fixture dates and kickoff
times always follow SofaScore, including changes to existing values and clearing
a time the provider leaves unconfirmed. Other manual field differences are
reviewed; enrollment does not pretend that the current archive values are
verified provider baselines.

Several provider stage keys may share a local phase, while the same stage ID in
another season belongs to that season's source:

```sh
psql "$DATABASE_URL" -X -c "INSERT INTO sofa.stage_binding(source_id, stage_key, phase_id)
  VALUES ('$SOFA_SOURCE_ID', '$SOFA_STAGE_KEY', '$SOFA_PHASE_ID')"
```

Cup stage keys include the verified round slug/prefix when provided. Inspect the
review evidence for the exact key. A composite key never falls back to a bare
tournament ID. Do not copy another competition's phase rules. Pending cup legs
are matched through their phase and provider round descriptor, rather than
assuming local leg numbers equal provider knockout round numbers.

`sofa.enable`'s `p_scope` selects the source's discovery boundary:

| Scope | Updates |
| --- | --- |
| `competition` | The provider competition and season; newly encountered phases require verified stage bindings. |
| `stages` | Configured provider stages, such as Nations League D groups. Other stages do not affect polling or create reviews. |
| `fixtures` | Existing locally bound fixtures, such as a curated national friendlies archive. Pending fixtures are polled individually. |

The default is `competition`. Known local fixtures remain subject to identity and
phase checks if the provider changes their stage. Fixture scope does not request
a round inventory. A previously paused source's first activation needs a fresh
detail cutoff so existing completed matches do not become a historical backfill.

## Cadence and traffic

A resource's reducer holds its phase (`due`, `acquiring`, `idle`, `backoff`,
`review` or `done`), its next due instant and its counters; the ticker wakes it
into `due` when that instant passes, and an admitted request that never answers
frees it again after 30 minutes. The rules are [[../machines/sofa_resource.js]]
and [[../machines/sofa_provider.js]], held to `tools/sofascore/schedule.py`'s
instants by [[../tests/sofascore-schedule.ts]].

- Round inventory: daily. Initial resources come from existing pending fixtures,
  the current round and, when the provider supplies a current round, later
  rounds. Completed historical rounds without a local pending fixture are skipped.
- Fixtures more than seven days away: weekly; one to seven days away: daily;
  within 24 hours: every four hours, bounded by the known kickoff.
- Potentially active matches: at most every 20 minutes per round. A round response
  serves all its matches. Result summaries take priority over inventory and
  lineup/incident work across all enabled sources.
- Completed rounds: one next-day check, then weekly while the season is active.
  Pending rounds retain their ordinary polling until the championship end plus
  30 days. After that, unresolved rounds receive weekly audits and a deduplicated
  review; terminal rounds stop. Sources are disabled when the period has passed
  and neither stored events nor local games remain unresolved.
- Individual fixture summaries stop after their one next-day terminal check.
- Details: fetched after an eligible new final, then checked once the next day.
  Incomplete details retry at 20 minutes, two hours, one day and seven days, then
  require review. HTTP failures use exponentially increasing delays capped at
  4 hours 16 minutes. Detail resources stop and require review after five HTTP
  failures; summary resources have no retry-count limit. A corrected final
  score atomically reopens both detail resources; an unchanged summary does not.

Already played historical fixtures before enablement never queue detail imports.
A locally pending match starting within six hours before enablement may finish
during the first poll; its eligibility is retained before applying its score.
A broader historical backfill is not started automatically.

The provider ceiling is six HTTP requests per minute (`sofa.control.minute_limit`),
spent when a request is admitted, in priority order: result summaries, then the
inventory, then details. This is a local budget, not a statement of SofaScore's
allowance. Every redirect hop beyond the first request is charged when its answer
lands. A 429 blocks the provider until its Retry-After instant; 401/403 pauses it
until an operator resumes it; while it is not open nothing is admitted. Source cache expiry is respected. Polling cannot promise a 30-minute result
when the provider is delayed, its cache is stale or configured capacity is
insufficient; these conditions are visible in resource errors and overdue work.

Requests are plain GETs; a response's cache lifetime defers its resource's next
admission. Every answer is kept as an observation with its request and sequence,
before parsing, so recovery never refetches, and a late answer to an older
request is kept but never applied. Old minute ticks are removed after seven days.

## Reviews and recovery

Inspect reviews for the enabled source through its private database connection:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v source="$SOFA_SOURCE_ID" <<'SQL'
SELECT r.id, r.kind, r.reason, g.slug AS game_slug, r.evidence
FROM sofa.review r LEFT JOIN game g ON r.kind='game' AND g.id::text=r.external_id
WHERE r.source_id=:'source'::uuid AND NOT r.resolved
ORDER BY r.created_at;
SQL
```

Date and kickoff corrections apply automatically, and the next applied answer
closes reviews limited to those fields. Fixture identity and phase checks
still precede every update. For other field differences, make the verified
correction in the existing game editor and request a fresh check of the resource. Matching
values establish ownership for future updates. Keeping an editor's value preserves
that override. Acknowledge the reviewed item after recording the decision:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v review="$SOFA_REVIEW_ID" <<'SQL'
UPDATE sofa.review SET resolved=true WHERE id=:'review'::uuid RETURNING id, reason;
SQL
```

Confirm an existing entity binding after inspecting the candidates, as a one-item
plan that `sofa.recover_bindings` validates and refuses on conflict:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT sofa.recover_bindings(jsonb_build_object(
  'candidate_bindings', jsonb_build_array(jsonb_build_object('entity_kind', 'player',
    'external_id', '$SOFA_PLAYER_ID', 'local_id', '$SOFA_PLAYER_UUID', 'provenance', 'operator'))))"
```

It supports `team`, `player` and `game`. Team-name suggestions and known
match-side evidence do not silently merge reserve, youth, women or national B
teams.

Ask a resource again from the start, lift a pause or a block, or stop a source:

```sh
psql "$DATABASE_URL" -X -c "SELECT sofa.tell('$SOFA_RESOURCE_ID', 'reopened', '{}')"
psql "$DATABASE_URL" -X -c 'SELECT sofa.resume()'
psql "$DATABASE_URL" -X -c "UPDATE sofa.source SET enabled = false WHERE id = '$SOFA_SOURCE_ID'"
```

A reopened resource still waits for the ticker's wake, the provider's standing
and the minute's budget. A repeated GET after a lost answer is harmless: the newer answer
is the one applied.

Incomplete or unresolved details never authorize deletion. Complete collections
remove only unchanged provider-owned records. Existing appearances are matched
by game/player; unowned incident collections are reviewed to prevent duplicates.
Dates and kickoff times follow the provider automatically. Provider/local/baseline
comparisons preserve editor changes to other fields. A conflicting round or status
is held for review while an independent pristine final score can still be applied.
Only accepted fields enter the baseline. A conflict in any
score field holds the complete result tuple and its detail work for review. Scores
are committed independently of delayed lineup details. Local extra-time values are goal
increments; penalty shootouts remain separate. Substitutions and goals retain
period, added time and order, and extra-time appearances use an explicit end.

## Implementation boundaries

[[../tools/sofascore-fetch/README]] describes the transport's HTTP and JSON-lines
protocols, and the `sofascore-fetch` check runs its tests. Each resource's and the
provider's lifecycle are the reducers in [[../program_sofascore_schedule.cue]];
admission, the budget, receipt and identity recovery are SQL in
[[../services/database/sql/059_sofascore_requests.sql]]; normalization and
reconciliation are the Jessie functions in [[../rules/sofascore/normalize.js]]
and [[../rules/sofascore/reconcile.js]], held to the Python reference
implementations in `tools/sofascore` by recorded parity fixtures.
[[../program_sofascore.cue]] declares the request machine, the bridge and its
simulator, the effect, the event-driven admission drain and the upgrades. The additive SQL sources
install the schedule, guarded domain writes and fixture-availability projections
on retained volumes; fresh generated SQL alone is insufficient for an imported
database.

Only changed typed football fields are written. Request timestamps and source
snapshots stay outside computation inputs. An unchanged legacy final is not
rewritten merely to label its equivalent finished status. Actual result changes
use existing CDC and may invalidate the current odds planner broadly.
