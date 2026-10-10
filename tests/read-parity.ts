import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { query, replayLock } from "./db.ts";

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Cond"?: string;
  "Index Name"?: string;
  "Subplan Name"?: string;
  "Actual Loops": number;
  "Actual Rows": number;
  Plans?: Plan[];
};
const nodes = (
  plan: Plan,
): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

const total = (predicate: string, group = "championship_id") =>
  `SELECT ${group} AS id,count(*)::integer AS rows,
  sum(played) AS played,sum(started) AS started,sum(came_on) AS came_on,sum(bench) AS bench,
  sum(minutes) AS minutes,sum(goals) AS goals,sum(penalties) AS penalties,sum(own_goals) AS own_goals,
  sum(yellow) AS yellow,sum(red) AS red,sum(off_rating) AS off_rating,sum(def_rating) AS def_rating,
  sum(contribution) AS contribution,sum(contribution)*90/nullif(sum(minutes),0) AS contribution_per90
  FROM player_stat WHERE ${predicate} GROUP BY ${group}`;

Deno.test("parity reads preserve scoped goals, bench rows, filters and missing attendance", async () => {
  const [
    team,
    otherTeam,
    player,
    bench,
    zero,
    category,
    champ,
    otherChamp,
    phase,
    otherPhase,
    game,
    upcoming,
    otherGame,
  ] = Array.from({ length: 13 }, () => crypto.randomUUID());
  const appearance =
    `SELECT * FROM player_appearance WHERE player_id='${player}'
    AND championship_id='${champ}' AND team_id='${team}' ORDER BY day DESC,id LIMIT 40`;
  const directory = `SELECT * FROM player_directory WHERE slug='read-${player}'
    AND search_key LIKE '%read socrates%' AND position_key='cm' AND region_id='south_america'
    ORDER BY rating DESC NULLS LAST,name,id LIMIT 40`;
  const directoryPage =
    `SELECT * FROM player_directory WHERE search_key LIKE '%' AND country_search_key LIKE '%'
    AND region_id LIKE '%' AND position_key LIKE '%' ORDER BY rating DESC NULLS LAST,name,id LIMIT 40`;
  const season =
    `SELECT s.*,p.slug AS player_slug,t.slug AS team_slug,c.slug AS championship_slug
    FROM player_stat s JOIN player p ON p.id=s.player_id JOIN team t ON t.id=s.team_id
    JOIN championship c ON c.id=s.championship_id WHERE p.slug='read-${player}'
    AND c.slug='read-${champ}' AND t.slug='read-${team}' ORDER BY s.minutes DESC,s.id LIMIT 40`;
  const output = await query(`BEGIN;
    INSERT INTO category(id,name) VALUES ('${category}','Read parity category');
    INSERT INTO team(id,name,country,slug) VALUES ('${team}','Read Alpha','Brasil','read-${team}'),('${otherTeam}','Read Beta','Brasil','read-${otherTeam}');
    INSERT INTO player(id,name,full_name,country,position,slug) VALUES
      ('${player}','Read Sócrates','Número Completo','Brasil','cm','read-${player}'),
      ('${bench}','Read Bench',NULL,'Brasil','g','read-${bench}'),('${zero}','Read Zero',NULL,'Brasil','fw','read-${zero}');
    INSERT INTO player_rating(id,rating,off_rating,def_rating) VALUES ('${player}',7,0.7,0.3);
    INSERT INTO championship(id,name,category_id,region_name,begins,ends,slug) VALUES
      ('${champ}','Read parity season','${category}','Brasil','2026-01-01','2026-12-31','read-${champ}'),
      ('${otherChamp}','Read parity professional',NULL,'Brasil','2025-01-01','2025-12-31','read-${otherChamp}');
    INSERT INTO phase(id,championship_id,name) VALUES
      ('${phase}','${champ}','Read phase'),('${otherPhase}','${otherChamp}','Read other phase');
    INSERT INTO game(id,phase_id,round,day,home_id,away_id,played,home_score,away_score,attendance) VALUES
      ('${game}','${phase}',3,'2026-01-07','${team}','${otherTeam}',true,1,1,0),
      ('${upcoming}','${phase}',4,'2026-01-14','${team}','${otherTeam}',false,NULL,NULL,NULL),
      ('${otherGame}','${otherPhase}',2,'2025-12-01','${otherTeam}','${team}',true,0,0,100);
    INSERT INTO player_game(game_id,player_id,side,on_minute,off_minute,bench,off_rating,def_rating) VALUES
      ('${game}','${player}','home',0,90,false,2,-0.5),
      ('${upcoming}','${player}','home',0,NULL,false,NULL,NULL),
      ('${game}','${bench}','home',0,NULL,true,NULL,NULL),
      ('${otherGame}','${player}','away',0,90,false,1,1);
    INSERT INTO goal(game_id,player_id,side,minute,penalty,own_goal) VALUES
      ('${game}','${player}','home',17,true,false),('${game}','${player}','away',50,false,true);
    INSERT INTO goal(game_id,player_id,side) SELECT '${otherGame}','${bench}','home' FROM generate_series(1,1000);
    INSERT INTO player_stat(id,championship_id,team_id,player_id,player_name,position,played,started,came_on,
      bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name,off_rating,def_rating,
      contribution,contribution_per90,goals_per90) VALUES
      ('${champ}:${team}:${player}','${champ}','${team}','${player}','stale player','cm',1,1,0,0,90,1,1,1,0,0,'stale season','stale team',2,-0.5,1.5,1.5,1),
      ('${champ}:${team}:${bench}','${champ}','${team}','${bench}','Read Bench','g',0,0,0,1,0,0,0,0,0,0,'stale season','stale team',NULL,NULL,NULL,NULL,NULL),
      ('${champ}:${otherTeam}:${zero}','${champ}','${otherTeam}','${zero}','Read Zero','fw',1,1,0,0,0,0,0,0,0,0,'stale season','stale team',NULL,NULL,NULL,NULL,NULL),
      ('${otherChamp}:${team}:${player}','${otherChamp}','${team}','${player}','stale player','cm',1,1,0,0,90,0,0,0,0,0,'stale season','stale team',1,1,2,2,0);
    INSERT INTO player_stat(id,championship_id,team_id,player_id,player_name,position,played,started,came_on,
      bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name)
    SELECT '${otherChamp}:${otherTeam}:'||id,'${otherChamp}','${otherTeam}',id,name,coalesce(position,''),
      1,1,0,0,90,0,0,0,0,0,'Other season','Other team'
    FROM player WHERE id NOT IN ('${player}','${bench}','${zero}') ORDER BY id LIMIT 1000;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT count(*) FROM player_directory WHERE id='${player}' AND search_key LIKE '%numero completo%'
          AND country_id='br' AND region_id='south_america' AND position_key='cm' AND rating=7
          AND off_rating=0.7 AND def_rating=0.3
          AND latest_team_id='${team}')<>1
        THEN RAISE EXCEPTION 'directory must search the full name and join rating, geography and latest club'; END IF;
      IF (SELECT goals||':'||penalties||':'||own_goals||':'||minutes||':'||contribution FROM player_appearance
          WHERE player_id='${player}' AND game_id='${game}') IS DISTINCT FROM '1:1:1:90:1.5'
        THEN RAISE EXCEPTION 'own goals must remain separate from goals and penalties without multiplying contributions'; END IF;
      IF (SELECT minutes FROM player_appearance WHERE player_id='${player}' AND game_id='${upcoming}') IS DISTINCT FROM 0
        OR (SELECT minutes FROM player_appearance WHERE player_id='${bench}' AND game_id='${game}') IS DISTINCT FROM 0
        OR EXISTS (SELECT 1 FROM player_appearance WHERE (player_id='${bench}' OR game_id='${upcoming}') AND (contribution_per90 IS NOT NULL OR goals_per90 IS NOT NULL))
        THEN RAISE EXCEPTION 'zero-minute and unused-bench appearances must retain undefined per90 metrics'; END IF;
      IF (SELECT count(*) FROM (${appearance}) selected)<>2
        OR (SELECT count(*) FROM player_appearance WHERE player_id='${player}' AND played=true AND category_id='${category}')<>1
        THEN RAISE EXCEPTION 'team, championship, category and played filters must select the requested history'; END IF;
      IF (SELECT p.name||':'||t.name FROM player_stat s JOIN player p ON p.id=s.player_id JOIN team t ON t.id=s.team_id
          WHERE s.player_id='${player}' AND s.championship_id='${champ}')
          IS DISTINCT FROM 'Read Sócrates:Read Alpha'
        THEN RAISE EXCEPTION 'read names must reflect source entities instead of stale projections'; END IF;
      IF (SELECT rows||':'||minutes||':'||goals||':'||contribution FROM (${
    total(
      `championship_id='${champ}' AND search_key LIKE '%read socrates%' AND minutes>=1`,
    )
  }) aggregate)
          IS DISTINCT FROM '1:90:1:1.5'
        OR (SELECT rows||':'||bench FROM (${
    total(`championship_id='${champ}' AND team_id='${team}' AND minutes>=0`)
  }) aggregate) IS DISTINCT FROM '2:1'
        OR (SELECT rows||':'||minutes FROM (${
    total(`player_id='${player}' AND minutes>=0`, "player_id")
  }) aggregate) IS DISTINCT FROM '2:180'
        OR (SELECT rows||':'||minutes FROM (${
    total(
      `player_id='${player}' AND championship_id IN (SELECT id FROM championship WHERE category_id='${category}')`,
      "player_id",
    )
  }) aggregate) IS DISTINCT FROM '1:90'
        OR (SELECT rows||':'||minutes FROM (${
    total(
      `player_id='${player}' AND championship_id IN (SELECT id FROM championship WHERE category_id IS NULL)`,
      "player_id",
    )
  }) aggregate) IS DISTINCT FROM '1:90'
        OR (SELECT contribution_per90 FROM (${
    total(`player_id='${player}'`, "player_id")
  }) aggregate) IS DISTINCT FROM 1.75
        THEN RAISE EXCEPTION 'grouped totals must apply search, minimum minutes and scope before summing and limiting'; END IF;
      IF (SELECT rows||':'||minutes||':'||goals FROM (${
    total(
      `championship_id='${champ}' AND search_key LIKE '%NuMeRo CoMpLeTo%' AND minutes>=1`,
    )
  }) aggregate) IS DISTINCT FROM '1:90:1'
        OR (SELECT count(*) FROM player_stat WHERE search_key LIKE '%numero completo%')<>2
        THEN RAISE EXCEPTION 'full-name search must fold case and accents before scoped totals'; END IF;
      IF EXISTS (SELECT 1 FROM (${
    total(`championship_id='${champ}' AND search_key LIKE '%absent%'`)
  }) aggregate)
        OR (SELECT minutes FROM (${
    total(`player_id='${zero}'`, "player_id")
  }) aggregate) IS DISTINCT FROM 0
        OR (SELECT contribution_per90 FROM (${
    total(`player_id='${zero}'`, "player_id")
  }) aggregate) IS NOT NULL
        THEN RAISE EXCEPTION 'empty groups and zero-minute totals must not invent values or divide by zero'; END IF;
      IF (SELECT games||':'||attendance_count||':'||total||':'||average||':'||minimum||':'||maximum
          FROM championship_attendance WHERE championship_id='${champ}' AND team_id='${team}') IS DISTINCT FROM '2:1:0:0:0:0'
        THEN RAISE EXCEPTION 'missing attendance must be excluded while known zero attendance is retained'; END IF;
      IF (SELECT count(*) FROM game_archive WHERE championship_id='${champ}' AND category_id='${category}'
          AND week='2026-01-05' AND round=3)<>1
        OR (SELECT category_key FROM game_archive WHERE id='${otherGame}') IS DISTINCT FROM 'professional'
        THEN RAISE EXCEPTION 'archive filters must preserve category, ISO week, round and professional category'; END IF;
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('player_directory','player_appearance','game_archive','championship_attendance')
          AND relkind<>'v')
        OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename IN ('player_directory','player_appearance','game_archive','championship_attendance'))
        OR has_table_privilege('app_user','player_directory','INSERT')
        THEN RAISE EXCEPTION 'request reads must have no writable storage or CDC publication'; END IF;
    END $$;
    RESET ROLE;
    UPDATE player SET name='Edited Player',full_name='Edited Bíography',position='fw' WHERE id='${player}';
    UPDATE team SET name='Edited Club' WHERE id='${team}';
    UPDATE championship SET name='Edited Tournament' WHERE id='${champ}';
    UPDATE game SET attendance=12 WHERE id='${game}';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM player_stat WHERE player_id='${player}' AND (player_name<>'Edited Player' OR position<>'fw'))
        OR EXISTS (SELECT 1 FROM player_stat WHERE team_id='${team}' AND team_name<>'Edited Club')
        OR EXISTS (SELECT 1 FROM player_stat s JOIN championship c ON c.id=s.championship_id WHERE s.championship_id='${champ}' AND s.championship_name<>c.full_name)
        OR EXISTS (SELECT 1 FROM player_stat WHERE search_key LIKE '%stale%' OR search_key LIKE '%read socrates%' OR search_key LIKE '%read alpha%')
        OR (SELECT full_name FROM player_directory WHERE id='${player}') IS DISTINCT FROM 'Edited Bíography'
        OR (SELECT average FROM championship_attendance WHERE championship_id='${champ}' AND team_id='${team}') IS DISTINCT FROM 12
        THEN RAISE EXCEPTION 'source corrections must be visible on the next read'; END IF;
      IF EXISTS (SELECT 1 FROM player_stat WHERE search_key LIKE '%numero completo%')
        OR (SELECT count(*) FROM player_stat WHERE search_key LIKE '%EDITED biography%')<>2
        OR (SELECT rows||':'||minutes||':'||goals FROM (${
    total(
      `championship_id='${champ}' AND search_key LIKE '%edited biography%' AND minutes>=1`,
    )
  }) aggregate) IS DISTINCT FROM '1:90:1'
        OR (SELECT rows||':'||minutes FROM (${
    total(`search_key LIKE '%edited biography%'`, "player_id")
  }) aggregate) IS DISTINCT FROM '2:180'
        THEN RAISE EXCEPTION 'a full-name edit must invalidate only its player seasons without changing filtered sums'; END IF;
    END $$;
    RESET ROLE;
    UPDATE player_stat SET player_name='Updated display',team_name='Updated club',
      championship_name='Updated tournament',position='fw'
      WHERE id='${champ}:${team}:${player}';
    DO $$ BEGIN
      IF (SELECT count(*) FROM player_stat WHERE championship_id='${champ}'
        AND player_name='Edited Player' AND team_name='Edited Club' AND search_key LIKE '%edited tournament%fw edited biography%')<>1
        THEN RAISE EXCEPTION 'stale pipeline writes must retain current source names and position'; END IF;
    END $$;
    -- A setting, not a temp table: pgroll records DDL in its ledger, and
    -- concurrent checks recording against one parent collide.
    SET LOCAL golaberto.parity_plans = '{}';
    SET LOCAL ROLE app_user;
    DO $$ DECLARE plan jsonb; BEGIN
      ${
    Object.entries({ appearance, directory, directoryPage, season }).map((
      [name, sql],
    ) =>
      `EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) ${
        sql.replaceAll("'", "''")
      }' INTO plan;
      PERFORM set_config('golaberto.parity_plans',
        (current_setting('golaberto.parity_plans')::jsonb || jsonb_build_object('${name}',plan->0->'Plan'))::text,true);`
    ).join("\n      ")
  }
    END $$;
    RESET ROLE;
    SELECT current_setting('golaberto.parity_plans');
    ROLLBACK;`);
  const plans: Record<string, Plan> = JSON.parse(output);
  const plan = plans.appearance;
  const goalScans = nodes(plan).filter((node) =>
    node["Relation Name"] === "goal"
  );
  assertEquals(goalScans.length, 1);
  assert(
    goalScans[0]["Actual Loops"] <= 2,
    "count goals only for requested appearances",
  );
  assert(
    goalScans[0]["Actual Rows"] <= 2,
    "unrequested goals must not enter appearance aggregates",
  );
  assert(
    nodes(plan).some((node) =>
      node["Index Cond"]?.includes("player_id") &&
      node["Index Cond"]?.includes("game_id")
    ),
    "goal lookup must constrain both the selected player and game",
  );
  for (const name of ["directory", "directoryPage"]) {
    const scans = nodes(plans[name]).filter((node) =>
      node["Relation Name"] === "player_game"
    );
    // One latest-club lookup per field read (id, name, slug, logo), each run
    // after the page limit; a lateral join would run before it, per player.
    assertEquals(scans.length, 4);
    for (const scan of scans) {
      assertEquals(scan["Index Name"], "player_game_latest_read_idx");
      assert(scan["Index Cond"]?.includes("player_id"));
      assert(
        scan["Actual Loops"] <= (name === "directory" ? 1 : 40),
        "latest club lookups must follow the filtered page limit",
      );
    }
    const latest = nodes(plans[name]).filter((node) =>
      node["Node Type"] === "Limit" && node["Subplan Name"] &&
      nodes(node).some((child) => child["Relation Name"] === "player_game")
    );
    assertEquals(latest.length, 4);
    assert(
      latest.every((node) => node["Actual Rows"] <= 1),
      "retain only the latest eligible club after checking scheduled and national appearances",
    );
  }
  const statScans = nodes(plans.season).filter((node) =>
    node["Relation Name"] === "player_stat"
  );
  assertEquals(statScans.length, 1);
  assertEquals(statScans[0]["Actual Loops"], 1);
  assert(
    statScans[0]["Actual Rows"] <= 3,
    "unrelated seasons must not enter the scoped statistic join",
  );
  assert(
    ["player_id", "championship_id", "team_id"].some((scope) =>
      statScans[0]["Index Cond"]?.includes(scope)
    ),
    "slug owners must constrain the statistic scan before unrelated seasons join",
  );
});

