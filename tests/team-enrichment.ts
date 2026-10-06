// Team enrichment integration fixtures run only in an explicitly disposable stack.
// All rows and projection changes are rolled back at the end of the transaction.
import { assert, assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test|prs)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error(
    "team-enrichment requires an explicit disposable COMPOSE_PROJECT_NAME containing check or test",
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

Deno.test("team enrichment imports, aggregates, samples and refreshes transactionally", async () => {
  const teamA = uuid();
  const teamB = uuid();
  const teamC = uuid();
  const teamD = uuid();
  const teamE = uuid();
  const playerA = uuid();
  const playerB = uuid();
  const deletedTeam = uuid();
  const champ = uuid();
  const champZero = uuid();
  const category = uuid();
  const phase = uuid();
  const group = uuid();
  const phaseBonus = uuid();
  const groupBonus = uuid();
  const oddsGroup = groupBonus;
  const zone = uuid();
  const gameIds = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()].sort();
  const [gAB, gAC, gAD, gBC, gBD, gCD] = gameIds;
  const bonusGame = uuid();
  const user = uuid();
  const otherUser = uuid();
  const teamGame = uuid();
  const metricAppearance = uuid();
  const replacementAppearance = uuid();
  const ratingIds = Array.from({ length: 601 }, () => uuid());

  const output = await psql(`BEGIN;
    INSERT INTO category(id,name) VALUES (${q(category)},'Enrichment category');
    INSERT INTO team(id,name,country) VALUES
      (${q(teamA)},'Enrichment A','Brasil'),(${q(teamB)},'Enrichment B','Brasil'),
      (${q(teamC)},'Enrichment C','Brasil'),(${q(teamD)},'Enrichment D','Brasil'),
      (${q(teamE)},'Enrichment E','Brasil');
    INSERT INTO championship(id,name,category_id,region_name,begins,ends,point_win,point_draw,point_loss)
      VALUES (${q(champ)},'Enrichment season',${q(category)},'Brasil','2026-01-01','2026-12-31',3,1,0),
        (${q(champZero)},'Enrichment zero minutes',${q(category)},'Brasil','2026-01-01','2026-12-31',3,1,0);
    INSERT INTO phase(id,championship_id,name,sort,bonus_points,bonus_points_threshold)
      VALUES (${q(phase)},${q(champ)},'Head-to-head','pt,head,bias,name',0,0),
        (${q(phaseBonus)},${q(champ)},'Bonus','pt,w,gd,gf,bias,name',1,2);
    INSERT INTO stage_group(id,phase_id,name) VALUES
      (${q(group)},${q(phase)},'Tie group'),(${q(groupBonus)},${q(phaseBonus)},'Bonus group');
    INSERT INTO team_group(group_id,team_id,bias) VALUES
      (${q(group)},${q(teamA)},0),(${q(group)},${q(teamB)},0),
      (${q(group)},${q(teamC)},0),(${q(group)},${q(teamD)},0),
      (${q(groupBonus)},${q(teamE)},0),(${q(groupBonus)},${q(teamA)},0);
    INSERT INTO game(id,phase_id,round,day,home_id,away_id,played,home_score,away_score) VALUES
      (${q(gAB)},${q(phase)},1,'2026-01-01',${q(teamA)},${q(teamB)},true,1,0),
      (${q(gAC)},${q(phase)},1,'2026-01-01',${q(teamC)},${q(teamA)},true,1,0),
      (${q(gAD)},${q(phase)},1,'2026-01-01',${q(teamA)},${q(teamD)},true,1,0),
      (${q(gBC)},${q(phase)},1,'2026-01-01',${q(teamB)},${q(teamC)},true,1,0),
      (${q(gBD)},${q(phase)},1,'2026-01-01',${q(teamB)},${q(teamD)},true,1,0),
      (${q(gCD)},${q(phase)},1,'2026-01-01',${q(teamD)},${q(teamC)},true,1,0),
      (${q(bonusGame)},${q(phaseBonus)},1,'2026-01-01',${q(teamE)},${q(teamA)},true,3,0);

    -- Coordinates accept legitimate values and preserve missing coordinates.
    UPDATE team SET latitude=-22.9068,longitude=-43.1729 WHERE id='${teamA}';
    DO $$ BEGIN
      IF (SELECT (latitude::double precision,longitude::double precision) FROM team WHERE id='${teamA}') IS DISTINCT FROM (-22.9068::double precision,-43.1729::double precision)
        OR (SELECT (latitude::double precision,longitude::double precision) FROM team WHERE id='${teamB}') IS DISTINCT FROM (NULL::double precision,NULL::double precision)
        THEN RAISE EXCEPTION 'coordinate values or nulls changed'; END IF;
    END $$;

    INSERT INTO player(id,name,position,country) VALUES
      (${q(playerA)},'Metric Player A','fw','Brasil'),(${q(playerB)},'Metric Player B','fw','Brasil');
    INSERT INTO team_roster(id,team_id,championship_id,player_id,player_name,position,
      played,started,came_on,bench,minutes,goals,penalties,own_goals,yellow,red,
      championship_name,off_rating,def_rating,contribution,contribution_per90,goals_per90)
    VALUES
      ('${champ}:${teamA}:${playerA}',${q(teamA)},${q(champ)},${q(playerA)},'Metric Player A','fw',2,1,1,0,180,2,1,1,1,0,'Enrichment season',1.5,-0.5,1,0.5,1),
      ('${champ}:${teamA}:${playerB}',${q(teamA)},${q(champ)},${q(playerB)},'Metric Player B','fw',1,0,1,1,90,1,0,0,2,1,'Enrichment season',NULL,NULL,NULL,NULL,NULL),
      ('${champZero}:${teamA}:${playerB}',${q(teamA)},${q(champZero)},${q(playerB)},'Metric Player B','fw',0,0,0,0,0,0,0,0,0,0,'Enrichment zero minutes',2,1,3,NULL,NULL);
    INSERT INTO player_stat(id,championship_id,team_id,player_id,player_name,position,played,started,came_on,
      bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name,off_rating,def_rating,
      contribution,contribution_per90,goals_per90)
    VALUES
      ('enrichment-stat-a-${teamA}',${q(champ)},${q(teamA)},${q(playerA)},'Metric Player A','fw',2,1,1,0,180,2,1,1,1,0,'Enrichment season','Enrichment A',1.5,-0.5,1,0.5,1),
      ('enrichment-stat-b-${teamA}',${q(champ)},${q(teamA)},${q(playerB)},'Metric Player B','fw',1,0,1,1,90,1,0,0,2,1,'Enrichment season','Enrichment A',NULL,NULL,NULL,NULL,1),
      ('enrichment-stat-zero-${teamA}',${q(champZero)},${q(teamA)},${q(playerB)},'Metric Player B','fw',0,0,0,0,0,0,0,0,0,0,'Enrichment zero minutes','Enrichment A',2,1,3,NULL,NULL);
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    -- The disposable stack may retain unrelated dirty keys from earlier
    -- exercises. Keep this projection assertion independent of that backlog.
    DELETE FROM team_roster_total_dirty;
    DO $$ BEGIN PERFORM enqueue_team_roster_total('${teamA}'); END $$;
    DO $$ BEGIN PERFORM refresh_team_roster_totals(1); END $$;
    UPDATE team_roster SET goals=1 WHERE id='${champ}:${teamA}:${playerA}';
    UPDATE team_roster SET goals=0 WHERE id='${champ}:${teamA}:${playerB}';
    DO $$ BEGIN
      PERFORM refresh_one_team_roster_total('${teamA}');
      IF abs((SELECT goals_per90 FROM team_roster_total WHERE team_id='${teamA}'
        AND championship_id='${champ}')-90.0/270.0)>0.000001
        THEN RAISE EXCEPTION 'fractional roster goals-per-90 was truncated'; END IF;
    END $$;
    UPDATE team_roster SET goals=2 WHERE id='${champ}:${teamA}:${playerA}';
    UPDATE team_roster SET goals=1 WHERE id='${champ}:${teamA}:${playerB}';
    DO $$ BEGIN PERFORM refresh_one_team_roster_total('${teamA}'); END $$;
    DO $$ BEGIN
      IF (SELECT (played::integer,started::integer,came_on::integer,bench::integer,minutes::integer,
            goals::integer,penalties::integer,own_goals::integer,yellow::integer,red::integer,
            off_rating::double precision,def_rating::double precision,contribution::double precision,contribution_per90::double precision,goals_per90::double precision)
          FROM team_roster_total WHERE team_id='${teamA}' AND championship_id='${champ}')
          IS DISTINCT FROM (3,1,2,1,270,3,1,1,3,1,1.5::double precision,-0.5::double precision,1::double precision,(90.0/270.0)::double precision,1::double precision)
        THEN RAISE EXCEPTION 'all-roster totals must sum recorded values and calculate per-90 from total minutes; got %',
          (SELECT ROW(played::integer,started::integer,came_on::integer,bench::integer,minutes::integer,
            goals::integer,penalties::integer,own_goals::integer,yellow::integer,red::integer,
            off_rating::double precision,def_rating::double precision,contribution::double precision,
            contribution_per90::double precision,goals_per90::double precision)
           FROM team_roster_total WHERE team_id='${teamA}' AND championship_id='${champ}'); END IF;
      IF (SELECT (off_rating::double precision,def_rating::double precision,contribution::double precision,contribution_per90::double precision,goals_per90::double precision)
          FROM team_roster WHERE team_id='${teamA}' AND championship_id='${champ}' AND player_id='${playerA}')
          IS DISTINCT FROM (1.5::double precision,-0.5::double precision,1::double precision,0.5::double precision,1::double precision)
        THEN RAISE EXCEPTION 'the team profile refresh should copy nullable player metrics into the roster'; END IF;
      IF (SELECT (off_rating::double precision,contribution::double precision,contribution_per90::double precision,goals_per90::double precision)
          FROM team_roster_total WHERE team_id='${teamA}' AND championship_id='${champZero}')
          IS DISTINCT FROM (2::double precision,3::double precision,NULL::double precision,NULL::double precision)
        THEN RAISE EXCEPTION 'zero-minute per-90 metrics must remain undefined'; END IF;
    END $$;

    DELETE FROM player_metric_dirty;
    DELETE FROM team_profile_dirty;
    INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute,bench,yellow,red)
      VALUES ('${metricAppearance}','${gAB}','${playerA}','home',0,90,false,false,false);
    UPDATE player_game SET off_rating=2 WHERE id='${metricAppearance}';
    UPDATE player_game SET def_rating=-0.5 WHERE id='${metricAppearance}';
    DO $$ BEGIN
      IF (SELECT count(*) FROM player_metric_dirty WHERE player_id='${playerA}' AND championship_id='${champ}')<>1
        THEN RAISE EXCEPTION 'appearance metric updates must coalesce by player and season'; END IF;
      PERFORM refresh_player_metric_queue(1);
      IF (SELECT contribution FROM player_stat WHERE id='enrichment-stat-a-${teamA}') IS DISTINCT FROM 1.5::double precision
        OR (SELECT contribution FROM team_roster WHERE id='${champ}:${teamA}:${playerA}') IS DISTINCT FROM 1.5::double precision
        OR EXISTS (SELECT 1 FROM player_metric_dirty WHERE player_id='${playerA}')
        OR EXISTS (SELECT 1 FROM team_profile_dirty WHERE team_id='${teamA}')
        THEN RAISE EXCEPTION 'metric queue must converge roster metrics without a full profile recount'; END IF;
      IF refresh_player_metric_queue(1)<>0 THEN RAISE EXCEPTION 'metric replay must remain drained'; END IF;
    END $$;

    UPDATE player_game SET off_rating=NULL WHERE id='${metricAppearance}';
    DO $$ BEGIN
      PERFORM refresh_player_metric_queue(1);
      IF (SELECT (off_rating::double precision,def_rating::double precision,contribution::double precision)
        FROM player_stat WHERE id='enrichment-stat-a-${teamA}')
        IS DISTINCT FROM (NULL::double precision,-0.5::double precision,-0.5::double precision)
        THEN RAISE EXCEPTION 'cleared offense must recompute from the remaining defense'; END IF;
    END $$;
    UPDATE player_game SET def_rating=NULL WHERE id='${metricAppearance}';
    DO $$ BEGIN
      PERFORM refresh_player_metric_queue(1);
      IF (SELECT contribution FROM team_roster WHERE id='${champ}:${teamA}:${playerA}') IS NOT NULL
        THEN RAISE EXCEPTION 'cleared ratings must remove stale roster contributions'; END IF;
    END $$;
    UPDATE player_game SET off_rating=2,def_rating=-0.5 WHERE id='${metricAppearance}';
    DO $$ BEGIN PERFORM refresh_player_metric_queue(1); END $$;
    DELETE FROM player_game WHERE id='${metricAppearance}';
    INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute,bench,yellow,red,off_rating,def_rating)
      VALUES ('${replacementAppearance}','${gAB}','${playerA}','home',0,90,false,false,false,4,-0.5);
    DO $$ BEGIN
      PERFORM refresh_player_metric_queue(1);
      IF (SELECT contribution FROM team_roster WHERE id='${champ}:${teamA}:${playerA}') IS DISTINCT FROM 3.5::double precision
        THEN RAISE EXCEPTION 'equal-counter appearance replacement must invalidate recorded metrics'; END IF;
    END $$;
    UPDATE player_game SET off_rating=2 WHERE id='${replacementAppearance}';
    DO $$ BEGIN PERFORM refresh_player_metric_queue(1); END $$;
    -- A delayed counter-only recount preserves current metrics and queues
    -- the changed per-90 denominator for the single authoritative writer.
    UPDATE player_stat SET minutes=360 WHERE id='enrichment-stat-a-${teamA}';
    DO $$ BEGIN
      IF (SELECT contribution FROM player_stat WHERE id='enrichment-stat-a-${teamA}') IS DISTINCT FROM 1.5::double precision
        THEN RAISE EXCEPTION 'counter writes must preserve current metrics'; END IF;
      PERFORM refresh_player_metric_queue(1);
      IF (SELECT contribution_per90 FROM team_roster WHERE id='${champ}:${teamA}:${playerA}') IS DISTINCT FROM 0.375::double precision
        THEN RAISE EXCEPTION 'late counter writes must reconcile the per-90 denominator'; END IF;
    END $$;

    DELETE FROM team_rating_chart_dirty;
    INSERT INTO team_rating(id,team_id,measure_date,offense,defense,rating)
    SELECT ids, '${teamA}', date '2020-01-01' + (ordinal-1)::integer,1,1,
      CASE WHEN ordinal=1 THEN 1 WHEN ordinal=601 THEN 99 ELSE 40+(ordinal%20) END
    FROM unnest(ARRAY[${ratingIds.map(q).join(",")}]::uuid[]) WITH ORDINALITY x(ids,ordinal);
    DO $$ BEGIN PERFORM refresh_team_rating_charts(1); END $$;
    DO $$ BEGIN
      IF (SELECT jsonb_array_length(series_json::jsonb #> '{series,0,points}') FROM team_rating_chart
          WHERE team_id='${teamA}' AND period='all') > 600
        OR NOT EXISTS (SELECT 1 FROM team_rating_chart, jsonb_array_elements(series_json::jsonb #> '{series,0,points}') p
          WHERE team_id='${teamA}' AND period='all' AND (p->>'y')::double precision=1)
        OR NOT EXISTS (SELECT 1 FROM team_rating_chart, jsonb_array_elements(series_json::jsonb #> '{series,0,points}') p
          WHERE team_id='${teamA}' AND period='all' AND (p->>'y')::double precision=99)
        THEN RAISE EXCEPTION 'all-time chart must retain actual endpoints/extrema and stay within 600 points'; END IF;
    END $$;
    -- A deleted team can leave an orphaned dirty-queue key. It must be
    -- consumed without blocking chart refreshes for live teams in the batch.
    DELETE FROM team_rating_chart_dirty;
    UPDATE team_rating_chart_clock SET utc_day=(now() AT TIME ZONE 'UTC')::date WHERE id;
    INSERT INTO team_rating_chart_dirty(team_id,revision)
      VALUES (${q(deletedTeam)},nextval('team_rating_chart_revision_seq')),
        (${q(teamA)},nextval('team_rating_chart_revision_seq'));
    DO $$ DECLARE processed integer; orphan_left boolean; live_chart boolean; BEGIN
      processed:=refresh_team_rating_charts(2);
      SELECT EXISTS (SELECT 1 FROM team_rating_chart_dirty WHERE team_id='${deletedTeam}') INTO orphan_left;
      SELECT EXISTS (SELECT 1 FROM team_rating_chart WHERE team_id='${teamA}' AND period='all') INTO live_chart;
      IF processed <> 2 OR orphan_left OR NOT live_chart
        THEN RAISE EXCEPTION 'orphaned rating queue keys must not block live team charts (processed %, orphan %, chart %)',processed,orphan_left,live_chart; END IF;
    END $$;

    -- All game rows in the same round receive the final round table position.
    DO $$ BEGIN PERFORM refresh_team_campaign_group('${group}'); END $$;
    DO $$ BEGIN PERFORM refresh_team_campaign_group('${groupBonus}'); END $$;
    DO $$ BEGIN
      IF (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${teamA}' AND game_id='${gAB}') <> 1
        OR (SELECT points FROM team_campaign_point WHERE group_id='${group}' AND team_id='${teamA}' AND game_id='${gAB}') <> 6
        OR (SELECT position FROM team_campaign_point WHERE group_id='${group}' AND team_id='${teamB}' AND game_id='${gAB}') <> 2
        THEN RAISE EXCEPTION 'campaign current position should use final round rank with head-to-head tie break'; END IF;
      IF (SELECT points FROM team_campaign_point WHERE group_id='${groupBonus}' AND team_id='${teamE}' AND game_id='${bonusGame}') <> 4
        THEN RAISE EXCEPTION 'threshold bonus points should be included in campaign totals'; END IF;
    END $$;
    CREATE TEMP TABLE campaign_snapshot AS SELECT * FROM team_campaign_point WHERE group_id='${group}';
    DO $$ BEGIN PERFORM refresh_team_campaign_group('${group}'); END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT id,position,points FROM campaign_snapshot EXCEPT SELECT id,position,points FROM team_campaign_point WHERE group_id='${group}')
        OR EXISTS (SELECT id,position,points FROM team_campaign_point WHERE group_id='${group}' EXCEPT SELECT id,position,points FROM campaign_snapshot)
        THEN RAISE EXCEPTION 'campaign replay should preserve logical rows'; END IF;
    END $$;
    DELETE FROM game WHERE id='${gCD}';
    DO $$ BEGIN PERFORM refresh_team_campaign_group('${group}'); END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND game_id='${gCD}')
        THEN RAISE EXCEPTION 'campaign replacement must remove rows for deleted games'; END IF;
    END $$;
    UPDATE game SET phase_id='${phaseBonus}' WHERE id='${gAB}';
    DO $$ BEGIN
      PERFORM refresh_team_campaign_group('${group}');
      PERFORM refresh_team_campaign_group('${groupBonus}');
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND game_id='${gAB}')
        THEN RAISE EXCEPTION 'moved matches must leave their previous campaign'; END IF;
    END $$;
    UPDATE game SET phase_id='${phase}' WHERE id='${gAB}';
    UPDATE team_group SET group_id='${groupBonus}' WHERE group_id='${group}' AND team_id='${teamB}';
    DO $$ BEGIN
      PERFORM refresh_team_campaign_group('${group}');
      PERFORM refresh_team_campaign_group('${groupBonus}');
      IF EXISTS (SELECT 1 FROM team_campaign_point WHERE group_id='${group}' AND team_id='${teamB}')
        THEN RAISE EXCEPTION 'moved membership must leave its previous campaign'; END IF;
    END $$;
    UPDATE team_group SET group_id='${group}' WHERE group_id='${groupBonus}' AND team_id='${teamB}';

    -- Odds capture is all-or-nothing: an incomplete chance matrix records zero rows.
    INSERT INTO zone(id,group_id,name,color,first,last) VALUES (${q(zone)},${q(oddsGroup)},'Top two','champion',1,2);
    INSERT INTO team_chance(id,group_id,team_id,team_name,rank,points,played) VALUES
      (${q(uuid())},${q(oddsGroup)},${q(teamE)},'Enrichment E',1,4,1),
      (${q(uuid())},${q(oddsGroup)},${q(teamA)},'Enrichment A',2,0,1);
    INSERT INTO game(id,phase_id,round,day,home_id,away_id,played) VALUES
      (${q(uuid())},${q(phaseBonus)},2,'2026-01-02',${q(teamE)},${q(teamA)},false);
    INSERT INTO position_chance(id,group_id,team_id,position,percent,band,current,reach) VALUES
      (${q(uuid())},${q(oddsGroup)},${q(teamE)},1,0,0,false,''),
      (${q(uuid())},${q(oddsGroup)},${q(teamE)},2,50,0,false,''),
      (${q(uuid())},${q(oddsGroup)},${q(teamA)},1,25,0,false,'');
    DO $$ BEGIN
      BEGIN PERFORM capture_team_odds_history();
        RAISE EXCEPTION 'incomplete vector should have been rejected';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM='incomplete vector should have been rejected' THEN RAISE; END IF;
      END;
      IF EXISTS (SELECT 1 FROM team_odds_history WHERE group_id='${oddsGroup}')
        THEN RAISE EXCEPTION 'failed capture must not leave partial odds history'; END IF;
    END $$;
    INSERT INTO position_chance(id,group_id,team_id,position,percent,band,current,reach) VALUES
      (${q(uuid())},${q(oddsGroup)},${q(teamA)},2,75,0,false,'');
    DO $$ BEGIN PERFORM capture_team_odds_history(); END $$;
    DO $$ BEGIN
      IF (SELECT count(*) FROM team_odds_history WHERE group_id='${oddsGroup}' AND source='computed') <> 4
        OR NOT EXISTS (SELECT 1 FROM team_odds_history WHERE group_id='${oddsGroup}' AND team_id='${teamE}' AND percent=0)
        THEN RAISE EXCEPTION 'complete vectors and zero percentages should be captured'; END IF;
    END $$;

    INSERT INTO app_user(id,handle) VALUES (${q(user)},'team-enrichment-${user}'),
      (${q(otherUser)},'team-other-${otherUser}');
    INSERT INTO team_comment(team_id,app_user_id,body) VALUES ('${teamA}','${otherUser}','Other author comment');
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE anon;
    DO $$ BEGIN
      IF (SELECT count(*) FROM team_comment WHERE team_id='${teamA}') <> 0
        THEN RAISE EXCEPTION 'anonymous readers should not see comments'; END IF;
    END $$;
    RESET ROLE;
    SET LOCAL ROLE app_user;
    SET LOCAL request.jwt.claims='{"sub":"${user}","guest":"true"}';
    DO $$ BEGIN
      BEGIN INSERT INTO team_comment(team_id,body) VALUES ('${teamA}','Guest must not post');
        RAISE EXCEPTION 'guest insert should have been rejected';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END $$;
    SET LOCAL request.jwt.claims='{"sub":"${user}","guest":"false"}';
    INSERT INTO team_comment(team_id,body) VALUES (${q(teamA)},'Signed author comment');
    DO $$ BEGIN
      IF (SELECT count(*) FROM team_comment WHERE team_id='${teamA}' AND app_user_id='${user}') <> 1
        THEN RAISE EXCEPTION 'signed-in author should be able to create a team comment'; END IF;
      DELETE FROM team_comment WHERE team_id='${teamA}' AND app_user_id<>'${user}';
      IF FOUND THEN RAISE EXCEPTION 'authors must not delete another user’s comment'; END IF;
      IF NOT EXISTS (SELECT 1 FROM team_comment WHERE team_id='${teamA}' AND app_user_id='${otherUser}')
        THEN RAISE EXCEPTION 'other author comment must remain after attempted deletion'; END IF;
      DELETE FROM team_comment WHERE team_id='${teamA}' AND app_user_id='${user}';
      IF NOT FOUND THEN RAISE EXCEPTION 'authors should be able to delete their own comment'; END IF;
    END $$;
    RESET ROLE;
    DO $$ BEGIN
      IF has_function_privilege('anon','capture_team_odds_history()','EXECUTE')
        OR has_function_privilege('app_user','capture_team_odds_history()','EXECUTE')
        OR NOT has_function_privilege('service','capture_team_odds_history()','EXECUTE')
        THEN RAISE EXCEPTION 'only service may capture computed odds history'; END IF;
    END $$;
    ROLLBACK;`);

  assertEquals(output, "");
});
