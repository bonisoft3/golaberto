import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
import { assertEquals } from 'jsr:@std/assert@1.0.11';
import { parse } from 'jsr:@std/yaml@1.0.9';

type Row = Record<string, any>;
import { fixture, insert, schema } from './portable-projections-fixture.ts';
import { projectionParity } from '../duckstream/projection-parity.ts';
async function golden(name: string): Promise<Row[]> {
  const contents = await Deno.readTextFile(new URL(["player-stats","game-cards"].includes(name) ? `./fixtures/${name}.yaml` : `../pipelines/${name}_benthos_test.yaml`, import.meta.url));
  return (parse(contents) as Row).tests;
}
async function clear(db: PGlite) {
  await db.exec(`TRUNCATE ${Object.keys(schema).join(',')},audit`);
}
async function stable(db: PGlite, call: string) {
  const versions = async () => await Promise.all(['standing', 'game_card', 'team_game', 'player_stat', 'phase_round']
    .map(async table => (await db.query(`SELECT id,xmin::text,xmax::text,ctid::text FROM ${table} ORDER BY id`)).rows));
  const before = await versions();
  await db.exec(`TRUNCATE audit; SET ROLE service; SELECT ${call}(); RESET ROLE;`);
  assertEquals((await db.query('SELECT * FROM audit')).rows, [], `${call} changed unchanged rows`);
  // A false ON CONFLICT update still locks the tuple and changes xmax without firing an update trigger.
  assertEquals(await versions(), before, `${call} locked unchanged rows`);
  if (call === 'refresh_game_cards' || call === 'refresh_player_stats') await projectionParity(db, call, schema);
}

Deno.test('portable standings match all six existing pure standings goldens', async () => {
  const db = await fixture();
  try {
    const cases = JSON.parse(await Deno.readTextFile(new URL('../duckstream/standings-fixtures.json', import.meta.url)));
    assertEquals(cases.length, 6);
    for (const test of cases) {
      await clear(db);
      const input = test.input;
      await insert(db, 'championship', [{ id: 'c', ...input.phases[0].championship }]);
      await insert(db, 'phase', input.phases.map((p: Row) => ({ ...p, championship_id: 'c' })));
      await insert(db, 'stage_group', [input.group]);
      await insert(db, 'team', input.members.map((m: Row) => ({ id: m.team_id, name: m.team.name })));
      await insert(db, 'team_group', input.members.map((m: Row, i: number) => ({ id: String(i), ...m })));
      await insert(db, 'game', input.games.map((g: Row, i: number) => ({ ...g, id: g.id ?? String(i).padStart(8, '0'), played: true })));
      await insert(db, 'zone', input.zones.map((z: Row, i: number) => ({ id: String(i), ...z })));
      await db.exec('SET ROLE service; SELECT refresh_standings(); RESET ROLE');
      const { rows } = await db.query<Row>('SELECT * FROM standing ORDER BY position');
      assertEquals(rows.map(row => test.fields.map((field: string) => row[field])), test.expected, test.name);
      await stable(db, 'refresh_standings');
    }
  } finally { await db.close(); }
});

Deno.test('portable player counters match the existing 885-player golden and retain independent metrics', async () => {
  const db = await fixture();
  try {
    const test = (await golden('player-stats'))[0];
    assertEquals(test.input_batch.length, 885);
    const teams = new Map<string, Row>(); const games: Row[] = []; const apps: Row[] = []; const goals: Row[] = []; const players: Row[] = [];
    await insert(db, 'championship', [{ id: 'c', full_name: 'C' }]);
    await insert(db, 'phase', [{ id: 'phase', championship_id: 'c' }]);
    for (let i = 0; i < test.input_batch.length; i++) {
      const input = JSON.parse(test.input_batch[i].content);
      players.push({ id: String(i), ...input.player_row });
      for (const [kind, entries] of [['app', input.apps], ['goal', input.goals]] as const) {
        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j]; const game = entry.game; const id = `${i}:${kind}:${j}`;
          teams.set(game.home_id, { id: game.home_id, name: game.home.name });
          teams.set(game.away_id, { id: game.away_id, name: game.away.name });
          games.push({ id, phase_id: 'phase', home_id: game.home_id, away_id: game.away_id });
          (kind === 'app' ? apps : goals).push({ ...entry, id, game_id: id, player_id: String(i) });
        }
      }
    }
    await insert(db, 'team', [...teams.values()]); await insert(db, 'player', players);
    await insert(db, 'game', games); await insert(db, 'player_game', apps); await insert(db, 'goal', goals);
    await db.exec('SET ROLE service; SELECT refresh_player_stats(); RESET ROLE');
    const result = (await db.query<Row>('SELECT * FROM player_stat ORDER BY team_id COLLATE "C"')).rows;
    for (let i = 0; i < test.input_batch.length; i++) {
      const expression: string = test.output_batches[0][i].bloblang;
      const [projection, expected] = expression.split(' == ');
      const fields = [...projection.matchAll(/r\.(\w+)/g)].map(match => match[1]);
      assertEquals(result.filter(row => row.player_id === String(i)).map(row => fields.map(field => row[field])), JSON.parse(expected), `player ${i}`);
    }
    await db.exec('UPDATE player_stat SET off_rating=42,def_rating=17,contribution=59,contribution_per90=4,goals_per90=2');
    await stable(db, 'refresh_player_stats');
    assertEquals((await db.query('SELECT DISTINCT off_rating,def_rating,contribution,contribution_per90,goals_per90 FROM player_stat')).rows,
      [{ off_rating: 42, def_rating: 17, contribution: 59, contribution_per90: 4, goals_per90: 2 }]);
    await db.exec("DELETE FROM player_game WHERE player_id='0'; DELETE FROM goal WHERE player_id='0'; SELECT refresh_player_stats()");
    assertEquals((await db.query("SELECT * FROM player_stat WHERE player_id='0'")).rows, []);
  } finally { await db.close(); }
});

