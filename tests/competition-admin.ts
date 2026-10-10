import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { query } from "./db.ts";

const identity = (user: string, guest = false) =>
  `RESET ROLE;
  SET LOCAL app.scopes='public:,user:${user}';
  SET LOCAL request.jwt.claims='{"sub":"${user}","guest":${guest}}';
  SET LOCAL ROLE app_user;`;
const fixture = () => {
  const [
    actor,
    other,
    reader,
    champ,
    secondChamp,
    phase,
    secondPhase,
    group,
    secondGroup,
    home,
    away,
    player,
    game,
    zone,
    member,
  ] = Array.from({ length: 15 }, () => crypto.randomUUID());
  const setup =
    `INSERT INTO app_user(id,handle) VALUES ('${actor}','competition-${actor}'),('${other}','competition-${other}'),('${reader}','reader-${reader}');
    INSERT INTO editor(app_user_id) VALUES ('${actor}'),('${other}');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES
      ('${champ}','Competition season','Brasil','2026-01-01','2026-12-31'),
      ('${secondChamp}','Other competition season','Brasil','2027-01-01','2027-12-31');
    INSERT INTO phase(id,championship_id,name,sort,bonus_points,bonus_points_threshold) VALUES
      ('${phase}','${champ}','Phase','pt,head,bias,name',1,3),('${secondPhase}','${secondChamp}','Other phase','pt,name',0,0);
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','A'),('${secondGroup}','${secondPhase}','B');
    INSERT INTO team(id,name,country) VALUES ('${home}','Competition home','Brasil'),('${away}','Competition away','Brasil');
    INSERT INTO team_group(id,group_id,team_id,add_sub,bias,comment) VALUES ('${member}','${group}','${home}',-3,4,'Adjustment rationale');
    INSERT INTO team_group(group_id,team_id) VALUES ('${secondGroup}','${away}');
    INSERT INTO zone(id,group_id,name,color,first,last,positions) VALUES ('${zone}','${group}','Sparse places','#AABBCC',1,5,'3,1,5');
    INSERT INTO player(id,name,country) VALUES ('${player}','Competition player','Brasil');
    INSERT INTO team_player(championship_id,team_id,player_id) VALUES ('${champ}','${home}','${player}');
    INSERT INTO game(id,phase_id,day,home_id,away_id) VALUES ('${game}','${phase}','2026-02-01','${home}','${away}');
    INSERT INTO player_game(game_id,player_id,side) VALUES ('${game}','${player}','home');`;
  return {
    actor,
    other,
    reader,
    champ,
    secondChamp,
    phase,
    secondPhase,
    group,
    secondGroup,
    home,
    away,
    player,
    game,
    zone,
    member,
    setup,
  };
};
const refusal = async (script: string, code: string) => {
  const error = await assertRejects(() => query(`BEGIN;${script}`));
  assertEquals((error as Error & { code: string }).code, code);
};

