import { assertEquals, assertRejects } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
const id = (kind: number, n: number) => `a${kind.toString(16).padStart(2, "0")}00000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const source = 900001;
const snapshot = {
  path: `/championship/show/${source}-refresh-fixture`,
  phases: [{ upstream: source, name: "League A", position: 0,
    groups: [{ upstream: source, name: "Group A", zones: [], teams: [
      { upstream: source, name: "O'Brien" }, { upstream: source + 1, name: "Visitor" },
    ] }],
    games: [
      { upstream: source, round: 1, date: "02/10/2026", time: "00:30", home: "O'Brien", away: "Visitor", played: true, score: [2, 1] },
      { upstream: source + 1, round: 2, date: "03/10/2026", time: "", home: "Visitor", away: "O'Brien", played: false },
    ],
  }],
};

async function patch(data = snapshot) {
  const process = new Deno.Command("python3", { args: ["-c",
    "import json,sys; sys.path.insert(0,'tools'); from refresh_archive import prepare; print(prepare([json.loads(sys.argv[1])]))", JSON.stringify(data)], stdout: "piped", stderr: "piped" }).output();
  const result = await process;
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).replace("\\set ON_ERROR_STOP on", "").replace("BEGIN;", "").replace("COMMIT;", "");
}

async function query(sql: string) {
  const result = await new Deno.Command("docker", { args: ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", `BEGIN; ${sql} ROLLBACK;`] }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean).at(-1);
}

const parents = `
  INSERT INTO championship(id,name,region_name,begins,ends) VALUES('${id(2, source)}','Refresh fixture','Test','2026-01-01','2026-12-31');
  INSERT INTO team(id,name,country) VALUES('${id(7, source)}','O''Brien','Test'),('${id(7, source + 1)}','Visitor','Test');
`;

Deno.test("public refresh converts UTC dates, preserves unknown times and local details, and replays without writes", async () => {
  const sql = await patch();
  assertEquals(JSON.parse((await query(`${parents}
    INSERT INTO phase(id,championship_id,name) VALUES('${id(3, source)}','${id(2, source)}','League A');
    INSERT INTO game(id,phase_id,day,home_id,away_id,attendance,home_field) VALUES('${id(9, source)}','${id(3, source)}','2026-09-01','${id(7, source)}','${id(7, source + 1)}',1234,'neutral');
    ${sql}
    CREATE TEMP TABLE versions AS SELECT id,ctid::text version FROM game WHERE phase_id='${id(3, source)}';
    ${sql}
    SELECT json_build_object('day',(SELECT day FROM game WHERE id='${id(9, source)}'),
      'kickoff',(SELECT kickoff AT TIME ZONE 'UTC' FROM game WHERE id='${id(9, source)}'),
      'unknown',(SELECT kickoff IS NULL AND NOT played AND home_score IS NULL FROM game WHERE id='${id(9, source + 1)}'),
      'localDetails',(SELECT attendance=1234 AND home_field='neutral' AND home_score=2 AND away_score=1 FROM game WHERE id='${id(9, source)}'),
      'members',(SELECT count(*) FROM team_group WHERE group_id='${id(4, source)}'),
      'replayWrites',(SELECT count(*) FROM game g JOIN versions v USING(id) WHERE g.ctid::text<>v.version));
  `))!), { day: "2026-10-01", kickoff: "2026-10-02T00:30:00", unknown: true, localDetails: true, members: 2, replayWrites: 0 });
});

Deno.test("public refresh rejects a seed database without the imported championship mapping", async () => {
  const sql = await patch();
  await assertRejects(() => query(sql), Error, "Import the legacy archive first");
});

Deno.test("public refresh imports Portuguese zone roles and preserves an existing editorial zone", async () => {
  const data = structuredClone(snapshot);
  const group = data.phases[0].groups[0];
  Object.assign(group, { zones: [
    { name: "Campeão", first: 1, last: 1 },
    { name: "Promoção", first: 1, last: 1 },
    { name: "Rebaixamento", first: 2, last: 2 },
  ] });
  const sql = await patch(data);
  assertEquals(JSON.parse((await query(`${parents} ${sql}
    CREATE TEMP TABLE imported_colors AS SELECT json_agg(color ORDER BY id) colors FROM zone WHERE group_id='${id(4, source)}';
    UPDATE zone SET name='Editor choice',color='playoff' WHERE id='${id(5, source * 10000)}';
    ${sql}
    SELECT json_build_object('colors',(SELECT colors FROM imported_colors),'preserved',
      (SELECT name='Editor choice' AND color='playoff' FROM zone WHERE id='${id(5, source * 10000)}'));
  `))!), { colors: ["champion", "promotion", "relegation"], preserved: true });
});