Deno.test('portable rounds match sparse and empty phase goldens', async () => {
  const db = await fixture();
  try {
    const tests = (await golden('rounds')).filter(t => t.target_processors === '/pipeline/processors/1/try/4');
    assertEquals(tests.length, 5);
    for (const test of tests) {
      await clear(db);
      const input = JSON.parse(test.input_batch[0].content);
      await insert(db, 'phase', [{ id: input.phase }]);
      await insert(db, 'game', input.games.map((g: Row, i: number) => ({ id: String(i), phase_id: input.phase, ...g })));
      await insert(db, 'phase_round', [{ id: input.phase, phase_id: input.phase, current: 99, next: 100 }]);
      await db.exec('SET ROLE service; SELECT refresh_phase_rounds(); RESET ROLE');
      const actual = (await db.query('SELECT * FROM phase_round')).rows;
      const expected = test.output_batches[0][0];
      assertEquals(actual, expected.metadata_equals?.sink === 'delete' ? [] : [JSON.parse(expected.bloblang.split(' == ')[1])], test.name);
      await stable(db, 'refresh_phase_rounds');
    }
  } finally { await db.close(); }
});

Deno.test('portable cards preserve both sides, rename fanout, replacement and deletion', async () => {
  const db = await fixture();
  try {
    const tests = (await golden('game-cards')).filter(t => t.target_processors === '/pipeline/processors/1/try/3');
    for (const test of tests) {
      await clear(db);
      const g = JSON.parse(test.input_batch[0].content);
      await insert(db, 'championship', [{ id: g.phase.championship_id, full_name: g.phase.championship.full_name }]);
      await insert(db, 'phase', [{ id: g.phase_id, championship_id: g.phase.championship_id, name: g.phase.name }]);
      await insert(db, 'team', [{ id: g.home_id, name: g.home.name }, { id: g.away_id, name: g.away.name }, { id: 'replacement', name: 'Replacement' }]);
      if (g.stadium) { g.stadium_id = 'stadium'; await insert(db, 'stadium', [{ id: 'stadium', name: g.stadium.name }]); }
      await insert(db, 'game', [g]);
      await db.exec('SET ROLE service; SELECT refresh_game_cards(); RESET ROLE');
      const card = (await db.query<Row>('SELECT * FROM game_card')).rows[0];
      assertEquals([card.home_name, card.away_name, card.championship_name, card.stadium_name], [g.home.name, g.away.name, g.phase.championship.full_name, g.stadium?.name ?? null]);
      const lines = (await db.query<Row>("SELECT * FROM team_game ORDER BY side DESC")).rows;
      assertEquals(lines.map(r => [r.id, r.opponent_name, r.goals_for, r.goals_against, r.result]), [
        [`${g.home_id}:${g.id}`, g.away.name, g.home_score, g.away_score, g.played ? 'w' : ''],
        [`${g.away_id}:${g.id}`, g.home.name, g.away_score, g.home_score, g.played ? 'l' : ''],
      ]);
      await stable(db, 'refresh_game_cards');
      for (const [status, played] of [['cancelled', false], ['abandoned', false], ['awarded', false], ['postponed', false], ['cancelled', true]] as const) {
        await db.query('UPDATE game SET sync_status=$1, played=$2', [status, played]);
        await db.exec('SELECT refresh_game_cards()');
        await projectionParity(db, 'refresh_game_cards', schema);
      }
      await db.query('UPDATE game SET sync_status=NULL, played=$1', [g.played]);
      await db.exec('SELECT refresh_game_cards()');
      await db.exec("UPDATE team SET name='Renamed' WHERE id='h'; SELECT refresh_game_cards()");
      assertEquals((await db.query<Row>('SELECT home_name FROM game_card')).rows[0].home_name, 'Renamed');
      assertEquals((await db.query<Row>("SELECT opponent_name FROM team_game WHERE side='away'")).rows[0].opponent_name, 'Renamed');
      await db.exec("UPDATE game SET home_id='replacement'; SELECT refresh_game_cards()");
      assertEquals((await db.query("SELECT * FROM team_game WHERE team_id='h'")).rows, []);
      await db.exec('DELETE FROM game; SELECT refresh_game_cards()');
      assertEquals((await db.query('SELECT * FROM game_card')).rows, []);
      assertEquals((await db.query('SELECT * FROM team_game')).rows, []);
    }
  } finally { await db.close(); }
});

