import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
type Row = Record<string, any>;
const sql = await Deno.readTextFile(new URL('../services/database/sql/050_portable_projections.sql', import.meta.url));
export const schema = {
  championship: 'id text primary key, full_name text, point_win int default 3, point_draw int default 1, point_loss int default 0, category_id text',
  phase: "id text primary key, championship_id text, name text, sort text default 'pt,w,gd,gf,name', bonus_points int default 0, bonus_points_threshold int default 0",
  stage_group: 'id text primary key, phase_id text', team: 'id text primary key, name text',
  team_group: 'id text primary key, group_id text, team_id text, add_sub int default 0, bias int default 0',
  zone: 'id text primary key, group_id text, color text, first int, last int, positions text',
  game: 'id text primary key, phase_id text, round int, day date, kickoff timestamptz, played boolean, home_id text, away_id text, home_score int, away_score int, home_aet int, away_aet int, home_pen int, away_pen int, stadium_id text, referee_id text, attendance int, sync_status text',
  stadium: 'id text primary key, name text', referee: 'id text primary key, name text',
  player: 'id text primary key, name text, position text',
  player_game: 'id text primary key, game_id text, player_id text, side text, on_minute int, off_minute int, yellow bool, red bool, bench bool',
  goal: 'id text primary key, game_id text, player_id text, side text, penalty bool, own_goal bool',
  standing: 'id text primary key, group_id text, team_id text, team_name text, position int, points int, played int, wins int, draws int, losses int, goals_for int, goals_against int, goal_diff int, form1 text, form2 text, form3 text, form4 text, form5 text, zone text',
  game_card: 'id text primary key, phase_id text, championship_id text, round int, day date, kickoff timestamptz, played bool, home_id text, away_id text, home_name text, away_name text, home_score int, away_score int, home_aet int, away_aet int, home_pen int, away_pen int, championship_name text, phase_name text, stadium_id text, stadium_name text, referee_id text, referee_name text, attendance int',
  team_game: 'id text primary key, team_id text, game_id text, side text, opponent_id text, opponent_name text, championship_id text, championship_name text, day date, kickoff timestamptz, played bool, goals_for int, goals_against int, result text',
  player_stat: 'id text primary key, championship_id text, team_id text, player_id text, player_name text, position text, played int, started int, came_on int, bench int, minutes int, goals int, penalties int, own_goals int, yellow int, red int, championship_name text, team_name text, off_rating double precision, def_rating double precision, contribution double precision, contribution_per90 double precision, goals_per90 double precision',
  phase_round: 'id text primary key, phase_id text, current int, next int',
};
export async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE service;
    ${Object.entries(schema).map(([table, fields]) => `CREATE TABLE ${table} (${fields});`).join('\n')}
    CREATE FUNCTION take_team_projection_turn() RETURNS void LANGUAGE sql AS 'SELECT pg_advisory_xact_lock(715030,1)';
    CREATE FUNCTION take_team_projection_write_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM take_team_projection_turn(); RETURN NULL; END $$;
    CREATE TABLE audit(table_name text);
    CREATE FUNCTION audit_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit VALUES(TG_TABLE_NAME); RETURN NULL; END $$;
    ${['standing', 'game_card', 'team_game', 'player_stat', 'phase_round'].map(t => `CREATE TRIGGER audit_projection AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION audit_projection();`).join('\n')}
    GRANT USAGE ON SCHEMA public TO service; GRANT ALL ON ALL TABLES IN SCHEMA public TO service;`);
  await db.exec(sql);
  return db;
}
export async function insert(db: PGlite, table: keyof typeof schema, rows: Row[]) {
  if (!rows.length) return;
  const fields = schema[table].split(', ').map(f => f.split(' ')[0]).filter(f => rows.some(row => f in row));
  const names = fields.map(f => `"${f}"`).join(',');
  await db.query(`INSERT INTO ${table} (${names}) SELECT ${names} FROM json_populate_recordset(NULL::${table},$1::json) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(rows)]);
}
