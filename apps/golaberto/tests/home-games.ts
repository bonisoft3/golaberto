// Selection runs with a fixed clock; every fixture and write is rolled back.
import { assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
const clock = "'2026-10-02 12:00:00+00'::timestamptz";
const setup = `
  CREATE TEMP TABLE fixture AS SELECT id, row_number() OVER (ORDER BY id)::int AS n
    FROM game_card ORDER BY id LIMIT 30;
  UPDATE game_card SET kickoff = NULL, home_upcoming_rank = 0, home_recent_rank = 0, home_upcoming_group = false, home_recent_group = false;
  DELETE FROM game_importance;
  DELETE FROM team_rating;
  UPDATE game_card g SET home_id = p.home_id, away_id = p.away_id, phase_id = p.phase_id
    FROM (SELECT home_id, away_id, phase_id FROM game_card ORDER BY id LIMIT 1) p;
  INSERT INTO team_rating (id, team_id, measure_date, offense, defense, rating)
    SELECT gen_random_uuid(), team_id, '2026-10-01', 1, 1, 50
    FROM (SELECT home_id AS team_id FROM game_card UNION SELECT away_id FROM game_card) t;
`;

async function query(sql: string) {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", `BEGIN; ${setup} ${sql} ROLLBACK;`],
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

Deno.test("home windows exclude overdue, future results, unknown times and exact seven-day boundaries", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = f.n IN (2, 4, 6, 8), kickoff = CASE f.n
      WHEN 1 THEN ${clock} + interval '1 hour'
      WHEN 2 THEN ${clock} - interval '1 hour'
      WHEN 3 THEN ${clock} - interval '1 hour'
      WHEN 4 THEN ${clock} + interval '1 hour'
      WHEN 5 THEN ${clock} + interval '7 days'
      WHEN 6 THEN ${clock} - interval '7 days'
      WHEN 7 THEN ${clock} WHEN 8 THEN ${clock} END
      FROM fixture f WHERE f.id = g.id;
    SELECT json_agg(f.n ORDER BY f.n) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [1, 2]);
});

Deno.test("importance and daily decay select the strongest twenty rather than the nearest twenty", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false, kickoff = ${clock} + interval '1 hour' * f.n
      FROM fixture f WHERE f.id = g.id;
    INSERT INTO game_importance (id, home, away) SELECT id, 100, 100 FROM fixture WHERE n = 30;
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [...Array.from({ length: 19 }, (_, n) => n + 1), 30]);
});

Deno.test("each feed has its own cap and dates run forward for fixtures and backward for results", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = f.n > 15,
      kickoff = ${clock} + interval '1 day' * CASE WHEN f.n <= 15 THEN 1 + f.n % 3 ELSE -1 - f.n % 3 END
      FROM fixture f WHERE f.id = g.id;
    SELECT json_build_object('upcoming', (SELECT count(*) FROM home_game_order(${clock}) WHERE NOT is_played),
      'recent', (SELECT count(*) FROM home_game_order(${clock}) WHERE is_played),
      'firstUpcomingDay', (SELECT extract(day FROM g.kickoff) FROM home_game_order(${clock}) h JOIN game_card g ON g.id = h.game_id WHERE NOT is_played AND feed_rank = 1),
      'firstRecentDay', (SELECT extract(day FROM g.kickoff) FROM home_game_order(${clock}) h JOIN game_card g ON g.id = h.game_id WHERE is_played AND feed_rank = 1));
  `), { upcoming: 15, recent: 15, firstUpcomingDay: 3, firstRecentDay: 1 });
});

Deno.test("team strength uses the harmonic mean and ignores ratings from future dates", async () => {
  assertEquals(await query(`
    CREATE TEMP TABLE pair AS SELECT id, row_number() OVER (ORDER BY id)::int AS n FROM team
      WHERE id NOT IN (SELECT home_id FROM game_card UNION SELECT away_id FROM game_card) LIMIT 2;
    INSERT INTO team_rating (id, team_id, measure_date, offense, defense, rating)
      SELECT gen_random_uuid(), id, '2026-10-01', 1, 1, CASE n WHEN 1 THEN 80 ELSE 20 END FROM pair;
    INSERT INTO team_rating (id, team_id, measure_date, offense, defense, rating)
      SELECT gen_random_uuid(), id, '2026-10-03', 1, 1, 100 FROM pair;
    UPDATE game_card g SET played = false, kickoff = ${clock} + interval '1 hour' FROM fixture f WHERE f.id = g.id;
    UPDATE game_card SET home_id = (SELECT id FROM pair WHERE n = 1), away_id = (SELECT id FROM pair WHERE n = 2)
      WHERE id = (SELECT id FROM fixture WHERE n = 1);
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), Array.from({ length: 20 }, (_, n) => n + 2));
});

