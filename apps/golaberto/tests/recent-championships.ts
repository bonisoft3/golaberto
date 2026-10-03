// The real SQL projection under a fixed clock, with every fixture rolled back.
import { assertEquals } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
const clock = "'2026-10-02 12:00:00+00'::timestamptz";
const setup = `
  UPDATE championship SET begins='2000-01-01', ends='2000-12-31';
  DELETE FROM team_rating;
  CREATE TEMP TABLE fixture AS SELECT n, gen_random_uuid() AS id FROM generate_series(1,12) n;
  INSERT INTO championship (id,name,region,region_name,begins,ends)
    SELECT id, 'Recent fixture ' || lpad(n::text,2,'0'), 'national','Brasil','2026-01-01','2026-12-31' FROM fixture;
  INSERT INTO phase (id,championship_id,name) SELECT id,id,'Principal' FROM fixture;
  INSERT INTO stage_group (id,phase_id,name) SELECT id,id,'Grupo' FROM fixture;
  CREATE TEMP TABLE teams AS SELECT id,row_number() OVER (ORDER BY id)::int AS n FROM team ORDER BY id LIMIT 3;
`;
async function query(sql: string) {
  const out = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", `BEGIN; ${setup} ${sql} ROLLBACK;`],
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

Deno.test("recent tournaments use strict thirty-day bounds on the Brasília calendar with no six-row cap", async () => {
  assertEquals(await query(`
    UPDATE championship c SET begins=CASE f.n WHEN 1 THEN '2026-11-01' WHEN 2 THEN '2026-10-31' ELSE c.begins END,
      ends=CASE f.n WHEN 3 THEN '2026-09-02' WHEN 4 THEN '2026-09-03' ELSE c.ends END FROM fixture f WHERE c.id=f.id;
    SELECT json_agg(f.n ORDER BY f.n) FROM recent_championships(${clock}) r JOIN fixture f USING(id);
  `), [2,4,5,6,7,8,9,10,11,12]);
  assertEquals(await query(`
    UPDATE championship c SET begins='2026-10-31' FROM fixture f WHERE c.id=f.id;
    SELECT count(*) FROM recent_championships('2026-10-02 01:00:00+00');
  `), 0, "UTC October 2 is still Brasília October 1");
});

Deno.test("geometric mean counts distinct teams across groups and phases and includes missing ratings as zero", async () => {
  assertEquals(await query(`
    INSERT INTO team_group (group_id,team_id) SELECT f.id,t.id FROM fixture f CROSS JOIN teams t WHERE f.n=1;
    INSERT INTO phase (id,championship_id,name) SELECT gen_random_uuid(),id,'Final' FROM fixture WHERE n=1;
    INSERT INTO stage_group (id,phase_id,name) SELECT gen_random_uuid(),p.id,'Final' FROM phase p JOIN fixture f ON f.id=p.championship_id WHERE f.n=1 AND p.name='Final';
    INSERT INTO team_group (group_id,team_id) SELECT g.id,t.id FROM stage_group g JOIN phase p ON p.id=g.phase_id JOIN fixture f ON f.id=p.championship_id CROSS JOIN teams t WHERE f.n=1 AND p.name='Final' AND t.n=1;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),id,'2026-10-01',1,1,CASE n WHEN 1 THEN 100 ELSE 50 END FROM teams WHERE n<=2;
    SELECT json_build_array(abs(r.strength - (100.0 + 50.0*0.7)/(1+0.7+0.49)) < 1e-10,
      (SELECT strength FROM recent_championships(${clock}) r JOIN fixture f USING(id) WHERE f.n=2)=0)
      FROM recent_championships(${clock}) r JOIN fixture f USING(id) WHERE f.n=1;
  `), [true,true]);
});

Deno.test("latest known rating wins, future ratings are ignored, and strength sorts ahead of newer starts", async () => {
  assertEquals(await query(`
    INSERT INTO team_group (group_id,team_id) SELECT f.id,t.id FROM fixture f JOIN teams t ON t.n=f.n WHERE f.n<=2;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),t.id,d.day,1,1,d.rating FROM teams t CROSS JOIN
      (VALUES ('2026-09-01'::date,5),('2026-10-01'::date,80),('2026-10-03'::date,100)) d(day,rating) WHERE t.n=1;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),id,'2026-10-02',1,1,70 FROM teams WHERE n=2;
    UPDATE championship c SET begins='2026-10-02' FROM fixture f WHERE c.id=f.id AND f.n=2;
    SELECT json_agg(json_build_array(f.n,r.strength) ORDER BY r.strength DESC,r.full_name,r.id)
      FROM recent_championships(${clock}) r JOIN fixture f USING(id) WHERE f.n<=2;
  `), [[1,80],[2,70]]);
});

Deno.test("refresh removes expired rows, reranks rating and membership edits, and makes no unchanged writes", async () => {
  assertEquals(await query(`
    UPDATE championship c SET begins=(now() AT TIME ZONE 'America/Sao_Paulo')::date-10,
      ends=(now() AT TIME ZONE 'America/Sao_Paulo')::date+10 FROM fixture f WHERE c.id=f.id;
    INSERT INTO team_group (group_id,team_id) SELECT f.id,t.id FROM fixture f JOIN teams t ON t.n=f.n WHERE f.n<=2;
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating)
      SELECT gen_random_uuid(),id,(now() AT TIME ZONE 'America/Sao_Paulo')::date,1,1,CASE n WHEN 1 THEN 80 ELSE 70 END FROM teams;
    SELECT refresh_recent_championships();
    CREATE TEMP TABLE writes (id uuid);
    CREATE FUNCTION pg_temp.record_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO writes VALUES(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER recent_check AFTER INSERT OR UPDATE ON home_championship FOR EACH ROW EXECUTE FUNCTION pg_temp.record_write();
    SELECT refresh_recent_championships();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM writes) THEN RAISE EXCEPTION 'unchanged refresh wrote rows'; END IF; END $$;
    UPDATE team_rating SET rating=90 WHERE team_id=(SELECT id FROM teams WHERE n=2);
    DELETE FROM team_group WHERE group_id=(SELECT id FROM fixture WHERE n=1);
    UPDATE championship SET name='Renamed',region='continental' WHERE id=(SELECT id FROM fixture WHERE n=2);
    UPDATE championship SET begins=(now() AT TIME ZONE 'America/Sao_Paulo')::date-60, ends=(now() AT TIME ZONE 'America/Sao_Paulo')::date-30 WHERE id=(SELECT id FROM fixture WHERE n=3);
    SELECT refresh_recent_championships();
    SELECT json_build_array((SELECT count(*) FROM home_championship),
      (SELECT strength FROM home_championship WHERE id=(SELECT id FROM fixture WHERE n=1)),
      (SELECT strength FROM home_championship WHERE id=(SELECT id FROM fixture WHERE n=2)),
      (SELECT region='continental' AND full_name LIKE '%Renamed%' FROM home_championship WHERE id=(SELECT id FROM fixture WHERE n=2)));
  `), [11,0,90,true]);
});

Deno.test("the recent projection has public reads, service writes and Electric-only publication", async () => {
  assertEquals(await query(`
    SET LOCAL ROLE service;
    SELECT refresh_recent_championships();
    RESET ROLE;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE anon;
    DO $$ BEGIN
      UPDATE home_championship SET strength=999;
      IF FOUND THEN RAISE EXCEPTION 'anon can update projection'; END IF;
    END $$;
    RESET ROLE;
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM home_championship) THEN RAISE EXCEPTION 'public rows hidden'; END IF;
      UPDATE home_championship SET strength=999;
      IF FOUND THEN RAISE EXCEPTION 'app user can update projection'; END IF;
    END $$;
    RESET ROLE;
    SELECT json_build_array(
      has_function_privilege('service','refresh_recent_championships()','EXECUTE'),
      has_function_privilege('anon','refresh_recent_championships()','EXECUTE'),
      has_function_privilege('app_user','recent_championships(timestamptz)','EXECUTE'),
      EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default' AND tablename='home_championship'),
      EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND tablename='home_championship'));
  `), [true,false,false,true,false]);
});