Deno.test("latest club excludes newer national and scheduled appearances", async () => {
  const [
    club,
    nextClub,
    national,
    player,
    scheduledOnly,
    champ,
    phase,
    older,
    newer,
    scheduled,
  ] = Array.from({ length: 10 }, () => crypto.randomUUID());
  await query(`BEGIN;
    INSERT INTO team(id,name,team_type,country) VALUES
      ('${club}','Completed club','club','Brasil'),('${nextClub}','Scheduled club','club','Brasil'),
      ('${national}','National selection','national','Brasil');
    INSERT INTO player(id,name,country) VALUES
      ('${player}','Club history','Brasil'),('${scheduledOnly}','No completed club','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends)
      VALUES ('${champ}','Club history season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Club history phase');
    INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score) VALUES
      ('${older}','${phase}','2026-01-01','${club}','${national}',true,0,0),
      ('${newer}','${phase}','2026-02-01','${national}','${club}',true,0,0),
      ('${scheduled}','${phase}','2026-03-01','${nextClub}','${club}',false,NULL,NULL);
    INSERT INTO player_game(game_id,player_id,side,on_minute,off_minute) VALUES
      ('${older}','${player}','home',0,90),('${newer}','${player}','home',0,90),
      ('${scheduled}','${player}','home',0,NULL),('${newer}','${scheduledOnly}','home',0,90),
      ('${scheduled}','${scheduledOnly}','home',0,NULL);
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT latest_team_id FROM player_directory WHERE id='${player}') IS DISTINCT FROM '${club}'::uuid
        OR (SELECT latest_team_id FROM player_directory WHERE id='${scheduledOnly}') IS NOT NULL
        THEN RAISE EXCEPTION 'only completed club appearances may identify the latest club'; END IF;
    END $$;
    RESET ROLE;
    UPDATE game SET played=true,home_score=0,away_score=0 WHERE id='${scheduled}';
    DO $$ BEGIN
      IF (SELECT latest_team_id FROM player_directory WHERE id='${player}') IS DISTINCT FROM '${nextClub}'::uuid
        THEN RAISE EXCEPTION 'a completed fixture must become the current club'; END IF;
    END $$;
    UPDATE team SET team_type='national' WHERE id='${nextClub}';
    DO $$ BEGIN
      IF (SELECT latest_team_id FROM player_directory WHERE id='${player}') IS DISTINCT FROM '${club}'::uuid
        THEN RAISE EXCEPTION 'a corrected national team must fall back to the completed club'; END IF;
    END $$;
    ROLLBACK;`);
});

