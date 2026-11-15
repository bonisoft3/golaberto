import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { DuckDBInstance } from "npm:@duckdb/node-api@1.5.6-r.1";
import { schema } from "../tests/portable-projections-fixture.ts";
import * as program from "../computations/standings.js";
import { rankGroup, retainForm } from "./standings.pure.js";
import { step } from "./bounded-standings.ts";
import { canonical, literal, quote } from "./standings-test.ts";

Deno.test("standings top-five state is independent of arrival order and bounded by team count", async () => {
  const rows = Array.from(
    { length: 218 * 100 },
    (_, i) => ({
      group_id: "g",
      team_id: String(i % 218),
      id: String(i).padStart(8, "0"),
      day: "2026-01-01",
      kickoff: null,
      result: "w",
    }),
  );
  const forms = retainForm({}, rows);
  assertEquals(retainForm({}, rows.toReversed()), forms);
  assertEquals(
    Object.values(forms).reduce(
      (sum: any, items: any) => sum + items.length,
      0,
    ),
    218 * 5,
  );
  const member = (team_id: string) => ({
    group_id: "g",
    team_id,
    team_name: team_id,
    sort: "g_average,name",
    points: 0,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goals_for: 1,
    goals_against: 2,
    goal_diff: -1,
  });
  assertEquals(
    rankGroup(
      Array.from({ length: 218 }, (_, i) => member(String(i))),
      [],
      forms,
    ).length,
    218,
  );
  await assertRejects(
    () => step({ query: () => Promise.resolve([]) }, { group: -1 }),
    Error,
    "invalid bounded standings checkpoint",
  );
});

Deno.test("compiled standings retain the crawled table and former stream comparator goldens", async () => {
  const cases = JSON.parse(
    await Deno.readTextFile(
      new URL("./standings-fixtures.json", import.meta.url),
    ),
  );
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    for (const table of program.reads) {
      await conn.run(
        `CREATE TABLE ${quote(table)} (${
          schema[table as keyof typeof schema]
        })`,
      );
    }
    for (const test of cases) {
      for (const table of program.reads) {
        await conn.run(`DELETE FROM ${quote(table)}`);
      }
      const source = test.input;
      const rows: Record<string, any[]> = {
        championship: [{ id: "c", ...source.phases[0].championship }],
        phase: source.phases.map((row: any) => ({
          ...row,
          championship_id: "c",
        })),
        stage_group: [source.group],
        team: source.members.map((row: any) => ({
          id: row.team_id,
          name: row.team.name,
        })),
        team_group: source.members.map((row: any, i: number) => ({
          ...row,
          id: String(i),
        })),
        game: source.games.map((row: any, i: number) => ({
          ...row,
          id: String(i),
          played: true,
        })),
        zone: source.zones.map((row: any, i: number) => ({
          ...row,
          id: String(i),
        })),
      };
      for (const [table, items] of Object.entries(rows)) {
        if (!items.length) continue;
        const fields = schema[table as keyof typeof schema].split(", ").map(
          (field) => field.split(" ")[0],
        );
        await conn.run(
          `INSERT INTO ${quote(table)} VALUES ${
            items.map((row) =>
              "(" + fields.map((field) => literal(row[field])).join(",") + ")"
            ).join(",")
          }`,
        );
      }
      const inputs: Record<string, any[]> = {};
      for (const [name, sql] of Object.entries(program.queries)) {
        inputs[name] = (await conn.runAndReadAll(sql)).getRowObjectsJson();
      }
      const actual = program.finish(inputs).standing.map((row: any) =>
        test.fields.map((field: string) => row[field])
      );
      assertEquals(actual, test.expected, test.name);
    }
  } finally {
    conn.closeSync();
    db.closeSync();
  }
});

