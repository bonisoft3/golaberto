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

// The script's temp tables and probe triggers are its own scaffolding: pgroll's
// event trigger would record each as an inferred migration, and two checks
// recording against one parent fail on its history_is_linear index.
async function query(sql: string) {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", `BEGIN; SET LOCAL pgroll.no_inferred_migrations = 'TRUE'; ${setup} ${sql} ROLLBACK;`],
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

Deno.test("home windows use the grace and strict fourteen-day boundaries for both feeds", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = f.n >= 5, kickoff = CASE f.n
      WHEN 1 THEN ${clock} - interval '3 hours'
      WHEN 2 THEN ${clock} - interval '3 hours' + interval '1 second'
      WHEN 3 THEN ${clock} + interval '14 days' - interval '1 second'
      WHEN 4 THEN ${clock} + interval '14 days'
      WHEN 5 THEN ${clock} - interval '3 hours' - interval '14 days'
      WHEN 6 THEN ${clock} - interval '3 hours' - interval '14 days' + interval '1 second'
      WHEN 7 THEN ${clock} - interval '3 hours' - interval '1 second'
      WHEN 8 THEN ${clock}
      WHEN 9 THEN ${clock} - interval '3 hours' + interval '14 days' - interval '1 second'
      WHEN 10 THEN ${clock} - interval '3 hours' + interval '14 days' END
      FROM fixture f WHERE f.id = g.id;
    SELECT json_agg(f.n ORDER BY f.n) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [2, 3, 6, 7, 8, 9]);
});

Deno.test("importance and daily decay select the strongest twenty rather than the nearest twenty", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false, kickoff = ${clock} + interval '1 hour' * f.n
      FROM fixture f WHERE f.id = g.id;
    INSERT INTO game_importance (id, home, away) SELECT id, 100, 100 FROM fixture WHERE n = 30;
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [...Array.from({ length: 19 }, (_, n) => n + 1), 30]);
});