Deno.test("generated read placeholders become invoker views and replay without stored rows", async () => {
  const migration = (await Deno.readTextFile(
    new URL("../services/database/sql/035_read_parity.sql", import.meta.url),
  ))
    .replaceAll("\nBEGIN;\n", "\n").replaceAll("\nCOMMIT;\n", "\n");
  const views = [
    "phase_directory",
    "player_appearance",
    "game_archive",
    "player_directory",
    "championship_attendance",
  ];
  assertEquals(
    await query(`BEGIN;${replayLock}
    ${
      // CASCADE rebuilds the world 035 ran in: later migrations' views read
      // these, and they did not exist yet.
      views.map((name) =>
        `DROP VIEW ${name} CASCADE; CREATE TABLE ${name}(id uuid PRIMARY KEY);`
      ).join("\n")
    }
    ${migration}
    ${migration}
    SELECT count(*) FROM pg_class WHERE relname IN (${
      views.map((name) => `'${name}'`).join(",")
    })
      AND relkind='v' AND reloptions @> ARRAY['security_invoker=true'];
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user
        AND rolconfig @> ARRAY['pgrst.db_aggregates_enabled=true'])
        THEN RAISE EXCEPTION 'native aggregate reads must be enabled for the bootstrap database role'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='player_stat'::regclass AND a.attname='search_key' AND a.attgenerated=''
          AND a.attnotnull AND a.attcollation='golaberto_search'::regcollation
          AND pg_get_expr(d.adbin,d.adrelid)='''''::text')
        THEN RAISE EXCEPTION 'live season search must be an ordinary folded non-null string with an empty default'; END IF;
    END $$;
    ROLLBACK;`),
    "5",
  );
  await assertRejects(
    () =>
      query(`BEGIN;${replayLock}
    DROP VIEW player_directory;
    CREATE TABLE player_directory(id uuid PRIMARY KEY);
    INSERT INTO player_directory VALUES (gen_random_uuid());
    ${migration}`),
    Error,
    "read view placeholder player_directory contains rows",
  );
});