Deno.test("competition CRUD requires a signed-in editor and preserves attribution", async () => {
  const f = fixture();
  const [champ, phase, group, zone, member] = Array.from(
    { length: 5 },
    () => crypto.randomUUID(),
  );
  const records = [
    ["championship", champ, "name='Updated championship'"],
    ["phase", phase, "sort='bias,head,pt,name'"],
    ["stage_group", group, "name='Updated group'"],
    ["zone", zone, "positions='2,4'"],
    ["team_group", member, "add_sub=-7,bias=9,comment='Updated rationale'"],
  ];
  await query(`BEGIN;${f.setup}${identity(f.actor)}
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Created season','Brasil','2028-01-01','2028-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Created phase');
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Created group');
    INSERT INTO zone(id,group_id,name,color,first,last) VALUES ('${zone}','${group}','Places','qualify',1,4);
    INSERT INTO team_group(id,group_id,team_id) VALUES ('${member}','${group}','${f.home}');
    ${identity(f.other)}${
    records.map(([table, id, values]) =>
      `UPDATE ${table} SET ${values} WHERE id='${id}';`
    ).join("\n")
  }
    DO $$ BEGIN ${
    records.map(([table, id]) =>
      `IF NOT EXISTS(SELECT 1 FROM ${table} WHERE id='${id}' AND created_by='${f.actor}' AND updated_by='${f.other}') THEN RAISE EXCEPTION '${table} attribution failed'; END IF;`
    ).join("\n")
  } END $$;
    DELETE FROM zone WHERE id='${zone}'; DELETE FROM team_group WHERE id='${member}';
    DELETE FROM stage_group WHERE id='${group}'; DELETE FROM phase WHERE id='${phase}';
    DELETE FROM championship WHERE id='${champ}'; ROLLBACK;`);
  for (
    const [table, id, values] of [
      ["championship", f.champ, "name='Forbidden'"],
      ["phase", f.phase, "sort='pt,name'"],
      ["stage_group", f.group, "name='Forbidden'"],
      ["zone", f.zone, "positions='2'"],
      ["team_group", f.member, "bias=3"],
    ]
  ) {
    await refusal(
      `${f.setup}${
        identity(f.reader)
      }UPDATE ${table} SET ${values} WHERE id='${id}';`,
      "42501",
    );
    await refusal(
      `${f.setup}${identity(f.reader)}DELETE FROM ${table} WHERE id='${id}';`,
      "42501",
    );
  }
  await refusal(
    `${f.setup}${
      identity(f.actor, true)
    }UPDATE phase SET name='Guest edit' WHERE id='${f.phase}';`,
    "42501",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }DELETE FROM championship WHERE id='${f.champ}';`,
    "23503",
  );
  await refusal(
    `${f.setup}${identity(f.actor)}DELETE FROM phase WHERE id='${f.phase}';`,
    "23503",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }DELETE FROM stage_group WHERE id='${f.group}';`,
    "23503",
  );
});

Deno.test("zones canonicalize sparse positive positions and reject ambiguous memberships", async () => {
  const f = fixture();
  assertEquals(
    await query(
      `BEGIN;${f.setup}SELECT positions,color FROM zone WHERE id='${f.zone}';ROLLBACK;`,
    ),
    "1,3,5|#aabbcc",
  );
  for (
    const raw of ["0", "1,1", "01", "-1", "1, 3", "1,", "1001", "9999999999"]
  ) {
    await refusal(
      `${f.setup}${
        identity(f.actor)
      }UPDATE zone SET positions='${raw}' WHERE id='${f.zone}';`,
      "23514",
    );
  }
  await query(
    `BEGIN;${f.setup}${
      identity(f.actor)
    }UPDATE zone SET positions='1000,2' WHERE id='${f.zone}';
    DO $$ BEGIN IF (SELECT positions FROM zone WHERE id='${f.zone}')<>'2,1000' THEN RAISE EXCEPTION 'sparse positions were not sorted'; END IF; END $$;
    UPDATE zone SET positions='' WHERE id='${f.zone}'; ROLLBACK;`,
  );
});

Deno.test("a private phase clone copies structure and rules exactly once without matches or registrations", async () => {
  const f = fixture();
  const command = crypto.randomUUID();
  const insert = `INSERT INTO phase_clone(id,source_phase_id,name,begins,ends)
    VALUES ('${command}','${f.phase}','Cloned season','2029-01-01','2029-12-31')`;
  await query(
    `BEGIN;${f.setup}${
      identity(f.actor)
    }${insert};${insert} ON CONFLICT(id) DO NOTHING;
    DO $$ DECLARE champ uuid; cloned_phase uuid; g uuid; BEGIN
      SELECT target_championship_id,target_phase_id INTO champ,cloned_phase
        FROM phase_clone WHERE id='${command}';
      SELECT id INTO g FROM stage_group WHERE phase_id=cloned_phase;
      IF champ IS NULL OR cloned_phase IS NULL OR champ=cloned_phase
        OR champ='${f.champ}' OR cloned_phase='${f.phase}'
        OR g IS NULL OR (SELECT count(*) FROM stage_group WHERE phase_id=cloned_phase)<>1
        OR NOT EXISTS(SELECT 1 FROM championship WHERE id=champ AND name='Cloned season' AND begins='2029-01-01' AND ends='2029-12-31' AND created_by='${f.actor}')
        OR NOT EXISTS(SELECT 1 FROM phase WHERE id=cloned_phase AND championship_id=champ AND position=1 AND sort='pt,head,bias,name' AND bonus_points=1 AND bonus_points_threshold=3 AND created_by='${f.actor}')
        OR NOT EXISTS(SELECT 1 FROM team_group WHERE group_id=g AND team_id='${f.home}' AND add_sub=-3 AND bias=4 AND comment='Adjustment rationale')
        OR NOT EXISTS(SELECT 1 FROM zone WHERE group_id=g AND positions='1,3,5' AND color='#aabbcc')
        OR EXISTS(SELECT 1 FROM game WHERE phase_id=cloned_phase)
        OR EXISTS(SELECT 1 FROM team_player WHERE championship_id=champ)
        OR (SELECT count(*) FROM phase_clone WHERE id='${command}')<>1
        THEN RAISE EXCEPTION 'clone lost structure, copied source history, or replayed'; END IF;
    END $$;
    ${
      identity(f.other)
    }DO $$ BEGIN IF EXISTS(SELECT 1 FROM phase_clone WHERE id='${command}') THEN RAISE EXCEPTION 'clone command is not private'; END IF; END $$;
    ROLLBACK;`,
  );
  await refusal(`${f.setup}${identity(f.reader)}${insert};`, "42501");
  await refusal(
    `${f.setup}${identity(f.actor)}UPDATE phase_clone SET name='Mutated';`,
    "42501",
  );
  await refusal(
    `${f.setup}${identity(f.actor)}DELETE FROM phase_clone;`,
    "42501",
  );
});