Deno.test("standings member preparation stays within the archive memory budget", async () => {
  const dir = await Deno.makeTempDir({ prefix: "standings-members-" });
  const db = await DuckDBInstance.create(`${dir}/standings.duckdb`, { memory_limit: "32MB", threads: "1" });
  const conn = await db.connect();
  try {
    await conn.run("CREATE SCHEMA duckstream_private");
    await conn.run("CREATE TABLE duckstream_private.result_members(sequence BIGINT,value VARCHAR USING COMPRESSION UNCOMPRESSED)");
    await conn.run(`INSERT INTO duckstream_private.result_members
      SELECT i,json_object('group_id',printf('%08d',i%15000),'team_id',i::VARCHAR,
        'payload',repeat(md5(i::VARCHAR),30))::VARCHAR FROM range(58000) t(i)`);
    await conn.run("CHECKPOINT");
    await assertRejects(() => conn.run(`CREATE TABLE unbounded_members AS
      SELECT sequence,value,value->>'group_id' AS group_id FROM duckstream_private.result_members ORDER BY group_id,sequence`), Error, "Out of Memory");
    let checkpoint: unknown = null;
    for (let i = 0; i < 64; i++) {
      const result = await step({ query: () => { throw new Error('unexpected query') } }, checkpoint);
      for (const statement of result.statements ?? []) await conn.run(statement);
      await conn.run("CHECKPOINT");
      checkpoint = result.checkpoint;
    }
    const union = Array.from({ length: 64 }, (_, i) => `SELECT sequence,group_id,${i} AS bucket FROM standings_members_${i}`).join(' UNION ALL ');
    const [actual] = (await conn.runAndReadAll(`SELECT count(*)::INTEGER AS rows,count(DISTINCT sequence)::INTEGER AS distinct_rows,
      count(*) FILTER (WHERE bucket <> hash(group_id)%64)::INTEGER AS misplaced FROM (${union})`)).getRowObjectsJson();
    assertEquals(actual, { rows: 58000, distinct_rows: 58000, misplaced: 0 });
    for (let i = 0; i < 64; i++) await conn.run(`UPDATE standings_members_${i} SET value=json_merge_patch(value,
      '{"team_name":"team","sort":"pt,name","points":0,"played":0,"wins":0,"draws":0,"losses":0,"goals_for":0,"goals_against":0,"goal_diff":0}')::VARCHAR
      WHERE group_id < '00000064'`);
    await conn.run("CREATE TABLE standings_zones(sequence BIGINT,value VARCHAR,group_id VARCHAR)");
    for (let i = 0; i < 64; i++) {
      await conn.run(`CREATE TABLE standings_form_${i}(sequence BIGINT,value VARCHAR,group_id VARCHAR)`);
      await conn.run(`INSERT INTO standings_form_${i}
        SELECT n,json_object('group_id',g,'team_id',n::VARCHAR,'id',n::VARCHAR,'day','2026-01-01',
          'kickoff',NULL,'result','w','payload',repeat(md5(n::VARCHAR),12))::VARCHAR,g
        FROM (SELECT n,printf('%08d',n%32) AS g FROM range(320000) t(n)) WHERE hash(g)%64=${i}`);
      await conn.run('CHECKPOINT');
    }
    await conn.run(`CREATE TABLE duckstream_private.result_groups AS SELECT i+1 AS sequence,
      json_object('id',printf('%08d',i))::VARCHAR AS value FROM range(64) t(i)`);
    const start = performance.now();
    let maxBranches = 0;
    const host = { query: async (sql: string) => {
      maxBranches = Math.max(maxBranches, sql.split(' UNION ALL ').length);
      const wrapped = `WITH execution_rows AS MATERIALIZED (SELECT to_json(r)::VARCHAR AS value FROM (${sql}) r),
        execution_size AS (SELECT COALESCE(sum(octet_length(encode(value))+1),0)+1 AS bytes FROM execution_rows)
        SELECT CASE WHEN execution_size.bytes>8388608 THEN error('execution query exceeds byte limit') ELSE execution_rows.value END AS value
        FROM execution_rows CROSS JOIN execution_size`;
      return (await conn.runAndReadAll(wrapped)).getRowObjectsJson().map(row => JSON.parse(String(row.value)));
    } };
    const result = await step(host, { group: 0, form: 0, forms: {}, after: 0, ready: false });
    assertEquals((result.checkpoint as { form: number }).form > 0, true);
    const batch = await step(host, { group: 32, form: 0, forms: {}, after: 0, ready: false });
    assertEquals((batch.checkpoint as { group: number }).group, 64);
    assertEquals(batch.writes.standing?.length, 128);
    assertEquals(maxBranches, 4);
    console.log(`32-group standings scan: ${(performance.now() - start).toFixed(0)} ms at 32 MB`);
  } finally { conn.closeSync(); db.closeSync(); await Deno.remove(dir, { recursive: true }); }
});

Deno.test("batched standings preserve ranking and replay across empty and oversized groups", async () => {
  const db = await DuckDBInstance.create(":memory:", { memory_limit: "32MB", threads: "1" });
  const conn = await db.connect();
  try {
    await conn.run("CREATE SCHEMA duckstream_private");
    const groups = Array.from({ length: 21 }, (_, i) => ({ id: `g${i}` }));
    const members = groups.flatMap((group, i) => Array.from({ length: i === 5 ? 0 : i === 9 ? 130 : i === 20 ? 8 : i >= 18 ? 4 : 5 }, (_, n) => ({
      group_id: group.id, team_id: `t${n}`, team_name: i >= 18 ? `é\\"${n}`.repeat(8000) : `team${n}`, sort: "pt,name", points: n % 2,
      played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0, goal_diff: 0,
    })));
    const form = members.slice(0, 20).flatMap((member, n) => Array.from({ length: 7 }, (_, i) => ({
      group_id: member.group_id, team_id: member.team_id, id: `game${i}`,
      day: i % 3 ? "2026-01-01" : null, kickoff: i % 2 ? null : "12:00", result: (i + n) % 2 ? "w" : "l",
    })));
    const inputs = { groups, members, form, zones: [] };
    for (const [name, rows] of Object.entries(inputs)) {
      await conn.run(`CREATE TABLE duckstream_private.result_${name}(sequence BIGINT,value VARCHAR)`);
      if (rows.length) await conn.run(`INSERT INTO duckstream_private.result_${name} VALUES ${rows.map((row, i) => `(${i + 1},${literal(JSON.stringify(row))})`).join(",")}`);
    }
    const host = { query: async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() };
    let checkpoint: unknown = null;
    const result: any[] = [];
    let writes = 0, partial = false, byteBoundary = false;
    for (let i = 0; i < 250; i++) {
      const next = await step(host, checkpoint);
      assertEquals(await step(host, checkpoint), next, "replay from the last durable checkpoint");
      for (const sql of next.statements ?? []) await conn.run(sql);
      if (next.writes.standing) {
        assertEquals(new TextEncoder().encode(JSON.stringify(next.writes.standing)).length <= 256 * 1024, true);
        result.push(...next.writes.standing); writes++;
      }
      checkpoint = JSON.parse(JSON.stringify(next.checkpoint));
      if ((checkpoint as { group?: number }).group === 19 && !(checkpoint as { after?: number }).after) byteBoundary = true;
      if ((checkpoint as { after?: number }).after) partial = true;
      if (next.done) break;
      if (i === 249) throw new Error("standings did not finish");
    }
    assertEquals(canonical(result), canonical(program.finish(inputs).standing));
    assertEquals(writes > 4, true);
    assertEquals(byteBoundary, true, "output byte limit advances only the fully accepted group");
    assertEquals(partial, true, "oversized group uses the paged output path");
  } finally { conn.closeSync(); db.closeSync(); }
});