Deno.test('standings recount form order, cross-group opponents and removed membership; player minutes never go negative', async () => {
  const db = await fixture();
  try {
    await insert(db, 'championship', [{ id: 'c', point_win: 3, point_draw: 1, point_loss: 0 }]);
    await insert(db, 'phase', [{ id: 'p', championship_id: 'c', sort: 'pt,name', bonus_points: 1, bonus_points_threshold: 2 }]);
    await insert(db, 'stage_group', [{ id: 'group', phase_id: 'p' }]);
    await insert(db, 'team', [{ id: 'h', name: 'H' }, { id: 'a', name: 'A' }]);
    await insert(db, 'team_group', [{ id: 'member', group_id: 'group', team_id: 'h', add_sub: -1, bias: 0 }]);
    await insert(db, 'game', [
      { id: 'late', phase_id: 'p', day: '2026-01-01', kickoff: '2026-01-01T12:00:00Z', home_id: 'h', away_id: 'a', home_score: 0, away_score: 1, played: true },
      { id: 'early', phase_id: 'p', day: '2026-01-01', home_id: 'h', away_id: 'a', home_score: 3, away_score: 0, played: true },
    ]);
    await db.exec('SELECT refresh_standings()');
    assertEquals((await db.query('SELECT points,played,form1,form2,form3,form4,form5 FROM standing')).rows,
      [{ points: 3, played: 2, form1: '', form2: '', form3: '', form4: 'w', form5: 'l' }]);
    await db.exec('DELETE FROM team_group; SELECT refresh_standings()');
    assertEquals((await db.query('SELECT * FROM standing')).rows, []);
    await insert(db, 'player', [{ id: 'player', name: 'P' }]);
    await insert(db, 'player_game', [
      { id: 'one', player_id: 'player', game_id: 'early', side: 'home', on_minute: 94, bench: false },
      { id: 'two', player_id: 'player', game_id: 'late', side: 'home', on_minute: 70, off_minute: 20, bench: false },
    ]);
    await db.exec('SELECT refresh_player_stats()');
    assertEquals((await db.query('SELECT played,minutes FROM player_stat')).rows, [{ played: 2, minutes: 0 }]);
    await projectionParity(db, 'refresh_player_stats', schema);
  } finally { await db.close(); }
});

Deno.test('portable recount memory limits are function-local and restore serving settings', async () => {
  const db = await fixture();
  try {
    await db.exec(`SET work_mem='8MB'; SET hash_mem_multiplier=2;
      CREATE TABLE memory_settings(work text, hash text);
      CREATE OR REPLACE FUNCTION take_team_projection_turn() RETURNS void LANGUAGE sql AS $$
        INSERT INTO memory_settings VALUES(current_setting('work_mem'),current_setting('hash_mem_multiplier'))
      $$;
      SELECT refresh_standings(); SELECT refresh_game_cards(); SELECT refresh_player_stats(); SELECT refresh_phase_rounds();`);
    assertEquals((await db.query('SELECT * FROM memory_settings')).rows,
      Array.from({ length: 4 }, () => ({ work: '1MB', hash: '1' })));
    assertEquals((await db.query("SELECT current_setting('work_mem') AS work,current_setting('hash_mem_multiplier') AS hash")).rows,
      [{ work: '8MB', hash: '2' }]);
  } finally { await db.close(); }
});