Deno.test("quality decay is centered three hours before the supplied clock", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false,
      kickoff = CASE WHEN f.n = 30 THEN ${clock} - interval '2 hours' ELSE ${clock} + interval '1 hour' END
      FROM fixture f WHERE f.id = g.id;
    SELECT f.n FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id WHERE h.feed_rank = 1;
  `), 30);
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

Deno.test("date direction takes priority over a phase's quality in both feeds", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=f.n>2,
      phase_id=CASE WHEN f.n IN (2,4) THEN (SELECT id FROM phase ORDER BY id OFFSET 1 LIMIT 1)
        ELSE (SELECT id FROM phase ORDER BY id LIMIT 1) END,
      kickoff=CASE f.n WHEN 1 THEN ${clock}+interval '1 day'
        WHEN 2 THEN ${clock}+interval '2 days'
        WHEN 3 THEN ${clock}-interval '1 day'
        WHEN 4 THEN ${clock}-interval '2 days' END
      FROM fixture f WHERE f.id=g.id AND f.n<=4;
    INSERT INTO game_importance(id,home,away) SELECT id,100,100 FROM fixture WHERE n IN (2,4);
    SELECT json_build_object('upcoming',(SELECT json_agg(f.n ORDER BY h.feed_rank)
      FROM home_game_order(${clock}) h JOIN fixture f ON f.id=h.game_id WHERE NOT h.is_played),
      'recent',(SELECT json_agg(f.n ORDER BY h.feed_rank)
      FROM home_game_order(${clock}) h JOIN fixture f ON f.id=h.game_id WHERE h.is_played));
  `), {upcoming:[1,2],recent:[3,4]});
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
    UPDATE game_card SET kickoff = now() - interval '15 days';
    SELECT refresh_home_games();
    SELECT json_build_object('remaining', count(*)) FROM game_card WHERE home_upcoming_rank > 0 OR home_recent_rank > 0;
  `), { remaining: 0 });
});

Deno.test("anonymous readers cannot run the service refresh", async () => {
  assertEquals(await query(`SELECT json_build_object('anon', has_function_privilege('anon', 'refresh_home_games()', 'EXECUTE'), 'reader', has_function_privilege('app_user', 'refresh_home_games()', 'EXECUTE'), 'service', has_function_privilege('service', 'refresh_home_games()', 'EXECUTE'));`), { anon: false, reader: false, service: true });
});

Deno.test("group markers follow phase and local-day transitions in feed order, including interleaved phases", async () => {
  assertEquals(await query(`
    DELETE FROM team_rating;
    UPDATE game_card g SET played = false,
      phase_id = CASE WHEN f.n = 2 THEN (SELECT id FROM phase ORDER BY id OFFSET 1 LIMIT 1)
        ELSE (SELECT id FROM phase ORDER BY id LIMIT 1) END,
      kickoff = CASE f.n WHEN 1 THEN now() + interval '1 minute'
        WHEN 2 THEN now() + interval '2 minutes'
        WHEN 3 THEN now() + interval '3 minutes'
        WHEN 4 THEN now() + interval '1 day 1 minute' END
      FROM fixture f WHERE f.id = g.id;
    SELECT refresh_home_games();
    DO $$ BEGIN
      IF (SELECT json_agg(f.n ORDER BY g.home_upcoming_rank)::jsonb FROM game_card g JOIN fixture f USING(id)
          WHERE g.home_upcoming_rank > 0) <> '[1,2,3,4]'::jsonb THEN RAISE EXCEPTION 'unexpected feed order'; END IF;
      IF EXISTS (
        WITH ordered AS (
          SELECT g.id, g.phase_id, (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day,
            g.home_upcoming_group AS actual,
            lag(g.phase_id) OVER (ORDER BY g.home_upcoming_rank) AS previous_phase,
            lag((g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date) OVER (ORDER BY g.home_upcoming_rank) AS previous_day
          FROM game_card g WHERE g.home_upcoming_rank > 0
        )
        SELECT 1 FROM ordered WHERE actual IS DISTINCT FROM
          (previous_phase IS DISTINCT FROM phase_id OR previous_day IS DISTINCT FROM local_day)
      ) THEN RAISE EXCEPTION 'group marker did not follow a phase or local-day transition'; END IF;
      IF (SELECT count(*) FROM game_card WHERE home_upcoming_rank > 0 AND home_upcoming_group) <> 4
        THEN RAISE EXCEPTION 'interleaved phases or new local day did not start a group'; END IF;
    END $$;
    CREATE TEMP TABLE grouped_version AS SELECT id, ctid::text AS version FROM game_card;
    SELECT refresh_home_games();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM game_card g JOIN grouped_version v USING (id) WHERE g.ctid::text <> v.version)
      THEN RAISE EXCEPTION 'group replay rewrote unchanged rows'; END IF; END $$;
    UPDATE game_card SET kickoff = NULL;
    SELECT refresh_home_games();
    SELECT json_build_object('markers', count(*)) FROM game_card WHERE home_upcoming_group OR home_recent_group;
  `), { markers: 0 });
});

Deno.test("tied phase quality preserves kickoff order across interleaved phases", async () => {
  assertEquals(await query(`
    DELETE FROM team_rating;
    UPDATE game_card g SET played = false,
      phase_id = CASE WHEN f.n = 2 THEN (SELECT id FROM phase ORDER BY id OFFSET 1 LIMIT 1)
        ELSE (SELECT id FROM phase ORDER BY id LIMIT 1) END,
      kickoff = CASE f.n WHEN 1 THEN ${clock} + interval '1 minute'
        WHEN 2 THEN ${clock} + interval '2 minutes'
        WHEN 3 THEN ${clock} + interval '3 minutes' END
      FROM fixture f WHERE f.id = g.id AND f.n <= 3;
    SELECT json_agg(f.n ORDER BY h.feed_rank) FROM home_game_order(${clock}) h JOIN fixture f ON f.id = h.game_id;
  `), [1, 2, 3]);
});

Deno.test("the homepage projection contains only both selected feeds and replay never rewrites it", async () => {
  assertEquals(await query(`
    INSERT INTO fixture SELECT id, 30 + row_number() OVER (ORDER BY id)::int
      FROM game_card WHERE id NOT IN (SELECT id FROM fixture) ORDER BY id LIMIT 30;
    UPDATE game_card g SET played = f.n > 30,
      kickoff = now() + interval '1 minute' * CASE WHEN f.n <= 30 THEN f.n ELSE -f.n END,
      day = date '2000-01-01'
      FROM fixture f WHERE f.id = g.id;
    CREATE TEMP TABLE unselected_versions AS SELECT id,ctid::text AS version FROM game_card WHERE kickoff IS NULL;
    SELECT refresh_home_games();
    CREATE TEMP TABLE home_versions AS SELECT id,ctid::text AS version FROM home_game_card;
    SELECT refresh_home_games();
    SELECT json_build_object('upcoming', (SELECT count(*) FROM home_game_card WHERE home_upcoming_rank > 0),
      'recent', (SELECT count(*) FROM home_game_card WHERE home_recent_rank > 0),
      'mismatch', (SELECT count(*) FROM home_game_card h JOIN game_card g USING(id)
        WHERE (to_jsonb(h)-ARRAY['txid', 'day', 'day_display', 'show_country', 'home_country', 'away_country', 'home_highlighted'])
          IS DISTINCT FROM (to_jsonb(g)-ARRAY['txid', 'day', 'day_display', 'show_country', 'home_country', 'away_country'])),
      'badDays', (SELECT count(*) FROM home_game_card h WHERE h.day IS DISTINCT FROM (h.kickoff AT TIME ZONE 'America/Sao_Paulo')::date),
      'replayWrites', (SELECT count(*) FROM home_game_card h JOIN home_versions v USING(id) WHERE h.ctid::text<>v.version),
      'unselectedWrites', (SELECT count(*) FROM game_card g JOIN unselected_versions v USING(id) WHERE g.ctid::text<>v.version));
  `), { upcoming: 20, recent: 20, mismatch: 0, badDays: 0, replayWrites: 0, unselectedWrites: 0 });
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
    UPDATE game_card SET kickoff=NULL WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM home_game_card) THEN RAISE EXCEPTION 'removed kickoff remained on home'; END IF; END $$;
    UPDATE game_card SET kickoff=now()+interval '1 hour' WHERE id=(SELECT id FROM fixture WHERE n=1);
    DO $$ BEGIN IF (SELECT count(*) FROM home_game_card)<>1 THEN RAISE EXCEPTION 'restored kickoff was not copied'; END IF; END $$;
    DELETE FROM game_card WHERE id=(SELECT id FROM fixture WHERE n=1);
    SELECT json_build_object('remaining',count(*)) FROM home_game_card;
  `), { remaining: 0 });
});