Deno.test("standings grouped scans avoid the archive-shaped 32 MB form union failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "standings-skew-" });
  const db = await DuckDBInstance.create(`${dir}/archive.duckdb`, { memory_limit: "32MB", threads: "1" });
  const conn = await db.connect();
  try {
    await conn.run("CREATE SCHEMA duckstream_private");
    const id = "'a0400000-0000-4000-8000-'||lpad(to_hex(i%15566),12,'0')";
    await conn.run(`CREATE TABLE duckstream_private.result_groups AS SELECT i+1 AS sequence,json_object('id',${id})::VARCHAR AS value FROM range(15566) t(i)`);
    for (let b = 0; b < 64; b++) {
      await conn.run(`CREATE TABLE standings_members_${b} AS SELECT i AS sequence,
        json_object('group_id',g,'team_id',i::VARCHAR,'team_name','team','sort','pt,name','points',0,'played',0,'wins',0,'draws',0,'losses',0,'goals_for',0,'goals_against',0,'goal_diff',0,'padding',repeat('p',100))::VARCHAR AS value,g AS group_id
        FROM (SELECT i,${id} g FROM range(58440) t(i)) WHERE hash(g)%64=${b} ORDER BY g,i`);
      await conn.run(`CREATE TABLE standings_form_${b} AS SELECT i AS sequence,
        json_object('group_id',g,'team_id',(i%58440)::VARCHAR,'id',i::VARCHAR,'day','2026-01-01','kickoff',NULL,'result','w','padding',repeat('p',80))::VARCHAR AS value,g AS group_id
        FROM (SELECT i,'a0400000-0000-4000-8000-'||lpad(to_hex(CASE WHEN i<1104 THEN 255 WHEN i<1400 THEN 256 ELSE i%15566 END),12,'0') g FROM range(300000) t(i)) WHERE hash(g)%64=${b} ORDER BY g,i`);
      await conn.run('CHECKPOINT');
    }
    await conn.run(`CREATE TABLE standings_zones AS SELECT i AS sequence,
      json_object('id',i::VARCHAR,'group_id',g,'color','blue','first',1,'last',3,'positions','')::VARCHAR AS value,g AS group_id
      FROM (SELECT i,${id} g FROM range(16379) t(i))`);
    const query = async (sql: string) => {
      const wrapped = `WITH execution_rows AS MATERIALIZED (SELECT to_json(r)::VARCHAR AS value FROM (${sql}) r),
        execution_size AS (SELECT COALESCE(sum(octet_length(encode(value))+1),0)+1 AS bytes FROM execution_rows)
        SELECT CASE WHEN execution_size.bytes>8388608 THEN error('execution query exceeds byte limit') ELSE execution_rows.value END AS value
        FROM execution_rows CROSS JOIN execution_size`;
      return (await conn.runAndReadAll(wrapped)).getRowObjectsJson().map((row) => JSON.parse(String(row.value)));
    };
    const candidates = await query(`SELECT value,CAST(hash(value->>'id') % 64 AS INTEGER) AS bucket
      FROM duckstream_private.result_groups WHERE sequence>253 ORDER BY sequence LIMIT 32`);
    const old = candidates.map((row, i) => `SELECT ${i} AS idx,'form' AS kind,sequence::DOUBLE AS sequence,value FROM standings_form_${row.bucket} WHERE group_id=${literal(JSON.parse(row.value).id)}`).join(' UNION ALL ') + ' ORDER BY idx,sequence';
    await assertRejects(() => query(old), Error, 'Out of Memory');
    const result = await step({ query }, { group: 253, form: 0, forms: {}, after: 0, ready: false });
    assertEquals((result.checkpoint as { group: number }).group, 285);
    assertEquals(result.writes.standing?.length, 128);
  } finally { conn.closeSync(); db.closeSync(); await Deno.remove(dir, { recursive: true }); }
});