const cached = (f: ReturnType<typeof fixture>) =>
  `INSERT INTO standing(id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone)
  SELECT group_id::text||':'||team_id::text,group_id,team_id,'Home',1,3,1,1,0,0,1,0,1,'','','','','','' FROM team_group WHERE group_id IN ('${f.group}','${f.secondGroup}');
  INSERT INTO team_chance(id,group_id,team_id,team_name,rank,points,played)
  SELECT gen_random_uuid(),id,'${f.home}','Home',1,3,1 FROM stage_group WHERE id IN ('${f.group}','${f.secondGroup}');
  INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,position,percent,source) VALUES
    ('${f.group}:${f.home}:2026-02-01:1','${f.group}','${f.home}','2026-02-01',1,20,'imported'),
    ('${f.group}:${f.home}:2026-02-01:3','${f.group}','${f.home}','2026-02-01',3,30,'imported'),
    ('${f.group}:${f.home}:2026-02-01:5','${f.group}','${f.home}','2026-02-01',5,10,'imported');`;
Deno.test("moving membership or a match invalidates both scopes while retaining probability snapshots", async () => {
  const f = fixture();
  for (
    const change of [
      `UPDATE team_group SET group_id='${f.secondGroup}' WHERE id='${f.member}';`,
      `UPDATE game SET phase_id='${f.secondPhase}',home_id='${f.away}',away_id='${f.home}' WHERE id='${f.game}';`,
    ]
  ) {
    await query(
      `BEGIN;${f.setup}${cached(f)}${identity(f.actor)}${change}RESET ROLE;
      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM standing WHERE group_id IN ('${f.group}','${f.secondGroup}'))
          OR EXISTS(SELECT 1 FROM team_chance WHERE group_id IN ('${f.group}','${f.secondGroup}'))
          OR (SELECT count(*) FROM team_odds_history WHERE group_id='${f.group}')<>3
          THEN RAISE EXCEPTION 'moved scope retained current projections or erased odds history'; END IF;
      END $$;ROLLBACK;`,
    );
  }
});

// Inserts and group moves once cleared every sibling group, which no recount
// then restored: a group event recounts that group alone.
Deno.test("new rows and a moved group leave other groups' standings and chances in place", async () => {
  const f = fixture();
  const added = crypto.randomUUID();
  await query(
    `BEGIN;${f.setup}${cached(f)}${identity(f.actor)}
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${added}','${f.phase}','Added');
    INSERT INTO game(phase_id,home_id,away_id,day) VALUES ('${f.phase}','${f.home}','${f.away}','2026-03-01');
    RESET ROLE;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM standing WHERE group_id='${f.group}')
        OR NOT EXISTS(SELECT 1 FROM team_chance WHERE group_id='${f.group}')
        THEN RAISE EXCEPTION 'an inserted group or game cleared its phase'; END IF;
    END $$;
    ${identity(f.actor)}UPDATE stage_group SET phase_id='${f.phase}' WHERE id='${f.secondGroup}';RESET ROLE;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM standing WHERE group_id='${f.group}')
        OR EXISTS(SELECT 1 FROM standing WHERE group_id='${f.secondGroup}')
        THEN RAISE EXCEPTION 'a moved group must clear itself and only itself'; END IF;
    END $$;ROLLBACK;`,
  );
});