Deno.test("a strong game in another competition is selected and orders that competition first on its day", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false, kickoff = ${clock} + interval '1 hour' + interval '1 minute' * f.n FROM fixture f WHERE f.id = g.id;
    UPDATE game_card SET phase_id = (SELECT id FROM phase WHERE id <> (SELECT phase_id FROM game_card LIMIT 1) ORDER BY id LIMIT 1)
      WHERE id = (SELECT id FROM fixture WHERE n = 30);
    INSERT INTO game_importance (id, home, away) SELECT id, 100, 100 FROM fixture WHERE n = 30;
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [30, ...Array.from({ length: 19 }, (_, n) => n + 1)]);
});

Deno.test("missing or zero ratings remain finite and ties are stable", async () => {
  assertEquals(await query(`
    DELETE FROM team_rating;
    UPDATE game_card g SET played = false, kickoff = ${clock} + interval '1 hour' FROM fixture f WHERE f.id = g.id;
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), Array.from({ length: 20 }, (_, n) => n + 1));
});

Deno.test("refresh clears expired ranks, switches feeds, and replay avoids rewriting unchanged rows", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false, kickoff = now() + interval '1 hour' FROM fixture f WHERE f.id = g.id AND f.n = 1;
    SELECT refresh_home_games();
    CREATE TEMP TABLE version AS SELECT id, ctid::text AS version FROM game_card;
    SELECT refresh_home_games();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM game_card g JOIN version v USING (id) WHERE g.ctid::text <> v.version) THEN RAISE EXCEPTION 'replay rewrote unchanged rows'; END IF; END $$;
    UPDATE game_card g SET played = true, kickoff = now() - interval '1 hour' FROM fixture f WHERE f.id = g.id AND f.n = 1;
    SELECT refresh_home_games();
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM game_card g JOIN fixture f USING (id) WHERE n = 1 AND home_upcoming_rank = 0 AND home_recent_rank = 1) THEN RAISE EXCEPTION 'result did not switch feeds'; END IF; END $$;
    UPDATE game_card SET kickoff = now() - interval '8 days';
    SELECT refresh_home_games();
    SELECT json_build_object('remaining', count(*)) FROM game_card WHERE home_upcoming_rank > 0 OR home_recent_rank > 0;
  `), { remaining: 0 });
});

Deno.test("anonymous readers cannot run the service refresh", async () => {
  assertEquals(await query(`SELECT json_build_object('anon', has_function_privilege('anon', 'refresh_home_games()', 'EXECUTE'), 'reader', has_function_privilege('app_user', 'refresh_home_games()', 'EXECUTE'), 'service', has_function_privilege('service', 'refresh_home_games()', 'EXECUTE'));`), { anon: false, reader: false, service: true });
});

