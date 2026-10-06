// Team profile fixtures run only in an explicitly disposable stack. The
// projection fixture rolls back; the concurrency fixture commits temporary
// rows and removes them in finally.
import { assert, assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test|prs)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error(
    "team-profiles requires an explicit disposable COMPOSE_PROJECT_NAME containing check or test",
  );
}

const psql = async (sql: string) => {
  const process = new Deno.Command("docker", {
    args: [
      "compose", "-p", project, "exec", "-T", "golaberto-database",
      "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1",
      "-qAt",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await process.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assert(result.success, stderr);
  return new TextDecoder().decode(result.stdout).trim();
};

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const uuid = () => crypto.randomUUID();

Deno.test("team profiles union memberships, deduplicate history, and refresh safely", async () => {
  const team = uuid();
  const opponent = uuid();
  const otherTeam = uuid();
  const playerMulti = uuid();
  const playerRegistered = uuid();
  const playerPast = uuid();
  const playerStatOnly = uuid();
  const currentChamp = uuid();
  const upcomingChamp = uuid();
  const pastChamp = uuid();
  const currentPhase = uuid();
  const cupPhase = uuid();
  const group = uuid();
  const game = uuid();
  const ratingIds = [uuid(), uuid()].sort();
  const [earlierRatingId] = ratingIds;

  const output = await psql(`BEGIN;
    INSERT INTO team (id, name, country) VALUES
      (${q(team)}, 'Profile Fixture', 'Brasil'),
      (${q(opponent)}, 'Profile Opponent', 'Brasil'),
      (${q(otherTeam)}, 'Profile Destination', 'Brasil');
    INSERT INTO player (id, name, position, country) VALUES
      (${q(playerMulti)}, 'Player Across Seasons', 'fw', 'Brasil'),
      (${q(playerRegistered)}, 'Registered Without Appearance', 'g', 'Brasil'),
      (${q(playerPast)}, 'Past Only Player', 'dc', 'Brasil'),
      (${q(playerStatOnly)}, 'Observed Only Player', 'cm', NULL);
    INSERT INTO championship (id, name, region_name, begins, ends) VALUES
      (${q(currentChamp)}, 'Profile Current', 'Brasil',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20,
        (now() AT TIME ZONE 'America/Sao_Paulo')::date),
      (${q(upcomingChamp)}, 'Profile Cup', 'Brasil',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1,
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 20),
      (${q(pastChamp)}, 'Profile Past', 'Brasil',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 80,
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1);
    INSERT INTO phase (id, championship_id, name) VALUES
      (${q(currentPhase)}, ${q(currentChamp)}, 'Group phase'),
      (${q(cupPhase)}, ${q(upcomingChamp)}, 'Cup phase');
    INSERT INTO stage_group (id, phase_id, name) VALUES
      (${q(group)}, ${q(currentPhase)}, 'Group A');
    INSERT INTO team_group (group_id, team_id) VALUES (${q(group)}, ${q(team)});
    -- The cup has no stage_group membership: actual home/away participation
    -- still makes its teams members of that championship.
    INSERT INTO game (id, phase_id, day, home_id, away_id) VALUES
      (${q(game)}, ${q(cupPhase)}, (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2,
        ${q(team)}, ${q(opponent)});
    INSERT INTO team_player (championship_id, team_id, player_id) VALUES
      (${q(currentChamp)}, ${q(team)}, ${q(playerMulti)}),
      (${q(pastChamp)}, ${q(team)}, ${q(playerMulti)}),
      (${q(upcomingChamp)}, ${q(team)}, ${q(playerRegistered)}),
      (${q(pastChamp)}, ${q(team)}, ${q(playerPast)});
    INSERT INTO player_stat (
      id, championship_id, team_id, player_id, player_name, position,
      played, started, came_on, bench, minutes, goals, penalties, own_goals,
      yellow, red, championship_name, team_name
    ) VALUES
      ('profile-current-stat-${team}', ${q(currentChamp)}, ${q(team)}, ${q(playerMulti)},
        'Stale upstream name', 'fw', 7, 5, 2, 1, 481, 4, 1, 1, 2, 1,
        'Current label', 'Old team label'),
      ('profile-past-stat-${team}', ${q(pastChamp)}, ${q(team)}, ${q(playerPast)},
        'Past label', 'dc', 1, 1, 0, 0, 90, 0, 0, 0, 0, 0,
        'Past label', 'Old team label'),
      ('profile-stat-only-${team}', ${q(currentChamp)}, ${q(team)}, ${q(playerStatOnly)},
        'Observed label', 'cm', 2, 0, 2, 0, 63, 1, 0, 0, 1, 0,
        'Current label', 'Old team label');
    INSERT INTO team_rating (id, team_id, measure_date, offense, defense, rating) VALUES
      (${q(uuid())}, ${q(team)}, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 1, 1, 90),
      (${q(earlierRatingId)}, ${q(team)}, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 1, 1, 42.25),
      (${q(ratingIds[1])}, ${q(team)}, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 1, 1, 12);

    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT array_agg(status::text ORDER BY status) FROM team_championship
          WHERE team_id='${team}') IS DISTINCT FROM ARRAY['current','past','upcoming']::text[]
        THEN RAISE EXCEPTION 'group, actual-game, registration and stat participation should produce current, upcoming and past championships'; END IF;
      IF (SELECT count(*) FROM team_championship WHERE team_id='${team}' AND championship_id='${upcomingChamp}') <> 1
        THEN RAISE EXCEPTION 'a cup without groups should still appear through actual game sides'; END IF;
      IF (SELECT count(*) FROM team_roster WHERE team_id='${team}' AND player_id='${playerMulti}') <> 2
        THEN RAISE EXCEPTION 'roster membership should retain one row per championship'; END IF;
      IF (SELECT count(*) FROM team_roster WHERE team_id='${team}' AND player_id='${playerRegistered}' AND championship_id='${upcomingChamp}') <> 1
        THEN RAISE EXCEPTION 'registration-only players should remain in the upcoming roster'; END IF;
      IF (SELECT player_name FROM team_roster WHERE team_id='${team}' AND player_id='${playerMulti}' AND championship_id='${currentChamp}') <> 'Player Across Seasons'
        THEN RAISE EXCEPTION 'current Player.name should override delayed PlayerStat.player_name'; END IF;
      IF (SELECT (played::integer,started::integer,came_on::integer,bench::integer,minutes::integer,
            goals::integer,penalties::integer,own_goals::integer,yellow::integer,red::integer)
          FROM team_roster WHERE team_id='${team}' AND player_id='${playerMulti}' AND championship_id='${currentChamp}')
        IS DISTINCT FROM (7,5,2,1,481,4,1,1,2,1)
        THEN RAISE EXCEPTION 'roster rows should copy all player-stat counters'; END IF;
      IF (SELECT (played::integer,started::integer,came_on::integer,bench::integer,minutes::integer,
            goals::integer,penalties::integer,own_goals::integer,yellow::integer,red::integer)
          FROM team_roster WHERE team_id='${team}' AND player_id='${playerRegistered}' AND championship_id='${upcomingChamp}')
        IS DISTINCT FROM (0,0,0,0,0,0,0,0,0,0)
        THEN RAISE EXCEPTION 'registration-only players should keep a zero-valued roster row'; END IF;
      IF (SELECT is_current FROM team_player_history WHERE team_id='${team}' AND player_id='${playerMulti}') IS DISTINCT FROM true
        THEN RAISE EXCEPTION 'any current association should take precedence over the same player’s past association'; END IF;
      IF (SELECT is_current FROM team_player_history WHERE team_id='${team}' AND player_id='${playerPast}') IS DISTINCT FROM false
        THEN RAISE EXCEPTION 'past-only players should be marked past'; END IF;
      IF (SELECT is_current FROM team_player_history WHERE team_id='${team}' AND player_id='${playerRegistered}') IS DISTINCT FROM true
        THEN RAISE EXCEPTION 'upcoming registrations should remain in the current-player history set'; END IF;
      IF (SELECT count(*) FROM team_player_history WHERE team_id='${team}' AND player_id='${playerMulti}') <> 1
        THEN RAISE EXCEPTION 'main history should deduplicate a player across championships'; END IF;
      IF (SELECT country FROM team_player_history WHERE team_id='${team}' AND player_id='${playerStatOnly}') IS NOT NULL
        THEN RAISE EXCEPTION 'optional player country should remain null'; END IF;
      IF (SELECT rating FROM team_directory WHERE id='${team}') IS DISTINCT FROM 42.25::double precision
        THEN RAISE EXCEPTION 'team profile rating should use the latest date and lowest id tie-breaker'; END IF;
    END $$;

    CREATE TEMP TABLE profile_versions AS
      SELECT 'championship' AS kind, id, ctid::text AS version FROM team_championship WHERE team_id='${team}'
      UNION ALL SELECT 'roster', id, ctid::text FROM team_roster WHERE team_id='${team}'
      UNION ALL SELECT 'history', id, ctid::text FROM team_player_history WHERE team_id='${team}';
    DO $$ BEGIN PERFORM enqueue_team_profile('${team}'); END $$;
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    DO $$ BEGIN
      IF EXISTS (
        SELECT kind, id, version FROM profile_versions
        EXCEPT
        SELECT kind, id, version FROM (
          SELECT 'championship' AS kind, id, ctid::text AS version FROM team_championship WHERE team_id='${team}'
          UNION ALL SELECT 'roster', id, ctid::text FROM team_roster WHERE team_id='${team}'
          UNION ALL SELECT 'history', id, ctid::text FROM team_player_history WHERE team_id='${team}'
        ) current_versions
      ) OR EXISTS (
        SELECT kind, id, version FROM (
          SELECT 'championship' AS kind, id, ctid::text AS version FROM team_championship WHERE team_id='${team}'
          UNION ALL SELECT 'roster', id, ctid::text FROM team_roster WHERE team_id='${team}'
          UNION ALL SELECT 'history', id, ctid::text FROM team_player_history WHERE team_id='${team}'
        ) current_versions
        EXCEPT
        SELECT kind, id, version FROM profile_versions
      ) THEN RAISE EXCEPTION 'a repeated profile refresh should not rewrite unchanged rows'; END IF;
    END $$;

    UPDATE player_stat SET goals=9, minutes=600 WHERE id='profile-current-stat-${team}';
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    DO $$ BEGIN
      IF (SELECT goals FROM team_roster WHERE team_id='${team}' AND player_id='${playerMulti}' AND championship_id='${currentChamp}') <> 9
        OR (SELECT minutes FROM team_roster WHERE team_id='${team}' AND player_id='${playerMulti}' AND championship_id='${currentChamp}') <> 600
        THEN RAISE EXCEPTION 'counter changes should refresh the copied roster stats'; END IF;
    END $$;

    -- Reparenting a stat-only player must remove it from the old team and add
    -- it to the new team in the same worker pass.
    UPDATE player_stat SET team_id='${otherTeam}' WHERE id='profile-stat-only-${team}';
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_roster WHERE team_id='${team}' AND player_id='${playerStatOnly}')
        OR NOT EXISTS (SELECT 1 FROM team_roster WHERE team_id='${otherTeam}' AND player_id='${playerStatOnly}')
        OR EXISTS (SELECT 1 FROM team_player_history WHERE team_id='${team}' AND player_id='${playerStatOnly}')
        OR NOT EXISTS (SELECT 1 FROM team_player_history WHERE team_id='${otherTeam}' AND player_id='${playerStatOnly}')
        THEN RAISE EXCEPTION 'reparenting a player stat should refresh both team scopes'; END IF;
    END $$;

    -- Removing the last source association should prune the team’s past-only
    -- player rows as well as its roster rows.
    DELETE FROM team_player WHERE team_id='${team}' AND player_id='${playerPast}';
    DELETE FROM player_stat WHERE id='profile-past-stat-${team}';
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_roster WHERE team_id='${team}' AND player_id='${playerPast}')
        OR EXISTS (SELECT 1 FROM team_player_history WHERE team_id='${team}' AND player_id='${playerPast}')
        THEN RAISE EXCEPTION 'deleted source associations should remove stale roster and history rows'; END IF;
    END $$;

    SET LOCAL ROLE service;
    DO $$ BEGIN PERFORM refresh_team_profiles(1); END $$;
    RESET ROLE;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT count(*) FROM team_roster WHERE team_id='${team}') < 1
        THEN RAISE EXCEPTION 'app users should read public team profile rows'; END IF;
      UPDATE team_roster SET goals=999 WHERE team_id='${team}';
      IF FOUND THEN RAISE EXCEPTION 'app users must not write pipeline-owned profile rows'; END IF;
    END $$;
    RESET ROLE;
    DO $$ BEGIN
      IF NOT has_function_privilege('service','refresh_team_profiles(integer)','EXECUTE')
        OR has_function_privilege('anon','refresh_team_profiles(integer)','EXECUTE')
        OR has_function_privilege('app_user','refresh_team_profiles(integer)','EXECUTE')
        THEN RAISE EXCEPTION 'only the service role should execute the profile refresh'; END IF;
      IF (SELECT count(*) FROM pg_publication_tables WHERE pubname='electric_publication_default'
          AND tablename IN ('team_championship','team_roster','team_player_history')) <> 3
        THEN RAISE EXCEPTION 'profile projections should be available to Electric readers'; END IF;
    END $$;
    ROLLBACK;`);

  assertEquals(output, "");
});

Deno.test("team profile refresh preserves a newer revision queued during an older pass", async () => {
  // This concurrency check commits a short-lived fixture because two database
  // sessions must overlap. Cleanup runs even if the worker assertion fails.
  const team = uuid();
  const player = uuid();
  const championship = uuid();
  const teamRow = q(team);
  const playerRow = q(player);
  const championshipRow = q(championship);
  let lockSession: {
    child: Deno.ChildProcess;
    done: Promise<Deno.CommandOutput>;
    send: (sql: string) => Promise<void>;
    close: () => Promise<void>;
  } | undefined;
  let workerSession: { child: Deno.ChildProcess; done: Promise<Deno.CommandOutput> } | undefined;

  const spawnSql = async (sql: string, appName?: string, keepStdinOpen = false) => {
    const child = new Deno.Command("docker", {
      args: [
        "compose", "-p", project, "exec", "-T",
        "golaberto-database",
        "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1",
        "-qAt",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    const done = child.output();
    const namedSql = appName ? `SET application_name=${q(appName)};\n${sql}` : sql;
    await writer.write(new TextEncoder().encode(namedSql));
    const send = async (next: string) => await writer.write(new TextEncoder().encode(next));
    const close = async () => await writer.close();
    if (!keepStdinOpen) await close();
    return { child, done, send, close };
  };

  try {
    await psql(`BEGIN;
      INSERT INTO team (id,name,country) VALUES (${teamRow},'Profile Revision Fixture','Brasil');
      INSERT INTO player (id,name,position) VALUES (${playerRow},'Revision Player','fw');
      INSERT INTO championship (id,name,region_name,begins,ends) VALUES (${championshipRow},'Revision Cup','Brasil',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1,
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1);
      INSERT INTO team_player (team_id,championship_id,player_id) VALUES (${teamRow},${championshipRow},${playerRow});
      INSERT INTO player_stat (id,championship_id,team_id,player_id,player_name,position,
        played,started,came_on,bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name)
      VALUES ('profile-revision-stat-${team}',${championshipRow},${teamRow},${playerRow},'Revision Player','fw',
        1,1,0,0,90,0,0,0,0,0,'Revision Cup','Profile Revision Fixture');
      DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
      COMMIT;`);

    lockSession = await spawnSql(`BEGIN;
      SELECT id FROM team_roster WHERE team_id=${teamRow} AND player_id=${playerRow} FOR UPDATE;
      `, `team-profile-lock-${team.slice(0, 8)}`, true);

    // Wait until the lock session owns the projection row before changing the
    // source name. That source trigger queues the revision the worker will read.
    await psql(`DO $$ DECLARE ready boolean := false; BEGIN
      FOR attempt IN 1..100 LOOP
        PERFORM pg_stat_clear_snapshot();
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE application_name='team-profile-lock-${team.slice(0, 8)}'
            AND query LIKE 'SELECT id FROM team_roster%'
            AND state='idle in transaction' AND xact_start IS NOT NULL) INTO ready;
        EXIT WHEN ready;
        PERFORM pg_sleep(0.05);
      END LOOP;
      IF NOT ready THEN RAISE EXCEPTION 'projection lock session did not start'; END IF;
    END $$;`);

    await psql(`UPDATE player SET name='Revision Player Updated' WHERE id=${playerRow};`);
    const worker = await spawnSql(`DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`, `team-profile-worker-${team.slice(0, 8)}`);
    workerSession = worker;

    await psql(`DO $$ DECLARE blocked boolean := false; BEGIN
      FOR attempt IN 1..100 LOOP
        PERFORM pg_stat_clear_snapshot();
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE application_name='team-profile-worker-${team.slice(0, 8)}'
            AND wait_event_type='Lock') INTO blocked;
        EXIT WHEN blocked;
        PERFORM pg_sleep(0.05);
      END LOOP;
      IF NOT blocked THEN RAISE EXCEPTION 'refresh worker did not wait on held roster row'; END IF;
    END $$;`);

    await psql(`DO $$ BEGIN PERFORM enqueue_team_profile(${teamRow}); END $$;`);
    // Release the row; the worker's compare-and-delete must retain the newer
    // queue revision for its next bounded pass.
    await lockSession.send("COMMIT;\n");
    await lockSession.close();
    await lockSession.done;
    lockSession = undefined;
    const workerResult = await worker.done;
    const workerError = new TextDecoder().decode(workerResult.stderr);
    assert(workerResult.success, workerError);
    workerSession = undefined;

    const retained = await psql(`SELECT count(*) FROM team_profile_dirty WHERE team_id=${teamRow};`);
    assertEquals(retained, "1");
    await psql(`DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`);
    assertEquals(await psql(`SELECT count(*) FROM team_profile_dirty WHERE team_id=${teamRow};`), "0");
  } finally {
    if (lockSession) {
      try {
        await lockSession.send("ROLLBACK;\n");
        await lockSession.close();
      } catch {
        lockSession.child.kill("SIGTERM");
      }
      await lockSession.done.catch(() => undefined);
    }
    if (workerSession) await workerSession.done.catch(() => undefined);
    await psql(`BEGIN;
      DELETE FROM team WHERE id=${teamRow};
      DELETE FROM championship WHERE id=${championshipRow};
      DELETE FROM player WHERE id=${playerRow};
      COMMIT;
      DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`).catch(() => undefined);
  }
  assertEquals(await psql(`SELECT count(*) FROM team WHERE id=${teamRow};`), "0");
});

Deno.test("team profile queue drains in indexed revision order", async () => {
  const output = await psql(`BEGIN;
    INSERT INTO team_profile_dirty (team_id, revision)
    SELECT gen_random_uuid(), revision FROM generate_series(1, 1000) AS rows(revision);
    SET LOCAL enable_seqscan=off;
    SET LOCAL enable_bitmapscan=off;
    EXPLAIN (FORMAT JSON)
      SELECT team_id, revision FROM team_profile_dirty ORDER BY revision, team_id LIMIT 50;
    ROLLBACK;`);
  const plan = JSON.parse(output) as Array<{ Plan: Record<string, unknown> }>;
  const indexes: string[] = [];
  const visit = (node: Record<string, unknown>) => {
    if (typeof node["Index Name"] === "string") indexes.push(node["Index Name"] as string);
    for (const child of (node["Plans"] as Record<string, unknown>[] | undefined) ?? []) visit(child);
  };
  visit(plan[0].Plan);
  assert(
    indexes.includes("team_profile_dirty_revision_team_idx"),
    `queue drain should use the revision-order index; planner used ${indexes.join(", ") || "no index"}`,
  );
});

Deno.test("reversed game updates queue team profiles in one order and both transactions commit", async () => {
  const [lowTeam, highTeam] = [uuid(), uuid()].sort();
  const championship = uuid();
  const phase = uuid();
  const orderedGame = uuid();
  const reverseGame = uuid();
  const companionGame = uuid();
  const tag = uuid().replaceAll("-", "").slice(0, 8);
  const appA = `team-profile-reverse-a-${tag}`;
  const appB = `team-profile-reverse-b-${tag}`;
  const teamRows = `${q(lowTeam)},${q(highTeam)}`;
  const orderedGameRow = q(orderedGame);
  const reverseGameRow = q(reverseGame);
  const companionGameRow = q(companionGame);
  const championshipRow = q(championship);

  const spawnSql = async (sql: string, appName: string) => {
    const child = new Deno.Command("docker", {
      args: [
        "compose", "-p", project, "exec", "-T", "golaberto-database",
        "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1",
        "-qAt",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    const done = child.output();
    await writer.write(new TextEncoder().encode(`SET application_name=${q(appName)};\n${sql}`));
    await writer.close();
    return { child, done };
  };

  let updateA: Awaited<ReturnType<typeof spawnSql>> | undefined;
  let updateB: Awaited<ReturnType<typeof spawnSql>> | undefined;

  try {
    await psql(`BEGIN;
      INSERT INTO team (id,name,country) VALUES
        (${q(lowTeam)},'Profile Order Low','Brasil'),(${q(highTeam)},'Profile Order High','Brasil');
      INSERT INTO championship (id,name,region_name,begins,ends) VALUES (${championshipRow},'Profile Order Cup','Brasil',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1,
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1);
      INSERT INTO phase (id,championship_id,name) VALUES (${q(phase)},${championshipRow},'Order phase');
      INSERT INTO game (id,phase_id,day,home_id,away_id) VALUES
        (${orderedGameRow},${q(phase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date,${q(highTeam)},${q(lowTeam)}),
        (${reverseGameRow},${q(phase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date,${q(lowTeam)},${q(highTeam)}),
        (${companionGameRow},${q(phase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date,${q(highTeam)},${q(lowTeam)});
      DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
      COMMIT;`);

    // Updating the first fixture reverses its old high/low side order. The
    // assigned queue revisions expose trigger acquisition order directly.
    const revisions = await psql(`BEGIN;
      UPDATE game SET home_id=${q(lowTeam)},away_id=${q(highTeam)} WHERE id=${orderedGameRow};
      SELECT json_build_object(
        'low',(SELECT revision FROM team_profile_dirty WHERE team_id=${q(lowTeam)}),
        'high',(SELECT revision FROM team_profile_dirty WHERE team_id=${q(highTeam)}));
      COMMIT;`);
    const order = JSON.parse(revisions) as { low: number; high: number };
    assert(
      order.low < order.high,
      `a reversed high-home/low-away fixture should enqueue low first; got low=${order.low}, high=${order.high}`,
    );
    await psql(`DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`);
    assertEquals(await psql(`SELECT count(*) FROM team_profile_dirty WHERE team_id IN (${teamRows});`), "0");

    // Launch both source updates together and hold each transaction briefly
    // before its trigger runs so their reversed team order overlaps.
    [updateA, updateB] = await Promise.all([
      spawnSql(`BEGIN;
      SELECT pg_sleep(0.25);
      UPDATE game SET home_id=${q(highTeam)},away_id=${q(lowTeam)} WHERE id=${reverseGameRow};
      COMMIT;`, appA),
      spawnSql(`BEGIN;
      SELECT pg_sleep(0.25);
      UPDATE game SET home_id=${q(lowTeam)},away_id=${q(highTeam)} WHERE id=${companionGameRow};
      COMMIT;`, appB),
    ]);

    const [resultA, resultB] = await Promise.all([updateA.done, updateB.done]);
    assert(resultA.success, `first reversed game update failed: ${new TextDecoder().decode(resultA.stderr)}`);
    assert(resultB.success, `second reversed game update failed: ${new TextDecoder().decode(resultB.stderr)}`);
    updateA = undefined;
    updateB = undefined;
    assertEquals(await psql(`SELECT count(*) FROM team_profile_dirty WHERE team_id IN (${teamRows});`), "2");
    await psql(`DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`);
    assertEquals(await psql(`SELECT count(*) FROM team_profile_dirty WHERE team_id IN (${teamRows});`), "0");
    assertEquals(
      await psql(`SELECT count(*) FROM team_championship WHERE team_id IN (${teamRows}) AND championship_id=${championshipRow};`),
      "2",
    );
  } finally {
    await Promise.all([updateA, updateB]
      .filter((session) => session !== undefined)
      .map((session) => session!.done.catch(() => undefined)));
    await psql(`BEGIN;
      DELETE FROM team WHERE id IN (${teamRows});
      DELETE FROM championship WHERE id=${championshipRow};
      COMMIT;
      DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;`).catch(() => undefined);
  }
  assertEquals(await psql(`SELECT count(*) FROM team WHERE id IN (${teamRows});`), "0");
});
