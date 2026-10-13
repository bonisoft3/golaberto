// The drains run on change, never on an interval: an edit reaches its
// projection by its own change event, a stack nobody writes to calls none of
// them, and the two that share team rows take turns rather than deadlock. Each
// edit is committed, since only a commit reaches the change feed, and restored
// in finally.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { query } from "./db.ts";

const drains = [
  "refresh_team_enrichment", "refresh_team_profiles", "refresh_team_directory",
  "refresh_matches_games", "refresh_recent_championships",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(sql: string, seconds: number) {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(250)) {
    if (await query(sql) === "t") return;
  }
  throw new Error(`not within ${seconds}s: ${sql}`);
}

Deno.test("an idle stack calls no drain", async () => {
  const calls = async () => Number(await query(`SELECT coalesce(sum(calls), 0) FROM pg_stat_user_functions
    WHERE funcname = ANY('{${drains.join(",")}}')`));
  // A day tick inside the window would be a call owed: UTC midnight and
  // Brasília's, which is 03:00 UTC.
  const clear = () => {
    const hour = 3_600_000, sinceHour = Date.now() % hour, h = new Date().getUTCHours();
    const nearTick = (h === 23 || h === 2) && hour - sinceHour < 90_000;
    return nearTick ? sleep(hour - sinceHour + 5_000) : Promise.resolve();
  };
  await query("ALTER SYSTEM SET track_functions = 'pl'");
  await query("SELECT pg_reload_conf()");
  try {
    // Quiet first: the stack's start, and the checks before this one, are still
    // owed their calls, a card stream's recount waking matches-games once a
    // second. A backend reports its counts within ten seconds of going idle.
    await clear();
    let last = await calls();
    for (let steady = 0, waited = 0; steady < 4; steady++, waited++) {
      assert(waited < 72, "the drains did not settle within six minutes");
      await sleep(5_000);
      const now = await calls();
      if (now !== last) [last, steady] = [now, -1];
    }
    await clear();
    const before = await calls();
    await sleep(60_000);
    assertEquals(await calls(), before);
  } finally {
    await query("ALTER SYSTEM RESET track_functions");
    await query("SELECT pg_reload_conf()");
  }
});

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

// Profiles rewrite team_roster, whose triggers queue roster totals, while
// enrichment drains that queue: before they took turns, a boot or a rebuild
// like this one deadlocked about one round in three.
Deno.test("rebuilding every roster while both team drains run deadlocks neither", async () => {
  const deadlocks = async () => Number(await query("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()"));
  const settled = async () => {
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(500)) {
      if (await query(`SELECT NOT EXISTS (SELECT 1 FROM team_profile_dirty) AND NOT EXISTS (SELECT 1 FROM team_roster_total_dirty)`) === "t") return;
    }
    throw new Error("the team queues did not drain within two minutes");
  };
  const rosters = await query("SELECT count(*) FROM team_roster");
  await settled();
  const before = await deadlocks();
  for (let round = 0; round < 6; round++) {
    await query("BEGIN; DELETE FROM team_roster; SELECT count(enqueue_team_profile(id)) FROM team; COMMIT;");
    await settled();
  }
  assertEquals(await query("SELECT count(*) FROM team_roster"), rosters);
  assertEquals(await deadlocks(), before);
});
