// Destructive fixture preparation is confined to an explicit disposable stack;
// each test rolls back its source cards, projection and all trigger writes.
import { assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME");
if (!project || !/(?:check|test|prs)/.test(project) || project === "golaberto") {
  throw new Error("matches-games requires a disposable COMPOSE_PROJECT_NAME containing check or test");
}
const command = ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1"];
const setup = `
  CREATE TEMP TABLE fixture AS SELECT id, row_number() OVER (ORDER BY id)::int AS n
    FROM game_card ORDER BY id LIMIT 120;
  DO $$ BEGIN IF (SELECT count(*) FROM fixture)<>120 THEN RAISE EXCEPTION 'requires at least 120 seeded cards'; END IF; END $$;
  UPDATE game_card SET played=false, kickoff=NULL, home_upcoming_rank=0,
    home_recent_rank=0, home_upcoming_group=false, home_recent_group=false;
  DELETE FROM matches_game_card;
  UPDATE game_card g SET played=f.n>60, day='2026-10-02',
    kickoff='2026-10-02 12:00:00+00'::timestamptz + interval '1 minute' *
      CASE WHEN f.n<=60 THEN f.n ELSE -f.n END
    FROM fixture f WHERE f.id=g.id;
`;
const refresh = "DO $$ BEGIN PERFORM refresh_matches_games(); END $$;";
const parity = `
  WITH expected AS (
    (SELECT id FROM game_card WHERE NOT played AND kickoff IS NOT NULL ORDER BY kickoff ASC NULLS LAST,id ASC LIMIT 40)
    UNION ALL
    (SELECT id FROM game_card WHERE played ORDER BY day DESC NULLS FIRST,kickoff DESC NULLS FIRST,id ASC LIMIT 40)
  ) SELECT json_build_object(
    'upcoming',(SELECT count(*) FROM matches_game_card WHERE NOT played),
    'results',(SELECT count(*) FROM matches_game_card WHERE played),
    'missing',(SELECT count(*) FROM (SELECT id FROM expected EXCEPT SELECT id FROM matches_game_card) missing),
    'extra',(SELECT count(*) FROM (SELECT id FROM matches_game_card EXCEPT SELECT id FROM expected) extra));
`;
const full = { upcoming: 40, results: 40, missing: 0, extra: 0 };
async function query(sql: string) {
  const out = await new Deno.Command("docker", {
    args: [...command, "-Atqc", `BEGIN; SET LOCAL statement_timeout='30s'; ${setup} ${sql} ROLLBACK;`],
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

Deno.test("matches membership equals both original forty-row selectors, including historical fixtures", async () => {
  assertEquals(await query(`
    UPDATE game_card SET kickoff='1900-01-01 12:00:00+00' WHERE id=(SELECT id FROM fixture WHERE n=60);
    ${refresh} ${parity}
  `), full);
});

Deno.test("results retain unknown times first, day priority and deterministic ID ties", async () => {
  assertEquals(await query(`
    UPDATE game_card SET kickoff='2026-10-02 12:00:00+00';
    UPDATE game_card SET kickoff=NULL WHERE id IN (SELECT id FROM fixture WHERE n>110);
    UPDATE game_card SET day='2026-10-03' WHERE id=(SELECT id FROM fixture WHERE n=110);
    ${refresh}
    SELECT json_build_object(
      'firstResult',(SELECT f.n FROM matches_game_card m JOIN fixture f USING(id) WHERE m.played ORDER BY day DESC,kickoff DESC,id LIMIT 1),
      'unknown',(SELECT count(*) FROM matches_game_card WHERE played AND kickoff IS NULL),
      'tiedFixtures',(SELECT json_agg(f.n ORDER BY f.n) FROM matches_game_card m JOIN fixture f USING(id) WHERE NOT m.played));
  `), { firstResult: 110, unknown: 10, tiedFixtures: Array.from({ length: 40 }, (_, i) => i + 1) });
});

Deno.test("clock replay does not rewrite the projection or source archive", async () => {
  assertEquals(await query(`
    ${refresh}
    CREATE TEMP TABLE source_version AS SELECT id,ctid::text AS version FROM game_card;
    CREATE TEMP TABLE feed_version AS SELECT id,ctid::text AS version FROM matches_game_card;
    ${refresh}
    SELECT json_build_object(
      'sourceWrites',(SELECT count(*) FROM game_card g JOIN source_version v USING(id) WHERE g.ctid::text<>v.version),
      'feedWrites',(SELECT count(*) FROM matches_game_card m JOIN feed_version v USING(id) WHERE m.ctid::text<>v.version),
      'mismatch',(SELECT count(*) FROM matches_game_card m JOIN game_card g USING(id)
        WHERE (to_jsonb(m)-ARRAY['txid', 'show_country', 'home_country', 'away_country'])
          IS DISTINCT FROM (to_jsonb(g)-ARRAY['txid', 'show_country', 'home_country', 'away_country'])));
  `), { sourceWrites: 0, feedWrites: 0, mismatch: 0 });
});

Deno.test("selected display edits and deletion are immediate and identical edits do not rewrite", async () => {
  assertEquals(await query(`
    ${refresh}
    UPDATE game_card SET home_name='Corrected matches name',attendance=1234 WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM matches_game_card WHERE home_name='Corrected matches name' AND attendance=1234)
      THEN RAISE EXCEPTION 'display edit not copied'; END IF; END $$;
    CREATE TEMP TABLE feed_version AS SELECT id,ctid::text AS version FROM matches_game_card;
    UPDATE game_card SET home_name=home_name WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM matches_game_card m JOIN feed_version v USING(id) WHERE m.ctid::text<>v.version)
      THEN RAISE EXCEPTION 'no-op edit copied'; END IF; END $$;
    DELETE FROM game_card WHERE id=(SELECT id FROM fixture WHERE n=1);
    SELECT json_build_object('rows',count(*),'deleted',count(*) FILTER(WHERE id=(SELECT id FROM fixture WHERE n=1))) FROM matches_game_card;
  `), { rows: 79, deleted: 0 });
});

Deno.test("played transitions preserve each cap immediately and refill with exact membership on refresh", async () => {
  assertEquals(await query(`
    ${refresh}
    UPDATE game_card SET played=true WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF (SELECT count(*) FROM matches_game_card WHERE played)<>40
      OR (SELECT count(*) FROM matches_game_card WHERE NOT played)<>39
      THEN RAISE EXCEPTION 'feed switch exceeded cap or left stale fixture'; END IF; END $$;
    ${refresh}
    UPDATE game_card SET played=false WHERE id=(SELECT id FROM fixture WHERE n=61);
    ${refresh} ${parity}
  `), full);
});

Deno.test("unknown fixture times disappear immediately and new candidates wait for the clock", async () => {
  assertEquals(await query(`
    ${refresh}
    UPDATE game_card SET kickoff=NULL WHERE id=(SELECT id FROM fixture WHERE n=1);
    UPDATE game_card SET kickoff='1800-01-01 00:00:00+00' WHERE id=(SELECT id FROM fixture WHERE n=60);
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM matches_game_card WHERE id IN (SELECT id FROM fixture WHERE n IN (1,60)))
      THEN RAISE EXCEPTION 'membership changed outside selected IDs'; END IF; END $$;
    ${refresh} ${parity}
  `), full);
});

Deno.test("matches projection is public to scoped readers with service-only writes and functions", async () => {
  assertEquals(await query(`
    SET LOCAL ROLE service; ${refresh} RESET ROLE;
    SET LOCAL app.scopes='public:'; SET LOCAL ROLE app_user;
    DO $$ DECLARE changed integer; BEGIN
      IF (SELECT count(*) FROM matches_game_card)<>80 THEN RAISE EXCEPTION 'reader cannot read feed'; END IF;
      DELETE FROM matches_game_card; GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>0 THEN RAISE EXCEPTION 'reader deleted cards'; END IF;
      UPDATE matches_game_card SET home_name='Forbidden'; GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>0 THEN RAISE EXCEPTION 'reader updated cards'; END IF;
    END $$;
    RESET ROLE;
    SELECT json_build_object('rows',(SELECT count(*) FROM matches_game_card),
      'anonRefresh',has_function_privilege('anon','refresh_matches_games()','EXECUTE'),
      'readerRefresh',has_function_privilege('app_user','refresh_matches_games()','EXECUTE'),
      'readerCopy',has_function_privilege('app_user','copy_matches_game_cards(uuid[])','EXECUTE'),
      'serviceRefresh',has_function_privilege('service','refresh_matches_games()','EXECUTE'));
  `), { rows: 80, anonRefresh: false, readerRefresh: false, readerCopy: false, serviceRefresh: true });
});

Deno.test("projection retains source types and generated columns and only joins Electric publication", async () => {
  assertEquals(await query(`
    SELECT json_build_object(
      'mismatchedTypes',(SELECT count(*) FROM pg_attribute m JOIN pg_attribute g ON g.attrelid='game_card'::regclass AND g.attname=m.attname
        WHERE m.attrelid='matches_game_card'::regclass AND m.attnum>0 AND NOT m.attisdropped AND (m.atttypid,m.attgenerated,m.attnotnull) IS DISTINCT FROM (g.atttypid,g.attgenerated,g.attnotnull)),
      'electric',(SELECT count(*) FROM pg_publication_tables WHERE pubname='electric_publication_default' AND tablename='matches_game_card'),
      'cdc',(SELECT count(*) FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND tablename='matches_game_card'),
      'timeouts',(SELECT ARRAY['statement_timeout=20s','lock_timeout=2s']<@proconfig FROM pg_proc WHERE oid='refresh_matches_games()'::regprocedure));
  `), { mismatchedTypes: 0, electric: 1, cdc: 0, timeouts: true });
});

Deno.test("selection can seek both ordered partial indexes without sorting the archive", async () => {
  assertEquals(await query(`
    SET LOCAL enable_seqscan=off;
    DO $$ DECLARE plan json; BEGIN
      EXECUTE 'EXPLAIN (FORMAT JSON) SELECT id FROM game_card WHERE NOT played AND kickoff IS NOT NULL ORDER BY kickoff ASC NULLS LAST,id ASC LIMIT 40' INTO plan;
      IF plan::text NOT LIKE '%game_card_matches_upcoming_idx%' OR plan::text LIKE '%"Node Type": "Sort"%'
        THEN RAISE EXCEPTION 'upcoming selector cannot seek its index: %',plan; END IF;
      EXECUTE 'EXPLAIN (FORMAT JSON) SELECT id FROM game_card WHERE played ORDER BY day DESC NULLS FIRST,kickoff DESC NULLS FIRST,id ASC LIMIT 40' INTO plan;
      IF plan::text NOT LIKE '%game_card_matches_results_idx%' OR plan::text LIKE '%"Node Type": "Sort"%'
        THEN RAISE EXCEPTION 'result selector cannot seek its index: %',plan; END IF;
    END $$;
    SELECT to_json(true);
  `), true);
});

Deno.test("overlapping refresh skips work while the first transaction holds the lock", async () => {
  const holder = new Deno.Command("docker", { args: [...command, "-Atq"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = holder.stdin.getWriter();
  const reader = holder.stdout.getReader();
  const errors = new Response(holder.stderr).text();
  try {
    await writer.write(new TextEncoder().encode("BEGIN;\nSELECT pg_advisory_xact_lock(715016,1);\nSELECT 'lock-ready';\n"));
    let output = "";
    while (!output.includes("lock-ready")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`lock holder stopped: ${await errors}`);
      output += new TextDecoder().decode(chunk.value);
    }
    assertEquals(await query(`${refresh} SELECT json_build_object('rows',count(*)) FROM matches_game_card;`), { rows: 0 });
  } finally {
    await writer.write(new TextEncoder().encode("ROLLBACK;\n"));
    await writer.close();
    await reader.cancel();
    const status = await holder.status;
    if (!status.success) throw new Error(await errors);
    await errors;
  }
});