Deno.test("phase choices find a championship season beyond forty repeated phase names and reflect source edits", async () => {
  const prefix = `Phase-${crypto.randomUUID()}`;
  const phasePrefix = crypto.randomUUID().slice(0, 24);
  const championships = Array.from({ length: 50 }, () => crypto.randomUUID());
  const phases = championships.map((_, i) =>
    `${phasePrefix}${String(i).padStart(12, "0")}`
  );
  const target = phases.at(-1)!;
  const championship = championships.at(-1)!;
  await query(`BEGIN;
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ${
    championships.map((id, i) =>
      `('${id}','${prefix} Copa Sócrates ıþ','Brasil','${1950 + i}-01-01','${
        1950 + i
      }-12-31')`
    ).join(",")
  };
    INSERT INTO phase(id,championship_id,name) VALUES ${
    phases.map((id, i) => `('${id}','${championships[i]}','${prefix} Final')`)
      .join(",")
  };
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT count(*) FROM phase_directory WHERE name='${prefix} Final')<>50
        OR EXISTS (SELECT 1 FROM (SELECT id FROM phase_directory WHERE name='${prefix} Final' ORDER BY name,id LIMIT 40) page WHERE id='${target}')
        THEN RAISE EXCEPTION 'fixture must put the desired season beyond the first forty identically named phases'; END IF;
      IF (SELECT id FROM (SELECT id FROM phase_directory
          WHERE search_key LIKE '%${prefix} copa socrates ith 1999%' ORDER BY name,id LIMIT 40) page)
          IS DISTINCT FROM '${target}'::uuid
        THEN RAISE EXCEPTION 'championship and season search must select the desired phase before pagination with case, accent and spelling normalization'; END IF;
      IF (SELECT championship_name FROM phase_directory WHERE id='${target}')
          IS DISTINCT FROM 'Brasil - ${prefix} Copa Sócrates ıþ 1999'
        THEN RAISE EXCEPTION 'phase choices must display the same championship season they search'; END IF;
      IF has_table_privilege('app_user','phase_directory','INSERT,UPDATE,DELETE')
        OR EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename='phase_directory')
        THEN RAISE EXCEPTION 'phase choices must remain read-only request-time rows'; END IF;
    END $$;
    SET LOCAL app.scopes='';
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM phase_directory WHERE id='${target}')
        THEN RAISE EXCEPTION 'phase directory must preserve underlying source scope policies'; END IF;
    END $$;
    RESET ROLE;
    UPDATE championship SET name='${prefix} Copa Revisada',begins='2000-01-01',ends='2001-12-31' WHERE id='${championship}';
    UPDATE phase SET name='${prefix} Semifinal' WHERE id='${target}';
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT id FROM phase_directory WHERE search_key LIKE '%${prefix} copa revisada 2000/2001 ${prefix} semifinal%')
          IS DISTINCT FROM '${target}'::uuid
        OR EXISTS (SELECT 1 FROM phase_directory WHERE search_key LIKE '%${prefix} copa socrates ith 1999%')
        THEN RAISE EXCEPTION 'championship name, season and phase edits must appear on the next request without rebuilding a stored join'; END IF;
    END $$;
    ROLLBACK;`);
});