Deno.test("a stale standings publication cannot restore a removed member and a current recount succeeds", async () => {
  const f = fixture();
  await query(`BEGIN;${f.setup}${cached(f)}
    -- A setting, not a temp table: pgroll records DDL in its ledger, and
    -- concurrent checks recording against one parent collide.
    SELECT set_config('golaberto.stale_standings',
      (SELECT json_agg(s)::text FROM standing s WHERE group_id='${f.group}'), true);
    ${identity(f.actor)}DELETE FROM team_group WHERE id='${f.member}';RESET ROLE;
    DO $$ BEGIN
      BEGIN
        INSERT INTO standing(id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone)
          SELECT id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone
          FROM json_populate_recordset(NULL::standing, current_setting('golaberto.stale_standings')::json);
        RAISE EXCEPTION 'a stale recount restored a removed member';
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END $$;
    ${identity(f.actor)}INSERT INTO team_group(group_id,team_id) VALUES ('${f.group}','${f.away}');RESET ROLE;
    INSERT INTO standing(id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone)
      SELECT group_id::text||':'||team_id::text,group_id,team_id,'Away',1,0,0,0,0,0,0,0,0,'','','','','',''
      FROM team_group WHERE group_id='${f.group}'
      ON CONFLICT(id) DO UPDATE SET position=EXCLUDED.position;
    DO $$ BEGIN
      IF (SELECT count(*) FROM standing WHERE group_id='${f.group}')<>1
        OR NOT EXISTS(SELECT 1 FROM standing WHERE group_id='${f.group}' AND team_id='${f.away}')
        THEN RAISE EXCEPTION 'the current recount did not publish exactly current membership'; END IF;
    END $$;ROLLBACK;`);
});
Deno.test("sparse historical zone charts sum selected positions and retain the missing-position gap", async () => {
  const f = fixture();
  await query(`BEGIN;${f.setup}${cached(f)}
    DO $$ DECLARE chart jsonb; BEGIN
      chart:=build_team_odds_series('${f.group}','${f.home}',1,5,'1,3,5');
      IF (chart#>>'{series,0,points,0,y}')::numeric<>60 THEN RAISE EXCEPTION 'chart summed the envelope instead of sparse positions'; END IF;
      chart:=build_team_odds_series('${f.group}','${f.home}',1,5,'1,2,5');
      IF jsonb_array_length(chart#>'{series,0,points}')<>0 THEN RAISE EXCEPTION 'chart filled a missing historical position'; END IF;
    END $$;ROLLBACK;`);
});

Deno.test("moving a game or its phase clears former player scopes for a full career recount", async () => {
  const f = fixture();
  for (
    const change of [
      `UPDATE game SET phase_id='${f.secondPhase}',home_id='${f.away}',away_id='${f.home}' WHERE id='${f.game}';`,
      `UPDATE phase SET championship_id='${f.secondChamp}' WHERE id='${f.phase}';`,
    ]
  ) {
    await query(`BEGIN;${f.setup}
      INSERT INTO player_stat(id,championship_id,team_id,player_id,player_name,position,
        played,started,came_on,bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name)
        VALUES ('${f.champ}:${f.home}:${f.player}','${f.champ}','${f.home}','${f.player}',
          'Competition player','',1,1,0,0,90,0,0,0,0,0,'Competition season','Competition home');
      ${identity(f.actor)}${change}
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM player_stat WHERE player_id='${f.player}')
        THEN RAISE EXCEPTION 'a moved game kept its former player counters'; END IF; END $$;
      ROLLBACK;`);
  }
});

Deno.test("deleting an attribution account preserves competition archive records", async () => {
  const f = fixture();
  const created = crypto.randomUUID();
  await query(`BEGIN;${f.setup}${identity(f.actor)}
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES
      ('${created}','Attributed season','Brasil','2030-01-01','2030-12-31');
    RESET ROLE;DELETE FROM app_user WHERE id='${f.actor}';
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM championship WHERE id='${created}' AND created_by IS NULL AND updated_by IS NULL)
      THEN RAISE EXCEPTION 'account removal erased its attributed championship'; END IF; END $$;
    ROLLBACK;`);
});
