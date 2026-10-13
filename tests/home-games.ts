// Selection runs with a fixed clock; every fixture and write is rolled back.
import { assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
const clock = "'2026-10-02 12:00:00+00'::timestamptz";
const setup = `
  CREATE TEMP TABLE fixture AS SELECT id, row_number() OVER (ORDER BY id)::int AS n
    FROM game_card ORDER BY id LIMIT 30;
  UPDATE game_card SET kickoff = NULL;
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

Deno.test("the feeds are read, not refreshed: a result switches feeds and an expired game leaves at once", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played = false, kickoff = now() + interval '1 hour' FROM fixture f WHERE f.id = g.id AND f.n = 1;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM home_feed h JOIN fixture f USING (id) WHERE n = 1 AND home_upcoming_rank = 1 AND home_recent_rank = 0) THEN RAISE EXCEPTION 'fixture was not upcoming'; END IF; END $$;
    UPDATE game_card g SET played = true, kickoff = now() - interval '1 hour' FROM fixture f WHERE f.id = g.id AND f.n = 1;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM home_feed h JOIN fixture f USING (id) WHERE n = 1 AND home_upcoming_rank = 0 AND home_recent_rank = 1) THEN RAISE EXCEPTION 'result did not switch feeds'; END IF; END $$;
    UPDATE game_card SET kickoff = now() - interval '15 days';
    SELECT json_build_object('remaining', count(*)) FROM home_feed;
  `), { remaining: 0 });
});

Deno.test("group and day markers follow phase and local-day transitions in feed order, including interleaved phases", async () => {
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
    SELECT json_build_object(
      'order', (SELECT json_agg(f.n ORDER BY h.home_upcoming_rank) FROM home_feed h JOIN fixture f USING (id)),
      'groups', (SELECT json_agg(h.home_upcoming_group ORDER BY h.home_upcoming_rank) FROM home_feed h),
      'days', (SELECT json_agg(h.home_new_day ORDER BY h.home_upcoming_rank) FROM home_feed h),
      'recentGroups', (SELECT count(*) FROM home_feed WHERE home_recent_group));
  `), { order: [1, 2, 3, 4], groups: [true, true, true, true], days: [true, false, false, true], recentGroups: 0 });
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

Deno.test("the homepage holds only both selected feeds, each a GameCard read on its local day", async () => {
  assertEquals(await query(`
    INSERT INTO fixture SELECT id, 30 + row_number() OVER (ORDER BY id)::int
      FROM game_card WHERE id NOT IN (SELECT id FROM fixture) ORDER BY id LIMIT 30;
    UPDATE game_card g SET played = f.n > 30,
      kickoff = now() + interval '1 minute' * CASE WHEN f.n <= 30 THEN f.n ELSE -f.n END,
      day = date '2000-01-01'
      FROM fixture f WHERE f.id = g.id;
    UPDATE game_card SET home_name = 'Corrected home name' WHERE id = (SELECT id FROM fixture WHERE n = 1);
    SELECT json_build_object('upcoming', (SELECT count(*) FROM home_feed WHERE home_upcoming_rank > 0),
      'recent', (SELECT count(*) FROM home_feed WHERE home_recent_rank > 0),
      'mismatch', (SELECT count(*) FROM home_feed h JOIN game_card g USING(id)
        WHERE (h.phase_id, h.championship_id, h.kickoff, h.played, h.home_id, h.away_id, h.home_name, h.away_name, h.home_score, h.away_score, h.attendance)
          IS DISTINCT FROM (g.phase_id, g.championship_id, g.kickoff, g.played, g.home_id, g.away_id, g.home_name, g.away_name, g.home_score, g.away_score, g.attendance)),
      'badDays', (SELECT count(*) FROM home_feed h WHERE h.day IS DISTINCT FROM (h.kickoff AT TIME ZONE 'America/Sao_Paulo')::date),
      'edited', (SELECT home_name FROM home_feed WHERE id = (SELECT id FROM fixture WHERE n = 1)));
  `), { upcoming: 20, recent: 20, mismatch: 0, badDays: 0, edited: "Corrected home name" });
});

Deno.test("the homepage is public to scoped readers, written by nobody, and a security-invoker read", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,kickoff=now()+interval '1 hour'
      FROM fixture f WHERE f.id=g.id AND f.n=1;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN IF (SELECT count(*) FROM home_feed)<>1 THEN RAISE EXCEPTION 'public reader cannot read the homepage'; END IF; END $$;
    RESET ROLE;
    SELECT json_build_object(
      'readerWrites', has_table_privilege('app_user','home_feed','INSERT,UPDATE,DELETE'),
      'serviceWrites', has_table_privilege('service','home_feed','INSERT,UPDATE,DELETE'),
      'invoker', (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='home_feed'::regclass),
      'unscoped', (SELECT count(*) FROM home_feed) = 1);
  `), { readerWrites: false, serviceWrites: false, invoker: true, unscoped: true });
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