Deno.test("each championship has one heading per feed, with no duplicates, stale headings or replay writes", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = f.n > 15,
      kickoff = now() + interval '1 minute' * CASE WHEN f.n <= 15 THEN f.n ELSE -f.n END,
      championship_id = CASE WHEN f.n % 2 = 0 THEN
        (SELECT id FROM championship ORDER BY id OFFSET 1 LIMIT 1)
        ELSE (SELECT id FROM championship ORDER BY id LIMIT 1) END
      FROM fixture f WHERE f.id = g.id;
    SELECT refresh_home_games();
    DO $$ BEGIN IF EXISTS (
      SELECT championship_id, played FROM game_card WHERE home_upcoming_rank > 0 OR home_recent_rank > 0
      GROUP BY championship_id, played HAVING count(*) FILTER (WHERE home_upcoming_group OR home_recent_group) <> 1
        OR min(home_upcoming_rank + home_recent_rank) <> min(home_upcoming_rank + home_recent_rank) FILTER (WHERE home_upcoming_group OR home_recent_group)
    ) THEN RAISE EXCEPTION 'a championship heading is missing, repeated or out of order'; END IF; END $$;
    CREATE TEMP TABLE grouped_version AS SELECT id, ctid::text AS version FROM game_card;
    SELECT refresh_home_games();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM game_card g JOIN grouped_version v USING (id) WHERE g.ctid::text <> v.version)
      THEN RAISE EXCEPTION 'group replay rewrote unchanged rows'; END IF; END $$;
    UPDATE game_card SET kickoff = NULL;
    SELECT refresh_home_games();
    SELECT json_build_object('headings', count(*)) FROM game_card WHERE home_upcoming_group OR home_recent_group;
  `), { headings: 0 });
});

Deno.test("the homepage projection contains only both selected feeds and replay never rewrites it", async () => {
  assertEquals(await query(`
    INSERT INTO fixture SELECT id, 30 + row_number() OVER (ORDER BY id)::int
      FROM game_card WHERE id NOT IN (SELECT id FROM fixture) ORDER BY id LIMIT 30;
    UPDATE game_card g SET played = f.n > 30,
      kickoff = now() + interval '1 minute' * CASE WHEN f.n <= 30 THEN f.n ELSE -f.n END
      FROM fixture f WHERE f.id = g.id;
    CREATE TEMP TABLE unselected_versions AS SELECT id,ctid::text AS version FROM game_card WHERE kickoff IS NULL;
    SELECT refresh_home_games();
    CREATE TEMP TABLE home_versions AS SELECT id,ctid::text AS version FROM home_game_card;
    SELECT refresh_home_games();
    SELECT json_build_object('upcoming', (SELECT count(*) FROM home_game_card WHERE home_upcoming_rank > 0),
      'recent', (SELECT count(*) FROM home_game_card WHERE home_recent_rank > 0),
      'mismatch', (SELECT count(*) FROM home_game_card h JOIN game_card g USING(id)
        WHERE (to_jsonb(h)-'txid') IS DISTINCT FROM (to_jsonb(g)-'txid')),
      'replayWrites', (SELECT count(*) FROM home_game_card h JOIN home_versions v USING(id) WHERE h.ctid::text<>v.version),
      'unselectedWrites', (SELECT count(*) FROM game_card g JOIN unselected_versions v USING(id) WHERE g.ctid::text<>v.version));
  `), { upcoming: 20, recent: 20, mismatch: 0, replayWrites: 0, unselectedWrites: 0 });
});

Deno.test("selected display edits and deletions reach the homepage immediately, with no-op edits suppressed", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
      FROM fixture f WHERE f.id=g.id AND f.n=1;
    SELECT refresh_home_games();
    UPDATE game_card SET home_name='Corrected home name',attendance=1234
      WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM home_game_card WHERE home_name='Corrected home name' AND attendance=1234)
      THEN RAISE EXCEPTION 'selected display edit was not copied'; END IF; END $$;
    CREATE TEMP TABLE edit_version AS SELECT id,ctid::text AS version FROM home_game_card;
    UPDATE game_card SET home_name=home_name WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM home_game_card h JOIN edit_version v USING(id) WHERE h.ctid::text<>v.version)
      THEN RAISE EXCEPTION 'unchanged display rewrote the projection'; END IF; END $$;
    DELETE FROM game_card WHERE id=(SELECT id FROM fixture WHERE n=1);
    SELECT json_build_object('remaining',count(*)) FROM home_game_card;
  `), { remaining: 0 });
});

