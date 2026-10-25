// Edits commit to reach CDC; projection and lock-state assertions bound
// failures by a deadline, never establish success by elapsed time.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { query } from "./db.ts";
import postgres from "npm:postgres@3.4.9";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(sql: string, seconds: number) {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(250)) {
    if (await query(sql) === "t") return;
  }
  throw new Error(`not within ${seconds}s: ${sql}`);
}

Deno.test("a team's edit reaches the directory through the change feed", async () => {
  const [id, city] = (await query("SELECT id, city FROM team WHERE coalesce(city, '') <> '' ORDER BY id LIMIT 1")).split("|");
  assert(id, "the seed has a team with a city");
  try {
    await query(`UPDATE team SET city = 'Drained City' WHERE id = '${id}'`);
    await eventually(`SELECT city = 'Drained City' FROM team_directory WHERE id = '${id}'`, 30);
  } finally {
    await query(`UPDATE team SET city = $c$${city}$c$ WHERE id = '${id}'`);
  }
});

// The renames queue every member team, more of them than one call's batch:
// the drain wakes itself on its own deletes until the queue is empty.
Deno.test("championships' renames drain every member's profile", async () => {
  const renamed = (await query(`SELECT id, name FROM (SELECT c.id, c.name,
      sum(count(*)) OVER (ORDER BY count(*) DESC, c.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
    FROM team_championship tc JOIN championship c ON c.id = tc.championship_id GROUP BY c.id) members
    WHERE coalesce(before, 0) <= 50`)).split("\n").map((row) => row.split("|"));
  const ids = renamed.map(([id]) => `'${id}'`).join(",");
  assert(Number(await query(`SELECT count(*) FROM team_championship WHERE championship_id IN (${ids})`)) > 50);
  try {
    await query(`UPDATE championship SET name = 'Drained ' || name WHERE id IN (${ids})`);
    await eventually(`SELECT bool_and(tc.championship_name = c.full_name) FROM team_championship tc
      JOIN championship c ON c.id = tc.championship_id WHERE c.id IN (${ids})`, 60);
  } finally {
    for (const [id, name] of renamed) await query(`UPDATE championship SET name = $n$${name}$n$ WHERE id = '${id}'`);
  }
});

