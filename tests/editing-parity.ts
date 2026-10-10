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
    otherActor,
    reader,
    home,
    away,
    player,
    source,
    stadium,
    referee,
    champ,
    phase,
    game,
    secondGame,
    registration,
    goal,
    appearance,
  ] = Array.from({ length: 16 }, () => crypto.randomUUID());
  const setup = `INSERT INTO app_user(id,handle) VALUES
    ('${actor}','edit-${actor}'),('${otherActor}','edit-${otherActor}'),('${reader}','read-${reader}');
    INSERT INTO editor(app_user_id) VALUES ('${actor}'),('${otherActor}');
    INSERT INTO championship(id,name,region_name,begins,ends)
      VALUES ('${champ}','Editing season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Editing phase');
    INSERT INTO team(id,name,country) VALUES ('${home}','Editing home','Brasil'),('${away}','Editing away','Brasil');
    INSERT INTO player(id,name,country,full_name) VALUES
      ('${player}','Editing target','Brasil','Chosen biography'),('${source}','Editing source','Portugal','Longer source biography');
    INSERT INTO stadium(id,name) VALUES ('${stadium}','Editing ground');
    INSERT INTO referee(id,name) VALUES ('${referee}','Editing referee');
    INSERT INTO game(id,phase_id,day,home_id,away_id,stadium_id,referee_id) VALUES
      ('${game}','${phase}','2026-01-02','${home}','${away}','${stadium}','${referee}'),
      ('${secondGame}','${phase}','2026-01-03','${away}','${home}',NULL,NULL);
    INSERT INTO team_player(id,championship_id,team_id,player_id)
      VALUES ('${registration}','${champ}','${home}','${player}');
    INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute)
      VALUES ('${appearance}','${game}','${player}','home',0,90);
    INSERT INTO goal(id,game_id,player_id,side,minute)
      VALUES ('${goal}','${game}','${player}','home',12);`;
  return {
    actor,
    otherActor,
    reader,
    home,
    away,
    player,
    source,
    stadium,
    referee,
    champ,
    phase,
    game,
    secondGame,
    registration,
    goal,
    appearance,
    setup,
  };
};
const refusal = async (sql: string, code: string) => {
  const error = await assertRejects(() => query(`BEGIN;${sql}`));
  assertEquals((error as Error & { code: string }).code, code);
};