Deno.test("expiry clears the homepage projection and its heading markers in the same refresh", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
      FROM fixture f WHERE f.id=g.id AND f.n<=2;
    SELECT refresh_home_games();
    UPDATE game_card SET kickoff=now()-interval '15 days';
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
    args: ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atq"],
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

Deno.test("highlights use raw top five within selected games plus one weighted phase-day winner", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,
      phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),
      kickoff=CASE WHEN f.n<=5 THEN ${clock}+interval '13 days'
        WHEN f.n<=20 THEN ${clock}+interval '1 hour'
        ELSE ${clock}+interval '13 days' END
      FROM fixture f WHERE f.id=g.id;
    INSERT INTO game_importance(id,home,away)
      SELECT id, CASE WHEN n<=5 THEN 100 ELSE 0 END, CASE WHEN n<=5 THEN 100 ELSE 0 END
      FROM fixture;
    SELECT json_build_object(
      'ranked', (SELECT json_agg(f.n ORDER BY s.feed_rank) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id),
      'highlighted', (SELECT json_agg(f.n ORDER BY f.n) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id WHERE s.highlighted),
      'weightedTopFive', (SELECT json_agg(n ORDER BY feed_rank) FROM (SELECT f.n,s.feed_rank FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id ORDER BY s.feed_rank LIMIT 5) first_five));
  `), { ranked: Array.from({ length: 15 }, (_, n) => n + 6).concat([1,2,3,4,5]), highlighted: [1,2,3,4,5,20], weightedTopFive: [6,7,8,9,10] });
});

Deno.test("phase-day winners are independent, deterministic on ties, and zero ties do not promote excluded winners", async () => {
  assertEquals(await query(`
    DELETE FROM team_rating;
    UPDATE game_card g SET played=false,
      phase_id=(SELECT id FROM phase ORDER BY id OFFSET ((f.n-1)/4) LIMIT 1),
      kickoff=${clock}+interval '1 hour' + interval '1 day' * (((f.n-1)%4)/2)
      FROM fixture f WHERE f.n<=8 AND f.id=g.id;
    UPDATE game_card g SET kickoff=NULL FROM fixture f WHERE f.n>8 AND f.id=g.id;
    SELECT json_build_object(
      'highlights', (SELECT json_agg(f.n ORDER BY f.n) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id WHERE s.highlighted),
      'winners', (SELECT json_agg(f.n ORDER BY f.n) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id WHERE s.highlighted AND f.n IN (2,4,6,8)),
      'selected', (SELECT json_agg(f.n ORDER BY s.feed_rank) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id));
  `), { highlights: [1,2,3,4,5,6,8], winners: [2,4,6,8], selected: [1,2,5,6,3,4,7,8] });
  assertEquals(await query(`
    DELETE FROM team_rating;
    UPDATE game_card g SET played=false,phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),kickoff=${clock}+interval '1 hour'
      FROM fixture f WHERE f.id=g.id;
    SELECT json_build_object('selected',count(*),
      'winnerSelected',bool_or(s.game_id=(SELECT id FROM fixture WHERE n=30)),
      'highlighted',json_agg(f.n ORDER BY f.n) FILTER (WHERE s.highlighted))
      FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id;
  `), { selected: 20, winnerSelected: false, highlighted: [1,2,3,4,5] });
});

Deno.test("played and upcoming feeds choose their raw-five sets and phase-day winners independently", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),
      played=f.n>6,
      kickoff=CASE WHEN f.n<=6 THEN ${clock}+interval '1 hour' ELSE ${clock}-interval '1 hour' END
      FROM fixture f WHERE f.n<=12 AND f.id=g.id;
    UPDATE game_card g SET kickoff=NULL FROM fixture f WHERE f.n>12 AND f.id=g.id;
    SELECT json_build_object(
      'upcoming', (SELECT json_agg(f.n ORDER BY f.n) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id WHERE NOT s.is_played AND s.highlighted),
      'played', (SELECT json_agg(f.n ORDER BY f.n) FROM home_game_selection(${clock}) s JOIN fixture f ON f.id=s.game_id WHERE s.is_played AND s.highlighted),
      'upcomingCount', (SELECT count(*) FROM home_game_selection(${clock}) WHERE NOT is_played),
      'playedCount', (SELECT count(*) FROM home_game_selection(${clock}) WHERE is_played));
  `), { upcoming: [1,2,3,4,5,6], played: [7,8,9,10,11,12], upcomingCount: 6, playedCount: 6 });
});