// Holding the common lock makes the formerly conflicting calls overlap
// deterministically, even when both dirty queues are empty.
Deno.test("both team drains wait for the same transaction lock before writing", async () => {
  const connect = () => postgres(Deno.env.get("DATABASE_URL")!, { max: 1, fetch_types: false });
  const holder = connect();
  const profiles = connect();
  const enrichment = connect();
  let holding = false;
  const pending: Promise<unknown>[] = [];
  try {
    const [{ pid: profilePid }] = await profiles`SELECT pg_backend_pid() AS pid`;
    const [{ pid: enrichmentPid }] = await enrichment`SELECT pg_backend_pid() AS pid`;
    await holder`BEGIN`;
    holding = true;
    await holder`SELECT pg_advisory_xact_lock(715030, 1)`;
    // Attach rejection handlers immediately; all results are asserted below.
    pending.push(profiles`SELECT refresh_team_profiles()`.execute());
    pending.push(enrichment`SELECT refresh_team_enrichment()`.execute());
    const completed = Promise.allSettled(pending);
    await eventually(`SELECT count(*) = 2 FROM pg_locks
      WHERE pid IN (${profilePid}, ${enrichmentPid}) AND locktype = 'advisory'
        AND classid = 715030 AND objid = 1 AND objsubid = 2 AND NOT granted`, 10);
    assertEquals(await query(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.pid IN (${profilePid}, ${enrichmentPid}) AND n.nspname = 'public'
        AND l.mode IN ('RowExclusiveLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`), "0");
    await holder`COMMIT`;
    holding = false;
    for (const result of await completed) {
      if (result.status === "rejected") throw result.reason;
    }
  } finally {
    if (holding) await holder`ROLLBACK`;
    await Promise.allSettled(pending);
    await Promise.all([holder.end(), profiles.end(), enrichment.end()]);
  }
});

Deno.test("rebuilding every roster drains both team queues", async () => {
  const settled = () => eventually(`SELECT NOT EXISTS (SELECT 1 FROM team_profile_dirty)
    AND NOT EXISTS (SELECT 1 FROM team_roster_total_dirty)`, 120);
  await settled();
  const rosters = await query("SELECT count(*) FROM team_roster");
  await query("BEGIN; DELETE FROM team_roster; SELECT count(enqueue_team_profile(id)) FROM team; COMMIT;");
  await settled();
  assertEquals(await query("SELECT count(*) FROM team_roster"), rosters);
});

Deno.test("championship writers take the projection turn before locking source rows", async () => {
  const connect = () => postgres(Deno.env.get("DATABASE_URL")!, { max: 1, fetch_types: false });
  const holder = connect();
  const writer = connect();
  let held = false;
  let writing = false;
  let pending: Promise<unknown> | undefined;
  try {
    const [{ id }] = await holder`SELECT id FROM championship ORDER BY id LIMIT 1`;
    assert(id, "the seed has a championship");
    const [{ pid }] = await writer`SELECT pg_backend_pid() AS pid`;
    await holder`BEGIN`;
    held = true;
    await holder`SELECT pg_advisory_xact_lock(715030, 1)`;
    await writer`BEGIN`;
    writing = true;
    await writer`SET LOCAL lock_timeout = '17s'`;
    pending = writer`UPDATE championship SET name = 'Projection turn ' || name WHERE id = ${id}`.execute();
    const completed = Promise.allSettled([pending]);
    await eventually(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid}
      AND locktype = 'advisory' AND classid = 715030 AND objid = 1 AND objsubid = 2 AND NOT granted)`, 3);
    // A row trigger would acquire this row first and recreate the deadlock.
    await holder`SELECT id FROM championship WHERE id = ${id} FOR UPDATE NOWAIT`;
    await holder`ROLLBACK`;
    held = false;
    const [result] = await completed;
    if (result.status === "rejected") throw result.reason;
    const [{ lock_timeout }] = await writer`SHOW lock_timeout`;
    assertEquals(lock_timeout, "17s");
  } finally {
    if (held) await holder`ROLLBACK`;
    if (pending) await Promise.allSettled([pending]);
    if (writing) await writer`ROLLBACK`;
    await Promise.all([holder.end(), writer.end()]);
  }
});

Deno.test("user deletion takes the projection turn before locking attribution parents", async () => {
  const connect = () => postgres(Deno.env.get("DATABASE_URL")!, { max: 1, fetch_types: false });
  const holder = connect();
  const deleter = connect();
  const user = crypto.randomUUID();
  let held = false;
  let deleting = false;
  let pending: Promise<unknown> | undefined;
  try {
    await holder`INSERT INTO app_user(id, handle) VALUES (${user}, ${`projection-${user}`})`;
    const [{ pid }] = await deleter`SELECT pg_backend_pid() AS pid`;
    await holder`BEGIN`;
    held = true;
    await holder`SELECT pg_advisory_xact_lock(715030, 1)`;
    await deleter`BEGIN`;
    deleting = true;
    pending = deleter`DELETE FROM app_user WHERE id = ${user}`.execute();
    const completed = Promise.allSettled([pending]);
    await eventually(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid}
      AND locktype = 'advisory' AND classid = 715030 AND objid = 1 AND objsubid = 2 AND NOT granted)`, 3);
    // The FK check must acquire its parent lock while deletion waits for the turn.
    await holder`INSERT INTO team(id, name, country, created_by) VALUES (${crypto.randomUUID()}, 'Projection parent', 'Brasil', ${user})`;
    await holder`ROLLBACK`;
    held = false;
    const [result] = await completed;
    if (result.status === "rejected") throw result.reason;
  } finally {
    if (held) await holder`ROLLBACK`;
    if (pending) await Promise.allSettled([pending]);
    if (deleting) await deleter`ROLLBACK`;
    await holder`DELETE FROM app_user WHERE id = ${user}`;
    await Promise.all([holder.end(), deleter.end()]);
  }
});
