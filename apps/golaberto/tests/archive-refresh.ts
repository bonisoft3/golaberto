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
  const result = await new Deno.Command("docker", { args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", `BEGIN; ${sql} ROLLBACK;`] }).output();
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

Deno.test("public refresh imports arbitrary source colors and positions and preserves an existing editorial zone", async () => {
  const data = structuredClone(snapshot);
  const group = data.phases[0].groups[0];
  Object.assign(group, { zones: [
    { name: "Campeão", color: "#Ab12Cd", positions:[1], first: 1, last: 1 },
    { name: "Arbitrary name", color: "#112233", positions:[1,3], first: 1, last: 3 },
    { name: "Rebaixamento", color: "lightgreen", positions:[2], first: 2, last: 2 },
  ] });
  const sql = await patch(data);
  assertEquals(JSON.parse((await query(`${parents} ${sql}
    CREATE TEMP TABLE imported_colors AS SELECT json_agg(color ORDER BY id) colors FROM zone WHERE group_id='${id(4, source)}';
    UPDATE zone SET name='Editor choice',color='#8a2be2' WHERE id='${id(5, source * 10000)}';
    ${sql}
    SELECT json_build_object('colors',(SELECT colors FROM imported_colors),'preserved',
      (SELECT name='Editor choice' AND color='#8a2be2' FROM zone WHERE id='${id(5, source * 10000)}'));
  `))!), { colors: ["#ab12cd", "#112233", "#90ee90"], preserved: true });
});

async function restoredZones(definitions: Array<Record<string, unknown>>) {
  const run=await new Deno.Command("python3",{args:["-c","import sys,json; sys.path.insert(0,'tools'); from restore_legacy_zones import prepare; print(prepare(json.loads(sys.argv[1])))",JSON.stringify([[source,definitions]])],stdout:"piped",stderr:"piped"}).output();
  if(!run.success)throw new Error(new TextDecoder().decode(run.stderr));
  return new TextDecoder().decode(run.stdout).replace("\\set ON_ERROR_STOP on","").replace(/^BEGIN;$/m,"").replace(/^COMMIT;$/m,"");
}

Deno.test("legacy zone restoration consolidates fragments, preserves editor colors and replays", async()=>{
  const sql=await restoredZones([{name:"Wide zone",color:"#a1b2c3",position:[1,3]},{name:"Editor",color:"#112233",position:[2]}]);
  const replay=sql.replace(/CREATE TEMP TABLE[^;]*;/g,"").replace(/INSERT INTO source_(zone|fragment)[\s\S]*?;/g,"");
  assertEquals(JSON.parse((await query(`${parents}
    INSERT INTO phase(id,championship_id,name) VALUES('${id(3,source)}','${id(2,source)}','Zone phase');
    INSERT INTO stage_group(id,phase_id,name) VALUES('${id(4,source)}','${id(3,source)}','Zone group');
    INSERT INTO zone(id,group_id,name,color,first,last) VALUES
      ('${id(5,source*10000)}','${id(4,source)}','Wide zone','qualify',1,1),
      ('${id(5,source*10000+1)}','${id(4,source)}','Wide zone','qualify',3,3),
      ('${id(5,source*10000+100)}','${id(4,source)}','Editor','#8a2be2',2,2);
    INSERT INTO team(id,name,country) VALUES('${id(7,source+2)}','Zero chance','Test');
    INSERT INTO team_group(group_id,team_id) VALUES
      ('${id(4,source)}','${id(7,source)}'),('${id(4,source)}','${id(7,source+1)}'),('${id(4,source)}','${id(7,source+2)}');
    INSERT INTO position_chance(id,group_id,team_id,position,percent,band,current,reach)
    SELECT ('a0e00000-0000-4000-8000-'||lpad(to_hex(${source*100} + t*10+p),12,'0'))::uuid,'${id(4,source)}',
      ('a0700000-0000-4000-8000-'||lpad(to_hex(${source}+t),12,'0'))::uuid,p,
      CASE WHEN t=2 THEN CASE p WHEN 2 THEN 100 ELSE 0 END ELSE CASE p WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END END,
      0,p=1,CASE WHEN t=2 AND p=1 THEN 'impossible' WHEN t=2 AND p=3 THEN 'reachable' ELSE '' END
    FROM generate_series(0,2) t CROSS JOIN generate_series(1,3) p WHERE t<>1 OR p<>3;
    INSERT INTO zone_chance(id,group_id,team_id,zone_id,first,last,percent,color,band,reach)
    SELECT ('a0f00000-0000-4000-8000-'||lpad(to_hex(${source}+t),12,'0'))::uuid,'${id(4,source)}',
      ('a0700000-0000-4000-8000-'||lpad(to_hex(${source}+t),12,'0'))::uuid,'${id(5,source*10000)}',1,1,
      CASE WHEN t=2 THEN 0 ELSE 10 END,'qualify',2,CASE WHEN t=2 THEN 'impossible' ELSE '' END
    FROM generate_series(0,2) t;
    INSERT INTO zone_chance(id,group_id,team_id,zone_id,first,last,percent,color,band,reach)
      VALUES('${id(15,source+3)}','${id(4,source)}','${id(7,source)}','${id(5,source*10000+1)}',3,3,60,'qualify',4,'');
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,position,percent,source)
    SELECT '${id(4,source)}:${id(7,source)}:2026-01-01:'||p,'${id(4,source)}','${id(7,source)}','2026-01-01',p,
      CASE p WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END,'imported' FROM generate_series(1,3) p;
    CREATE TEMP TABLE source_history_before AS SELECT md5(string_agg(to_jsonb(h)::text,'' ORDER BY id)) AS hash
      FROM team_odds_history h WHERE group_id='${id(4,source)}';
    ${sql}
    CREATE TEMP TABLE restored_cells AS SELECT json_build_object(
      'percent',(SELECT percent FROM zone_chance WHERE id='${id(15,source)}'),
      'bounds',(SELECT json_build_array(first,last,position,band) FROM zone_chance WHERE id='${id(15,source)}'),
      'reach',(SELECT reach FROM zone_chance WHERE id='${id(15,source)}'),
      'color',(SELECT color FROM zone_chance WHERE id='${id(15,source)}'),
      'incompleteRemoved',NOT EXISTS(SELECT 1 FROM zone_chance WHERE id='${id(15,source+1)}'),
      'fragmentRemoved',NOT EXISTS(SELECT 1 FROM zone_chance WHERE id='${id(15,source+3)}'),
      'zeroReach',(SELECT reach FROM zone_chance WHERE id='${id(15,source+2)}')) AS data;
    CREATE TEMP TABLE chance_versions AS SELECT id,ctid::text version FROM zone_chance WHERE group_id='${id(4,source)}';
    CREATE TEMP TABLE zone_versions AS SELECT id,ctid::text version FROM zone WHERE group_id='${id(4,source)}';
    ${replay}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM zone_chance c JOIN chance_versions v USING(id) WHERE c.ctid::text<>v.version)
      THEN RAISE EXCEPTION 'zone chance replay rewrote identical values'; END IF;
    END $$;
    UPDATE position_chance SET reach='undecided' WHERE team_id='${id(7,source+2)}' AND position=3;
    ${replay}
    DO $$ BEGIN IF (SELECT reach FROM zone_chance WHERE id='${id(15,source+2)}')<>'undecided'
      THEN RAISE EXCEPTION 'zero undecided zone reported the wrong reach'; END IF; END $$;
    UPDATE position_chance SET reach='impossible' WHERE team_id='${id(7,source+2)}' AND position=3;
    ${replay}
    DO $$ BEGIN IF (SELECT reach FROM zone_chance WHERE id='${id(15,source+2)}')<>'impossible'
      THEN RAISE EXCEPTION 'zero impossible zone reported the wrong reach'; END IF; END $$;
    SELECT json_build_object('colors',(SELECT json_agg(color ORDER BY id) FROM zone WHERE group_id='${id(4,source)}'),
      'cells',(SELECT data FROM restored_cells),
      'historyPreserved',(SELECT hash FROM source_history_before)=(SELECT md5(string_agg(to_jsonb(h)::text,'' ORDER BY id)) FROM team_odds_history h WHERE group_id='${id(4,source)}'),
      'positions',(SELECT positions_json::json FROM zone WHERE id='${id(5,source*10000)}'),
      'replayWrites',(SELECT count(*) FROM zone z JOIN zone_versions v USING(id) WHERE z.ctid::text<>v.version));
  `))!),{colors:["#a1b2c3","#8a2be2"],positions:[1,3],replayWrites:0,historyPreserved:true,cells:{percent:70,bounds:[1,3,0,4],reach:"",color:"#a1b2c3",incompleteRemoved:true,fragmentRemoved:true,zeroReach:"reachable"}});
});

Deno.test("legacy restoration skips a whole source zone when a fragment was edited", async()=>{
  const sql=await restoredZones([{name:"Wide zone",color:"#a1b2c3",position:[1,3]}]);
  assertEquals(JSON.parse((await query(`${parents}
    INSERT INTO phase(id,championship_id,name) VALUES('${id(3,source)}','${id(2,source)}','Zone phase');
    INSERT INTO stage_group(id,phase_id,name) VALUES('${id(4,source)}','${id(3,source)}','Zone group');
    INSERT INTO zone(id,group_id,name,color,first,last,position) VALUES
      ('${id(5,source*10000)}','${id(4,source)}','Wide zone','qualify',1,1,0),
      ('${id(5,source*10000+1)}','${id(4,source)}','Editorial fragment','#8a2be2',3,3,1);
    INSERT INTO standing(id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone)
      VALUES('${id(4,source)}:${id(7,source)}','${id(4,source)}','${id(7,source)}','Test',3,0,0,0,0,0,0,0,0,'','','','','','#8a2be2');
    CREATE TEMP TABLE editorial_versions AS SELECT id,ctid::text version FROM zone WHERE group_id='${id(4,source)}';
    ${sql}
    SELECT json_build_object('positions',(SELECT positions_json::json FROM zone WHERE id='${id(5,source*10000)}'),
      'baseColor',(SELECT color FROM zone WHERE id='${id(5,source*10000)}'),
      'fragmentPreserved',(SELECT name='Editorial fragment' AND color='#8a2be2' AND first=3 AND last=3 FROM zone WHERE id='${id(5,source*10000+1)}'),
      'effectiveColor',(SELECT zone FROM standing WHERE id='${id(4,source)}:${id(7,source)}'),
      'writes',(SELECT count(*) FROM zone z JOIN editorial_versions v USING(id) WHERE z.ctid::text<>v.version));
  `))!),{positions:[1],baseColor:"#55dd55",fragmentPreserved:true,effectiveColor:"#8a2be2",writes:0});
});