Deno.test("expiry clears the homepage projection and its heading markers in the same refresh", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
      FROM fixture f WHERE f.id=g.id AND f.n<=2;
    SELECT refresh_home_games();
    UPDATE game_card SET kickoff=now()-interval '8 days';
    SELECT refresh_home_games();
    SELECT json_build_object('feed',(SELECT count(*) FROM home_game_card),
      'ranks',(SELECT count(*) FROM game_card WHERE home_upcoming_rank>0 OR home_recent_rank>0),
      'headings',(SELECT count(*) FROM game_card WHERE home_upcoming_group OR home_recent_group));
  `), { feed: 0, ranks: 0, headings: 0 });
});

Deno.test("candidate ratings use the latest eligible date and deterministic same-day ID tie break", async () => {
  assertEquals(await query(`
    CREATE TEMP TABLE pair AS SELECT id,row_number() OVER(ORDER BY id)::int AS n FROM team
      WHERE id NOT IN (SELECT home_id FROM game_card UNION SELECT away_id FROM game_card) LIMIT 2;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT ('f1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,id,'2026-10-01',1,1,80 FROM pair;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT ('f2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,id,'2026-10-01',1,1,0 FROM pair;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),id,'2026-09-30',1,1,0 FROM pair;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),id,'2026-10-03',1,1,0 FROM pair;
    UPDATE game_card g SET played=false,kickoff=${clock}+interval '1 hour' FROM fixture f WHERE f.id=g.id;
    UPDATE game_card SET home_id=(SELECT id FROM pair WHERE n=1),away_id=(SELECT id FROM pair WHERE n=2)
      WHERE id=(SELECT id FROM fixture WHERE n=30);
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id=h.game_id;
  `), [30, ...Array.from({ length: 19 }, (_, n) => n + 1)]);
});

Deno.test("the bounded homepage is public to scoped readers and writable only by its service", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
      FROM fixture f WHERE f.id=g.id AND f.n=1;
    SET LOCAL ROLE service;
    SELECT refresh_home_games();
    RESET ROLE;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ DECLARE changed integer; BEGIN
      IF (SELECT count(*) FROM home_game_card)<>1 THEN RAISE EXCEPTION 'public reader cannot read the homepage'; END IF;
      DELETE FROM home_game_card;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed<>0 THEN RAISE EXCEPTION 'reader deleted a homepage card'; END IF;
    END $$;
    RESET ROLE;
    SELECT json_build_object('rows',(SELECT count(*) FROM home_game_card),
      'readerCopy',has_function_privilege('app_user','copy_home_game_cards(uuid[])','EXECUTE'),
      'anonCopy',has_function_privilege('anon','copy_home_game_cards(uuid[])','EXECUTE'));
  `), { rows: 1, readerCopy: false, anonCopy: false });
});

Deno.test("an overlapping clock refresh skips work while the first transaction owns the lock", async () => {
  const holder = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atq"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = holder.stdin.getWriter();
  const reader = holder.stdout.getReader();
  const errors = new Response(holder.stderr).text();
  try {
    await writer.write(new TextEncoder().encode("BEGIN;\nSELECT pg_advisory_xact_lock(715015,1);\nSELECT 'lock-ready';\n"));
    let output = "";
    while (!output.includes("lock-ready")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`lock holder stopped: ${await errors}`);
      output += new TextDecoder().decode(chunk.value);
    }
    assertEquals(await query(`
      UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
        FROM fixture f WHERE f.id=g.id AND f.n=1;
      SELECT refresh_home_games();
      SELECT json_build_object('rows',(SELECT count(*) FROM home_game_card),
        'ranks',(SELECT count(*) FROM game_card WHERE home_upcoming_rank>0 OR home_recent_rank>0),
        'timeout',(SELECT 'statement_timeout=20s'=ANY(proconfig) FROM pg_proc WHERE oid='refresh_home_games()'::regprocedure));
    `), { rows: 0, ranks: 0, timeout: true });
  } finally {
    await writer.write(new TextEncoder().encode("ROLLBACK;\n"));
    await writer.close();
    await reader.cancel();
    const status = await holder.status;
    if (!status.success) throw new Error(await errors);
    await errors;
  }
});
