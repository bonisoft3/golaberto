# Route performance audit

All fourteen declared route patterns are covered by the disposable-stack acceptance check. The thirteen public patterns below were also measured on the retained full local archive on 2026-10-02. Each used a new browser context at https://localhost:8443, a populated content selector, and the visible screen. The editor is covered with an authorized session in the disposable stack; no editor identity was added to the retained archive.

These are single-run local observations, not a latency SLA. This final public-route audit used the confirmed disabled compute configuration. Separate dense-history timings below were captured before that configuration change. HTTP row counts and collection residency measure different paths: bounded server results need not become resident collection rows.

| Route | Visible load | Resident rows | Largest HTTP response |
| --- | ---: | ---: | ---: |
| `/en/` | 1.10 s | 40 | 16 |
| `/en/championships` | 0.42 s | 1 | 40 |
| `/en/matches` | 0.42 s | 81 | 40 |
| `/en/match/:id` | 1.44 s | 4 | 0 |
| `/en/chances/:id` | 0.88 s | 19 | 3 |
| `/en/teams` | 0.33 s | 3 | 40 |
| `/en/stadiums` | 0.28 s | 3 | 40 |
| `/en/stadium/:id` | 0.88 s | 3 | 40 |
| `/en/referees` | 0.25 s | 3 | 40 |
| `/en/referee/:id` | 0.28 s | 1 | 2 |
| `/en/team/:id` | 0.32 s | 1 | 40 |
| `/en/player/:id` | 0.89 s | 11 | 3 |
| `/en/championship/:id` | 0.85 s | 111 | 8 |

## Largest populated histories

A second fresh-context audit selected the largest histories by row count. All five rendered successfully on the final adapter build. A match retains both complete lineups; other long lists remain capped.

| Route | History rows in database | Visible load | Largest HTTP response |
| --- | ---: | ---: | ---: |
| `/en/match/:id` | 35 | 2.96 s | 18 |
| `/en/stadium/:id` | 786 | 0.89 s | 40 |
| `/en/referee/:id` | 128 | 0.45 s | 40 |
| `/en/team/:id` | 3497 | 0.88 s | 40 |
| `/en/player/:id` | 564 | 1.38 s | 40 |

## Cause and changes

Archive routes previously synchronized whole tables before displaying filtered lists. The database contains 318,968 games, 3,285,548 appearances and 8,181,985 historical team ratings. Earlier fresh-load probes exceeded eight seconds for game, player, team, stadium, referee and chances views; directory snapshots included all 1,514 championships, 3,425 teams and 1,108 stadiums.

Public archive entities now opt into query-scoped synchronization. Exact UUID reads retain live subsets; portable SQL domain comparisons and ordered pages use bounded PostgREST queries plus changes-only invalidation. Base and joined live streams establish their baselines before the server snapshot. Readiness follows the actual transport checkpoint for each sync generation, so a repeated cursor after idle cache cleanup cannot stall a revisit; an expired-token response cannot falsely mark the stream ready. Uncached deletions and rows renamed out of a filter trigger a refresh without loading archive history.

Catalogs, appearances, seasons, squads, venue/referee history and comments use forty-row pages with a one-row next-page probe. Search resets the page. Previous/Next preserve access to the full archive. The editor searches bounded stadium/referee choices and preserves selected values outside the first forty results. Mutation reads hydrate the complete filtered target set before writing.

Migration 018 adds seventeen ordered indexes, including separate upcoming/result team history indexes. The existing latest-team-rating index is reused. The additive pgroll migration was applied to the retained volume with archive writers paused briefly; both writers were restored. No archive reseed occurred.

A separate VM-wide problem caused intermittent hangs even after the route reads were bounded. The ratings planner materialized overlapping archive requests for every phase at once, while DuckDB used its default VM-sized buffer budget. Kernel logs confirmed repeated out-of-memory deaths in compute and transform. After compute stopped, the homepage HTML returned in 51 ms; the transform restart count remained stable at ten. The user confirmed that the default local launch should keep compute disabled. Its generated Compose scale is zero and there is no running main compute container. Fixtures, results and standings still update through the event pipelines; local edits do not recalculate stored ratings, odds or importance.

The retained compute implementation now yields one job at a time, preserves legacy array planners and ordered results, and limits each DuckDB instance to 512 MiB with two threads and disk spill. Historical ratings are not truncated. Full-archive compute completion and total process memory have not been verified, because the worker remains disabled as requested. The disposable acceptance stack enables compute only for its fixture suite and stops it afterward.

The real local browser-back check left the catalogue for 6.5 seconds, exceeding the adapter's idle cleanup interval. Returning to `/en/championships` then completed a fresh forty-row request in 32 ms.

## Pronto evidence

- Canonical ownership: program.cue, screens.cue, ir.html and SQL source declarations; generated artifacts rebuilt through Sayt.
- Design oracle: existing accepted tokens and columns, refined with Stitch project 3684321283098058780 / screen 96ba2b88581c4126b2122176d47721b5. Accepted only the compact responsive Previous/Page/Next footer.
- Model routes: architecture and backend review used Astra high; index implementation used Luna high; frontend and QA review used Luna medium. Lead retained the cross-layer canonical changes.
- Review findings resolved: uncached live invalidation, changes-only baseline gap, and missing-collection readiness. The browser-back probe was corrected to inspect the visible screen instead of hidden cached screens, including fixing a premature return in that test. Frontend review had no actionable findings.
- Focused evidence: real adapter 9 tests, store/validation 42 tests, auth 3 tests, Pronto emitter 2 tests, visual helper 2 tests/10 steps, and SQL ordered plans. Compute host/cage: 31 passed, 11 PostgreSQL tests skipped because host `initdb` is unavailable; application computation fixtures and native/WASM oracles: 29 passed.
- Sayt doctor, build, generate, lint and test exited 0. The full integration run passed visual (zero critical findings, 504 advisory), all 51 browser cases, archive refresh (3), constraints (29), homepage/upgrade (17), archive images, favicon and normalized-country checks. It exited 1 at an outdated matches projection assertion comparing retired flag columns. Both homepage and matches parity assertions now compare the active projection columns.
- Final scoped integration used Sayt's loaded canonical configuration and rule executor for the four owning/remaining rules: matches-games (10 passed), replay (no findings), route-loads (all 14 patterns, paging/search/back, 1 passed in 12 seconds), and route-queries (ordered indexes without a sort, 1 passed). That final run exited 0. A further whole-suite run was not repeated after assertion-only fixes.
- One simplification pass found no useful additional change to the handwritten diff. Pagination helpers and typed fallback boundaries keep the canonical sources consistent without another abstraction.

No design decision remains pending. Changes and local rollout remain local; no push or pull request was created.