Deno.test("editing source CRUD requires a signed-in editor and stamps immutable attribution", async () => {
  const f = fixture();
  const [player, team, stadium, referee, game, goal, appearance, registration] =
    Array.from({ length: 8 }, () => crypto.randomUUID());
  const records = [
    ["player", player, "name='Edited player'"],
    ["team", team, "city='Edited city'"],
    ["stadium", stadium, "city='Edited city'"],
    ["referee", referee, "location='Edited location'"],
    [
      "game",
      game,
      "day='2026-02-03',home_aet=1,away_aet=0,home_pen=4,away_pen=3",
    ],
    ["goal", goal, "minute=37,penalty=true"],
    ["player_game", appearance, "yellow=true,off_minute=80"],
    ["team_player", registration, `championship_id='${f.champ}'`],
  ];
  await query(`BEGIN;${f.setup}${identity(f.actor)}
    INSERT INTO stadium(id,name) VALUES ('${stadium}','Created ground');
    INSERT INTO referee(id,name) VALUES ('${referee}','Created referee');
    INSERT INTO player(id,name,country) VALUES ('${player}','Created player','Brasil');
    INSERT INTO team(id,name,country,stadium_id) VALUES ('${team}','Created club','Brasil','${stadium}');
    INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score,stadium_id,referee_id)
      VALUES ('${game}','${f.phase}','2026-02-02','${team}','${f.away}',true,1,0,'${stadium}','${referee}');
    INSERT INTO goal(id,game_id,player_id,side,minute) VALUES ('${goal}','${game}','${player}','home',20);
    INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute)
      VALUES ('${appearance}','${game}','${player}','home',0,90);
    INSERT INTO team_player(id,championship_id,team_id,player_id)
      VALUES ('${registration}','${f.champ}','${team}','${player}');
    ${identity(f.otherActor)}
    ${
    records.map(([table, id, values]) =>
      `UPDATE ${table} SET ${values} WHERE id='${id}';`
    ).join("\n")
  }
    DO $$ BEGIN
      ${
    records.map(([table, id]) =>
      `IF NOT EXISTS(SELECT 1 FROM ${table} WHERE id='${id}'
        AND created_by='${f.actor}' AND updated_by='${f.otherActor}')
        THEN RAISE EXCEPTION '${table} attribution was not stamped'; END IF;`
    ).join("\n")
  }
      IF (SELECT day FROM player_game WHERE id='${appearance}') IS DISTINCT FROM '2026-02-03'::date
        THEN RAISE EXCEPTION 'editing the game date must move its squad date'; END IF;
    END $$;
    DELETE FROM goal WHERE id='${goal}';
    DELETE FROM player_game WHERE id='${appearance}';
    DELETE FROM team_player WHERE id='${registration}';
    DELETE FROM game WHERE id='${game}';
    DELETE FROM player WHERE id='${player}';
    DELETE FROM team WHERE id='${team}';
    DELETE FROM stadium WHERE id='${stadium}';
    DELETE FROM referee WHERE id='${referee}';
    ROLLBACK;`);
  const existing = [
    f.player,
    f.home,
    f.stadium,
    f.referee,
    f.game,
    f.goal,
    f.appearance,
    f.registration,
  ];
  for (const [index, [table, , values]] of records.entries()) {
    await refusal(
      `${f.setup}${identity(f.reader)}UPDATE ${table} SET ${values} WHERE id='${
        existing[index]
      }';`,
      "42501",
    );
  }
  await refusal(
    `${f.setup}${
      identity(f.actor, true)
    }INSERT INTO player(name) VALUES ('Guest edit');`,
    "42501",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }UPDATE player SET created_by='${f.otherActor}' WHERE id='${f.player}';`,
    "42501",
  );
  await refusal(
    `${f.setup}${
      identity(f.reader)
    }INSERT INTO editor(app_user_id) VALUES ('${f.reader}');`,
    "42501",
  );
});

Deno.test("ordinary deletion refuses source dependencies instead of cascading history", async () => {
  const f = fixture();
  for (
    const [table, id] of [
      ["player", f.player],
      ["team", f.home],
      ["stadium", f.stadium],
      ["referee", f.referee],
      ["game", f.game],
    ]
  ) {
    await refusal(
      `${f.setup}${identity(f.actor)}DELETE FROM ${table} WHERE id='${id}';`,
      "23503",
    );
    await refusal(
      `${f.setup}${identity(f.reader)}DELETE FROM ${table} WHERE id='${id}';`,
      "42501",
    );
  }
  const commentedTeam = crypto.randomUUID();
  await refusal(
    `${f.setup}
    INSERT INTO team(id,name,country) VALUES ('${commentedTeam}','Commented editing club','Brasil');
    INSERT INTO team_comment(team_id,app_user_id,body) VALUES ('${commentedTeam}','${f.reader}','Keep this history');
    ${identity(f.actor)}DELETE FROM team WHERE id='${commentedTeam}';`,
    "23503",
  );
});

Deno.test("registration removal cleans only the selected team and championship including own goals", async () => {
  const f = fixture();
  const [champ, phase, outside] = Array.from(
    { length: 3 },
    () => crypto.randomUUID(),
  );
  await query(`BEGIN;${f.setup}
    INSERT INTO championship(id,name,region_name,begins,ends)
      VALUES ('${champ}','Other editing season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Other phase');
    INSERT INTO game(id,phase_id,day,home_id,away_id)
      VALUES ('${outside}','${phase}','2026-01-04','${f.home}','${f.away}');
    INSERT INTO player_game(game_id,player_id,side) VALUES
      ('${outside}','${f.player}','home'),('${f.secondGame}','${f.player}','home');
    INSERT INTO goal(game_id,player_id,side,own_goal) VALUES
      ('${f.game}','${f.player}','away',true),('${outside}','${f.player}','home',false),
      ('${f.secondGame}','${f.player}','home',false);
    ${identity(f.actor)}
    DELETE FROM team_player WHERE id='${f.registration}';
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM goal WHERE player_id='${f.player}' AND game_id='${f.game}')
        OR EXISTS(SELECT 1 FROM player_game WHERE player_id='${f.player}' AND game_id='${f.game}')
        OR (SELECT count(*) FROM goal WHERE player_id='${f.player}')<>2
        OR (SELECT count(*) FROM player_game WHERE player_id='${f.player}')<>2
        THEN RAISE EXCEPTION 'registration cleanup crossed its team or championship scope'; END IF;
    END $$;
    ROLLBACK;`);
});

Deno.test("private merge preserves the target biography and moves source records atomically", async () => {
  const f = fixture();
  const command = crypto.randomUUID();
  await query(`BEGIN;${f.setup}
    UPDATE player SET birth='1991-01-02',height=180,position='fw' WHERE id='${f.source}';
    INSERT INTO team_player(championship_id,team_id,player_id) VALUES
      ('${f.champ}','${f.home}','${f.source}'),('${f.champ}','${f.away}','${f.source}');
    INSERT INTO player_game(game_id,player_id,side) VALUES ('${f.secondGame}','${f.source}','home');
    INSERT INTO goal(game_id,player_id,side,minute) VALUES ('${f.secondGame}','${f.source}','home',7);
    ${identity(f.actor)}
    INSERT INTO player_merge(id,target_player_id,source_player_id) VALUES ('${command}','${f.player}','${f.source}');
    INSERT INTO player_merge(id,target_player_id,source_player_id)
      VALUES ('${command}','${f.player}','${f.source}') ON CONFLICT(id) DO NOTHING;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM player WHERE id='${f.source}')
        OR NOT EXISTS(SELECT 1 FROM player WHERE id='${f.player}' AND full_name='Chosen biography'
          AND country='Brasil' AND birth='1991-01-02' AND height=180 AND position='fw' AND updated_by='${f.actor}')
        OR (SELECT count(*) FROM team_player WHERE player_id='${f.player}')<>2
        OR (SELECT count(*) FROM player_game WHERE player_id='${f.player}')<>2
        OR (SELECT count(*) FROM goal WHERE player_id='${f.player}')<>2
        OR NOT EXISTS(SELECT 1 FROM player_merge WHERE id='${command}' AND app_user_id='${f.actor}')
        THEN RAISE EXCEPTION 'merge did not preserve biography or transfer source history'; END IF;
      IF (SELECT count(*) FROM player_merge WHERE id='${command}')<>1
        THEN RAISE EXCEPTION 'a replayed native create must retain one completed merge command'; END IF;
    END $$;
    ${identity(f.otherActor)}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM player_merge WHERE id='${command}')
        THEN RAISE EXCEPTION 'another editor can read a private merge command'; END IF;
    END $$;
    ROLLBACK;`);
  await refusal(
    `${f.setup}${
      identity(f.reader)
    }INSERT INTO player_merge(target_player_id,source_player_id)
    VALUES ('${f.player}','${f.source}');`,
    "42501",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }INSERT INTO player_merge(target_player_id,source_player_id)
    VALUES ('${f.player}','${f.player}');`,
    "23514",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }INSERT INTO player_merge(target_player_id,source_player_id)
    VALUES ('${f.player}','${crypto.randomUUID()}');`,
    "23503",
  );
  await refusal(
    `${f.setup}INSERT INTO player_game(game_id,player_id,side) VALUES ('${f.game}','${f.source}','home');
    ${
      identity(f.actor)
    }INSERT INTO player_merge(target_player_id,source_player_id)
    VALUES ('${f.player}','${f.source}');`,
    "23505",
  );
  await refusal(
    `${f.setup}${
      identity(f.actor)
    }UPDATE player_merge SET source_player_id='${f.source}';`,
    "42501",
  );
  await refusal(
    `${f.setup}${identity(f.actor)}DELETE FROM player_merge;`,
    "42501",
  );
});