Deno.test("the homepage's highlights are the selection's at the read", async () => {
  assertEquals(await query(`
    UPDATE game_card g SET played=false,phase_id=(SELECT id FROM phase ORDER BY id LIMIT 1),
      kickoff=now()+interval '1 hour' * f.n FROM fixture f WHERE f.n<=6 AND f.id=g.id;
    UPDATE game_card g SET kickoff=NULL FROM fixture f WHERE f.n>6 AND f.id=g.id;
    SELECT json_build_object('mismatch', (SELECT count(*) FROM home_feed h
      JOIN home_game_selection(now()) s ON s.game_id = h.id WHERE h.home_highlighted IS DISTINCT FROM s.highlighted),
      'rows', (SELECT count(*) FROM home_feed));
  `), { mismatch: 0, rows: 6 });
});

Deno.test("selection is a public read, as the homepage invokes it, while legacy order keeps its original result", async () => {
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
  `), { selectionAnon: true, selectionReader: true, selectionService: true, sameRows: true, legacyArity: 1 });
});

// The selection reads each team's newest rating from team_latest_rating, one
// row per team, so a cold read does not walk team_rating's index per team; the
// triggers keep it in step within the writing transaction.
Deno.test("team_latest_rating follows every write to team_rating, including a delete back to an older rating", async () => {
  assertEquals(await query(`
    CREATE TEMP TABLE probe AS SELECT home_id AS team_id FROM game_card ORDER BY id LIMIT 1;
    INSERT INTO team_rating (id, team_id, measure_date, offense, defense, rating)
      SELECT 'f3000000-0000-4000-8000-000000000001', team_id, '2026-10-05', 1, 1, 70 FROM probe;
    CREATE TEMP TABLE after_insert AS SELECT rating FROM team_latest_rating WHERE team_id = (SELECT team_id FROM probe);
    UPDATE team_rating SET rating = 71 WHERE id = 'f3000000-0000-4000-8000-000000000001';
    CREATE TEMP TABLE after_update AS SELECT rating FROM team_latest_rating WHERE team_id = (SELECT team_id FROM probe);
    DELETE FROM team_rating WHERE id = 'f3000000-0000-4000-8000-000000000001';
    SELECT json_build_object('inserted', (SELECT rating FROM after_insert), 'updated', (SELECT rating FROM after_update),
      'deleted', (SELECT rating FROM team_latest_rating WHERE team_id = (SELECT team_id FROM probe)),
      'mismatch', (SELECT count(*) FROM team t LEFT JOIN team_latest_rating l ON l.team_id = t.id
        LEFT JOIN LATERAL (SELECT rating, measure_date FROM team_rating WHERE team_id = t.id ORDER BY measure_date DESC, id LIMIT 1) r ON true
        WHERE (l.rating, l.measure_date) IS DISTINCT FROM (r.rating, r.measure_date)));
  `), { inserted: 70, updated: 71, deleted: 50, mismatch: 0 });
});