Deno.test("live importance changes highlights without changing selected membership or feed order", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false, phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),
      kickoff=${clock}+interval '1 hour' * f.n FROM fixture f WHERE f.n<=6 AND f.id=g.id;
    UPDATE game_card g SET kickoff=NULL FROM fixture f WHERE f.n>6 AND f.id=g.id;
    CREATE TEMP TABLE before_selection AS
      SELECT game_id,feed_rank,highlighted FROM home_game_selection(${clock});
    INSERT INTO game_importance(id,home,away)
      SELECT id, CASE n WHEN 6 THEN 1 ELSE 0.1 END, CASE n WHEN 6 THEN 1 ELSE 0.1 END
      FROM fixture WHERE n IN (1,6);
    CREATE TEMP TABLE after_selection AS
      SELECT game_id,feed_rank,highlighted FROM home_game_selection(${clock});
    SELECT json_build_object('sameOrder', NOT EXISTS (
        (SELECT game_id,feed_rank FROM before_selection EXCEPT SELECT game_id,feed_rank FROM after_selection)
        UNION ALL
        (SELECT game_id,feed_rank FROM after_selection EXCEPT SELECT game_id,feed_rank FROM before_selection)),
      'beforeSix', (SELECT highlighted FROM before_selection s JOIN fixture f ON f.id=s.game_id WHERE f.n=6),
      'afterSix', (SELECT highlighted FROM after_selection s JOIN fixture f ON f.id=s.game_id WHERE f.n=6),
      'beforeFive', (SELECT highlighted FROM before_selection s JOIN fixture f ON f.id=s.game_id WHERE f.n=5),
      'afterFive', (SELECT highlighted FROM after_selection s JOIN fixture f ON f.id=s.game_id WHERE f.n=5));
  `), { sameOrder: true, beforeSix: false, afterSix: true, beforeFive: true, afterFive: false });
});

Deno.test("refresh writes only highlight changes, replay is a no-op, and display copying preserves the destination highlight", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),
      kickoff=now()+interval '1 hour' * f.n FROM fixture f WHERE f.n<=6 AND f.id=g.id;
    UPDATE game_card g SET kickoff=NULL FROM fixture f WHERE f.n>6 AND f.id=g.id;
    SELECT refresh_home_games();
    UPDATE home_game_card SET home_highlighted=false WHERE id=(SELECT id FROM fixture WHERE n=1);
    CREATE TEMP TABLE home_versions AS SELECT id,ctid::text version FROM home_game_card;
    SELECT refresh_home_games();
    DO $$ BEGIN IF (SELECT home_highlighted FROM home_game_card WHERE id=(SELECT id FROM fixture WHERE n=1)) IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'refresh did not repair a highlight'; END IF; END $$;
    CREATE TEMP TABLE refreshed_versions AS SELECT id,ctid::text version FROM home_game_card;
    SELECT refresh_home_games();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM home_game_card h JOIN refreshed_versions v USING(id) WHERE h.ctid::text<>v.version)
      THEN RAISE EXCEPTION 'unchanged refresh rewrote home cards'; END IF; END $$;
    CREATE TEMP TABLE refresh_write_counts AS SELECT
      (SELECT count(*) FROM home_game_card h JOIN home_versions v USING(id) WHERE h.ctid::text<>v.version) AS old_writes,
      (SELECT count(*) FROM home_game_card h JOIN refreshed_versions v USING(id) WHERE h.ctid::text<>v.version) AS replay_writes;
    UPDATE home_game_card SET home_highlighted=false WHERE id=(SELECT id FROM fixture WHERE n=2);
    UPDATE game_card SET home_name='Preserve home highlight edit' WHERE id=(SELECT id FROM fixture WHERE n=2);
    SELECT json_build_object('preserved', (SELECT home_highlighted FROM home_game_card WHERE id=(SELECT id FROM fixture WHERE n=2)),
      'selection', (SELECT highlighted FROM home_game_selection(now()) WHERE game_id=(SELECT id FROM fixture WHERE n=2)),
      'oldWrites', (SELECT old_writes FROM refresh_write_counts),
      'replayWrites', (SELECT replay_writes FROM refresh_write_counts));
  `), { preserved: false, selection: true, oldWrites: 1, replayWrites: 0 });
});

Deno.test("selection is service-only while legacy order keeps its original result and permissions", async () => {
  assertEquals(await query(`
    SELECT json_build_object(
      'selectionAnon',has_function_privilege('anon','home_game_selection(timestamptz)','EXECUTE'),
      'selectionReader',has_function_privilege('app_user','home_game_selection(timestamptz)','EXECUTE'),
      'selectionService',has_function_privilege('service','home_game_selection(timestamptz)','EXECUTE'),
      'sameRows', NOT EXISTS (
        (SELECT game_id,is_played,feed_rank FROM home_game_selection(${clock}) EXCEPT SELECT game_id,is_played,feed_rank FROM home_game_order(${clock}))
        UNION ALL
        (SELECT game_id,is_played,feed_rank FROM home_game_order(${clock}) EXCEPT SELECT game_id,is_played,feed_rank FROM home_game_selection(${clock}))),
      'legacyArity', (SELECT pronargs FROM pg_proc WHERE oid='home_game_order(timestamptz)'::regprocedure));
  `), { selectionAnon: false, selectionReader: false, selectionService: true, sameRows: true, legacyArity: 1 });
});
