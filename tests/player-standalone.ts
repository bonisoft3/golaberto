import assert from "node:assert/strict";
import { createDatabase } from "mecha/packages/mecha-browser/src/database.ts";
import { browserTier } from "mecha/packages/mecha-browser/fence.ts";
import { createRestHandler } from "mecha/packages/postgrest-js/src/rest-handler.ts";

const app = new URL("../", import.meta.url);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test("standalone migrations retain player views, fullname triggers, joins and filtered aggregate semantics", async () => {
  const shell = JSON.parse(await Deno.readTextFile(new URL("shell/shell.json", app))) as { migrations: string[] };
  const scripts = [await Deno.readTextFile(new URL(import.meta.resolve("mecha/services/database/rls/rls.sql")))];
  for (const migration of shell.migrations.filter((file) => !file.endsWith("900_seed.sql"))) {
    scripts.push(await Deno.readTextFile(new URL(migration.endsWith("035_read_parity.sql")
      ? "services/database/sql/035_read_parity.sql" : migration, app)));
  }
  const db = await createDatabase({});
  try {
    for (const script of scripts) await db.exec(browserTier(script));
    await db.exec(`
      INSERT INTO championship(id,name,region_name,begins,ends,slug)
        VALUES ('${id(1)}','League','Brasil','2026-01-01','2026-12-31','league');
      INSERT INTO phase(id,championship_id,name) VALUES ('${id(2)}','${id(1)}','Main');
      INSERT INTO team(id,name,country,slug,team_type) VALUES
        ('${id(3)}','Club A','Brasil','club-a','club'),
        ('${id(4)}','Club B','Brasil','club-b','club'),
        ('${id(5)}','National','Brasil','national','national');
      INSERT INTO player(id,name,full_name,country,position,slug) VALUES
        ('${id(6)}','Álvaro','Nome Completo Único','Brasil','fw','alvaro'),
        ('${id(7)}','Other','Unrelated','Brasil','g','other');
      INSERT INTO player_rating(id,rating,off_rating,def_rating) VALUES ('${id(6)}',0,NULL,-2);
      INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score,attendance,slug) VALUES
        ('${id(8)}','${id(2)}','2026-10-05','${id(3)}','${id(4)}',true,2,0,0,'club-played'),
        ('${id(9)}','${id(2)}','2026-10-10','${id(4)}','${id(3)}',false,NULL,NULL,NULL,'club-future'),
        ('${id(10)}','${id(2)}','2026-10-07','${id(5)}','${id(4)}',true,0,0,10,'national-played');
      INSERT INTO player_game(id,player_id,game_id,side,on_minute,off_minute,off_rating,def_rating,yellow) VALUES
        ('${id(11)}','${id(6)}','${id(8)}','home',0,90,-2,NULL,true),
        ('${id(12)}','${id(6)}','${id(9)}','home',0,NULL,NULL,NULL,false),
        ('${id(13)}','${id(6)}','${id(10)}','home',0,90,NULL,NULL,false);
      INSERT INTO goal(id,game_id,player_id,side,minute,penalty,own_goal) VALUES
        ('${id(14)}','${id(8)}','${id(6)}','home',15,true,false),
        ('${id(15)}','${id(8)}','${id(6)}','away',30,false,true);
      INSERT INTO player_stat(id,championship_id,team_id,player_id,player_name,position,
        played,started,came_on,bench,minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name,
        off_rating,def_rating,contribution,contribution_per90,goals_per90) VALUES
        ('one','${id(1)}','${id(3)}','${id(6)}','Álvaro','fw',10,10,0,0,900,2,1,1,2,0,'League','Club A',NULL,-2,-2,-0.2,0.2),
        ('two','${id(1)}','${id(4)}','${id(7)}','Other','g',1,1,0,0,90,0,0,0,0,0,'League','Club B',NULL,NULL,NULL,NULL,0);
    `);
    const handler = createRestHandler(db, { role: "app_user", scopes: async () => ["public:"] });
    const read = async (table: string, params: Record<string, string>) => {
      const response = await handler(new Request(`http://standalone/${table}?${new URLSearchParams(params)}`,
        { headers: { Prefer: "count=exact" } }));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return { body, range: response.headers.get("Content-Range") };
    };
    const directory = await read("player_directory", {
      search_key: "like.*nome completo unico*", country_search_key: "like.*brasil*", region_id: "like.*",
      position_key: "like.fw", order: "rating.desc.nullslast,name.asc,id.asc", limit: "40",
    });
    assert.equal(directory.body.length, 1);
    assert.equal(directory.body[0].latest_team_slug, "club-a");
    assert.equal(directory.body[0].rating, 0);
    assert.equal(directory.body[0].off_rating, null);
    assert.equal(directory.body[0].def_rating, -2);

    const select = "*,player(full_name,slug),team(slug),championship(slug,season,category_id,begins)";
    const career = await read("player_stat", { select, player_id: `eq.${id(6)}`, search_key: "like.*nome completo unico*", limit: "40" });
    assert.equal(career.body.length, 1);
    assert.equal(career.body[0].championship.season, "2026");
    assert.equal(career.body[0].player.full_name, "Nome Completo Único");
    const scoped = await read("player_stat", {
      select: select.replaceAll("player(", "player!inner(").replaceAll("team(", "team!inner(").replaceAll("championship(", "championship!inner("),
      "player.slug": "eq.alvaro", "team.slug": "eq.club-a", "championship.slug": "eq.league", limit: "1",
    });
    assert.equal(scoped.body.length, 1);
    const aggregate = "minutes:minutes.sum(),goals:goals.sum(),off_rating:off_rating.sum(),def_rating:def_rating.sum(),contribution:contribution.sum()";
    const championship = await read("player_stat", { select: aggregate, championship_id: `eq.${id(1)}`, minutes: "gte.0", limit: "1" });
    assert.deepEqual(championship.body, [{ minutes: 990, goals: 2, off_rating: null, def_rating: -2, contribution: -2 }]);
    assert.equal(championship.range, "0-0/1");
    assert.equal((await read("player_stat", { select: aggregate, championship_id: `eq.${id(1)}`, minutes: "gte.100", limit: "1" })).body[0].minutes, 900);
    const unrated = await read("player_stat", { select: aggregate, search_key: "like.*unrelated*", limit: "1" });
    assert.deepEqual(unrated.body, [{ minutes: 90, goals: 0, off_rating: null, def_rating: null, contribution: null }]);
    assert.deepEqual((await read("player_stat", { select: aggregate, search_key: "like.*unmatched*", limit: "1" })).body, [{ minutes: null, goals: null, off_rating: null, def_rating: null, contribution: null }]);
    await db.query("UPDATE player SET full_name=$1 WHERE id=$2", ["Número Novo Único", id(6)]);
    assert.equal((await read("player_stat", { select: aggregate, search_key: "like.*numero novo unico*", limit: "1" })).body[0].goals, 2);
    assert.deepEqual((await read("player_stat", { select, search_key: "like.*nome completo unico*", limit: "40" })).body, []);
    await db.query("UPDATE team SET name=$1 WHERE id=$2", ["Clube Renovado", id(3)]);
    assert.equal((await read("player_stat", { select, search_key: "like.*clube renovado*", limit: "40" })).body.length, 1);

    const appearances = await read("player_appearance", { player_id: `eq.${id(6)}`, played_key: "like.true", category_key: "like.professional", order: "day.desc.nullslast,id.asc", limit: "40" });
    assert.equal(appearances.body.length, 2);
    const played = appearances.body.find((row: { game_slug: string }) => row.game_slug === "club-played");
    assert.equal(played.minutes, 90);
    assert.equal(played.goals, 1);
    assert.equal(played.penalties, 1);
    assert.equal(played.own_goals, 1);
    assert.equal(played.contribution, -2);
    assert.equal(played.yellow, true);
    const archive = await read("game_archive", { week_key: "like.2026-10-05", limit: "40" });
    assert.equal(archive.body.length, 3);
    const attendance = await read("championship_attendance", { championship_id: `eq.${id(1)}`, limit: "40" });
    assert.equal(attendance.body.length, 3);
    const zero = attendance.body.find((row: { team_id: string }) => row.team_id === id(3));
    assert.equal(zero.attendance_count, 1);
    assert.equal(zero.total, 0);
    assert.equal(zero.average, 0);
    const missing = attendance.body.find((row: { team_id: string }) => row.team_id === id(4));
    assert.equal(missing.attendance_count, 0);
    assert.equal(missing.average, null);
    assert.equal(missing.minimum, null);
    assert.equal(missing.maximum, null);
  } finally {
    await db.close();
  }
});
