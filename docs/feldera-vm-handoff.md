# Golaberto offline bootstrap and bounded DuckDB handover

Status: completed on 2026-11-10. The prepared-state boundary (`compute.source` and `compute.capture.completed_coverage`) is implemented and verified, all five GolAberto computations (`golaberto-standings`, `golaberto-ratings`, `golaberto-game-cards`, `golaberto-player-stats`, `golaberto-chances`) are published and sealed into `golaberto-prepared.dump`, the GCP VM (`golaberto`, `us-central1-a`) boots cleanly with zero historical bootstrap work, and the full 42-journey Tier 2 browser suite (including live mutation `0 -> 1` and rollback `1 -> 0` without reload) passed against the VM.

## Completed verification and artifacts

Worktree `/Users/davi/code/trash/.worktrees/duckstream`, branch `release/golaberto-live-verification`, PR https://github.com/worldsense/trash/pull/2325. Preserve [[release-handoff]].

1. **Prepared-state boundary (`libraries/mecha/services/compute/batches.sql`, `batches.ts`)**:
   - Tracks source and sink table revisions in `compute.source` via statement-level transition-table triggers (`compute.touch_source_rows` / `compute.touch_source`) so 0-row cascading deletes do not false-invalidate downstream computations.
   - `compute.reconcile` verifies `completed_coverage` (`version`, `digest`, `reads`, `parents`, `to`) on startup and preserves verified prepared state without re-running historical bootstrap while invalidating on version, source, sink, or unverified changes.
   - `spec.capture` runs before acquiring `compute.lock_batches()` in `finishClaim`, preventing external DuckDB snapshot captures from holding coordinator batch locks across multi-second reads.
2. **Bounded DuckDB runtime and GolAberto computation fixes**:
   - `libraries/mecha/services/compute/bounded-runtime.ts`: sets `preserve_insertion_order=false` and `temp_directory` per DuckDB database, checkpoints periodically during step execution, detaches `captured` before final publication materialization, deduplicates sink keys by `seq` before sorting `value` with streaming `row_number() OVER ()` to stay within the 512 MiB DuckDB heap budget on 637,940-row `team_game` publications.
   - `apps/golaberto/duckstream/bounded-projection.ts`: bounds per-step range scans (`sequence > after AND sequence <= after + 1024`) to use direct rowid range lookups instead of full-table top-N sorts.
   - `apps/golaberto/duckstream/bounded-chances.ts`: preserves typed relation inputs (`chances_groups`, `chances_members`, `chances_games`, `chances_zones`) via `from_json_strict`, batches consecutive `live = false` groups, and avoids redundant second-page queries when `page.length < 4096 && pageSize < 524288`.
3. **Prepared archive export (`/Users/davi/code/golaberto-data/native-fresh-2026-11-09` and `/mnt/disks/golaberto/import`)**:
   - `golaberto-prepared.dump`: `413,657,206` bytes, SHA-256 `5d21f65c3c40e3ca5d1027aaee3564921102788c4f5a66592a5bd8a37b8a087b`.
   - `manifest.json`: records all five completed batch versions and coverage digests, 23 `compute.source` revisions, `compute.job_cache_size` (`3,272` entries, `431,023,775` bytes), sink counts (`standing`: `58,440`, `team_rating`: `1,424,044`, `player_rating`: `41,155`, `rating_eval`: `3,931`, `team_chance`: `58,440`, `position_chance`: `988,850`, `zone_chance`: `81,522`, `game_importance`: `5,419`, `game_card`: `318,970`, `team_game`: `637,940`, `player_stat`: `302,234`), and projection counts (`team_odds_history`: `3,146,388`, `team_odds_chart`: `81,522`, `team_rating_chart`: `20,556`, `team_roster_total`: `9,870`, `team_roster`: `305,441`, `team_player_history`: `155,533`, `team_directory`: `3,426`, `matches_game_card`: `80`, `home_championship`: `21`).
   - Deployed image:
     ```text
     us-central1-docker.pkg.dev/trash-362115/pronto/golaberto@sha256:e8b2298a48dfdcd6295081ea56beae0ee1632f227675a6f41aba1f8f38e6e379
     ```
4. **VM verification (`golaberto` in `trash-362115`, `us-central1-a`)**:
   - Container boots with all five computations in `idle` (`requested = completed`, `gw_jobs = 0`) and zero bootstrap work.
   - Tier 2 browser verification (`verify.ts`) passed all 42 user journeys across 41 screens (`658,567 ms`), observing live standings mutation (`goals 0 -> 1`) and disposable competition removal/restoration (`1 -> 0`) through Electric without reload, with zero HTTP or transport errors.
   - All temporary verification fixtures and editor grants were removed and the pristine prepared coordinator state and job cache were restored before downsizing the VM back to `e2-medium`.

## VM access and operation

GCP project `trash-362115`, VM `golaberto`, zone `us-central1-a`, machine type `e2-medium`. Container `golaberto` runs `/mnt/disks/golaberto/config/run-bounded.sh` with 3 GiB memory/swap and 256 MiB shm, preserving `golaberto-postgres`, `golaberto-caddy` and `golaberto-duckstream` on `/mnt/disks/golaberto` (`golaberto-data`).

Inspect coordinator state with:

```sh
docker exec golaberto psql -h 127.0.0.1 -p 5432 -U postgres -d golaberto -c 'SELECT name,requested,completed,claimed FROM compute.batch ORDER BY name'
```

 The runtime contract is [[../../../libraries/mecha/docs/compute]] and deployment requirements are [[../../../plugins/pronto/docs/release-targets]].
