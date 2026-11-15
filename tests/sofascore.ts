import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { query } from "./db.ts";
import postgres from "npm:postgres@3.4.9";

const id = () => crypto.randomUUID();
// A resource's scheduling instance, made due at the transaction's instant and
// woken, as the ticker's wake would once that instant passed.
const ripe = (resource: string, family: string) => `
  DO $$ BEGIN
    PERFORM hybrid_sofa_resource.spawn('${resource}',jsonb_build_object('family','${family}','due',sofa.ms(now()),'owed','[]'::jsonb),
      jsonb_build_object('service',sofa.service_actor()));
    PERFORM sofa.tell('${resource}','ripe','{}');
  END $$;`;
const state = (resource: string, field: string) => `(sofa.resource_state('${resource}')->>'${field}')`;
// How far past the transaction's instant a resource is next due, in milliseconds.
const dueIn = (resource: string) => `(${state(resource, "due")}::bigint-sofa.ms(now()))`;
const open = `DO $$ BEGIN PERFORM sofa.resume(); END $$;`;

function fixture() {
  const [champ, phase, home, away, game, player, source, resource, request, later] = Array.from({ length: 10 }, id);
  const tournament = parseInt(champ.replaceAll("-", "").slice(0, 12), 16) + 1;
  const event = String(tournament);
  return { champ, phase, home, away, game, player, source, resource, request, later, tournament, event,
    setup: `
      INSERT INTO team(id,name,country) VALUES ('${home}','Sofa home','Brasil'),('${away}','Sofa away','Brasil');
      INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Sofa season','Brasil','2026-01-01','2026-12-31');
      INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Sofa phase');
      INSERT INTO game(id,phase_id,day,home_id,away_id,played) VALUES ('${game}','${phase}','2026-10-27','${home}','${away}',false);
      INSERT INTO player(id,name) VALUES ('${player}','Sofa player');
      INSERT INTO sofa.source(id,championship_id,unique_tournament_id,season_id,enabled) VALUES ('${source}','${champ}',${tournament},1,true);
      INSERT INTO sofa.binding(entity_kind,external_id,local_id) VALUES ('game','${event}','${game}');
      INSERT INTO sofa.resource(id,source_id,family,resource_key,path) VALUES ('${resource}','${source}','round','round/1','round/1');${ripe(resource, "round")}`,
  };
}

Deno.test("Sofa source scope is constrained and summaries precede queued details", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN;
    DO $$ BEGIN PERFORM 1 FROM sofa.control WHERE id FOR UPDATE; END $$;
    UPDATE sofa.source SET enabled=false;
    UPDATE sofa.control SET used=0,budget_minute=date_trunc('minute',clock_timestamp());
    ${open}
    ${f.setup}
    INSERT INTO sofa.resource(id,source_id,family,resource_key,path,priority) VALUES ('${f.later}','${f.source}','lineups','detail','event/1/lineups',5);
    ${ripe(f.later, "lineups")}
    DO $$ BEGIN
      IF (SELECT event_scope FROM sofa.source WHERE id='${f.source}')<>'competition' THEN RAISE EXCEPTION 'unexpected default event scope'; END IF;
      UPDATE sofa.source SET event_scope='stages' WHERE id='${f.source}';
      UPDATE sofa.source SET event_scope='fixtures' WHERE id='${f.source}';
      BEGIN
        UPDATE sofa.source SET event_scope='anything' WHERE id='${f.source}';
        RAISE EXCEPTION 'invalid scope accepted';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      IF (SELECT event_scope FROM sofa.status WHERE id='${f.source}')<>'fixtures' THEN RAISE EXCEPTION 'status hides configured scope'; END IF;
      UPDATE sofa.resource SET priority=0 WHERE id='${f.resource}';
      UPDATE sofa.control SET minute_limit=1;
      PERFORM sofa.admit();
      IF (SELECT string_agg(family,',') FROM sofa_request WHERE source_id='${f.source}') IS DISTINCT FROM 'round' THEN
        RAISE EXCEPTION 'detail backlog delayed result summary'; END IF;
    END $$;
    SELECT true; ROLLBACK;`), "t");
});

Deno.test("Sofa tick waits for admission's budget lock before touching sources", async () => {
  const connect = () => postgres(Deno.env.get("DATABASE_URL")!, { max: 1, fetch_types: false });
  const holder = connect(), ticker = connect();
  let holding = false;
  let pending: Promise<unknown> | undefined;
  try {
    const [{ pid }] = await ticker`SELECT pg_backend_pid() AS pid`;
    const [{ pid: holderPid }] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`BEGIN`;
    holding = true;
    await holder`SELECT 1 FROM sofa.control WHERE id FOR UPDATE`;
    await ticker`BEGIN`;
    pending = ticker`SELECT sofa.tick()`.execute();
    const settled = Promise.allSettled([pending]);
    const deadline = Date.now() + 10_000;
    while (await query(`SELECT ${holderPid}=ANY(pg_blocking_pids(${pid}))`) !== "t") {
      if (Date.now() >= deadline) throw new Error("Sofa tick did not wait for the budget lock");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assertEquals(await query(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=${pid} AND n.nspname='sofa' AND c.relname='source'
      AND l.mode='RowExclusiveLock'`), "0");
    await holder`COMMIT`;
    holding = false;
    const [result] = await settled;
    if (result.status === "rejected") throw result.reason;
    await ticker`ROLLBACK`;
  } finally {
    if (holding) await holder`ROLLBACK`;
    if (pending) await Promise.allSettled([pending]);
    await Promise.all([holder.end(), ticker.end()]);
  }
});

Deno.test("Sofa tick skips a settling stale request and reviews it on the next tick", async () => {
  const database = `sofa_lock_${id().replaceAll("-", "")}`;
  const url = new URL(Deno.env.get("DATABASE_URL")!);
  const admin = postgres(url.toString(), { max: 1, fetch_types: false });
  let holder: ReturnType<typeof postgres> | undefined;
  let ticker: ReturnType<typeof postgres> | undefined;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  try {
    url.pathname = `/${database}`;
    holder = postgres(url.toString(), { max: 1, fetch_types: false });
    ticker = postgres(url.toString(), { max: 1, fetch_types: false });
    await ticker.unsafe(`
      CREATE SCHEMA sofa;
      CREATE TABLE sofa.control(id boolean PRIMARY KEY);
      INSERT INTO sofa.control VALUES(true);
      CREATE TABLE sofa.source(id uuid,championship_id uuid,enabled boolean);
      CREATE TABLE public.championship(id uuid,ends date);
      CREATE TABLE public.sofa_tick(tick_at timestamptz);
      CREATE TABLE public.sofa_request(id uuid PRIMARY KEY,status text,stuck_at timestamptz,admitted_at timestamptz,source_id uuid,resource_key text);
      CREATE TABLE sofa.event(source_id uuid,snapshot jsonb);
      CREATE TABLE public.phase(id uuid,championship_id uuid);
      CREATE TABLE public.game(phase_id uuid,played boolean,sync_status text);
      CREATE TABLE sofa.reviews(id uuid);
      CREATE FUNCTION sofa.review_item(uuid,text,text,text,jsonb) RETURNS void LANGUAGE sql AS $$ INSERT INTO sofa.reviews VALUES (($5->>'request')::uuid) $$;
      CREATE FUNCTION sofa.seed_fixtures(timestamptz) RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION sofa.admit() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM sofa.control WHERE id FOR UPDATE; RETURN 0; END $$;
      INSERT INTO public.sofa_request VALUES ('00000000-0000-0000-0000-000000000001','acquiring',NULL,now()-interval '1 hour',NULL,'test');
    `);
    await ticker.unsafe(await Deno.readTextFile(new URL("../services/database/sql/060_sofascore_lock_order.sql", import.meta.url)));
    await holder`BEGIN`;
    await holder`SELECT id FROM sofa_request FOR UPDATE`;
    await ticker`SET statement_timeout='2s'`;
    await ticker`SELECT sofa.tick()`;
    assertEquals((await ticker`SELECT stuck_at IS NULL AS pending FROM sofa_request`)[0].pending, true);
    assertEquals((await ticker`SELECT count(*)::integer AS n FROM sofa.reviews`)[0].n, 0);
    await holder`SELECT 1 FROM sofa.control WHERE id FOR UPDATE`;
    await holder`ROLLBACK`;
    await ticker`SELECT sofa.tick()`;
    assertEquals((await ticker`SELECT stuck_at IS NOT NULL AS flagged FROM sofa_request`)[0].flagged, true);
    assertEquals((await ticker`SELECT count(*)::integer AS n FROM sofa.reviews`)[0].n, 1);
    await ticker`SELECT sofa.tick()`;
    assertEquals((await ticker`SELECT count(*)::integer AS n FROM sofa.reviews`)[0].n, 1);
  } finally {
    if (holder) await holder.end();
    if (ticker) await ticker.end();
    await admin.unsafe(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});

Deno.test("Sofa patches preserve editor changes and avoid repeated domain writes", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN; ${f.setup}
    INSERT INTO sofa.baseline(table_name,local_id,source_id,fields)
      SELECT 'game',id,'${f.source}',to_jsonb(g) FROM game g WHERE id='${f.game}';
    DO $$ DECLARE p jsonb; r jsonb; before_row tid;
    BEGIN
      p:=jsonb_build_object('event',jsonb_build_object('external_id','${f.event}'), 'bindings','[]'::jsonb,'reviews','[]'::jsonb,'collections','[]'::jsonb,
        'rows',jsonb_build_array(jsonb_build_object('table','game','id','${f.game}','fields',jsonb_build_object('phase_id','${f.phase}','home_score',1,'away_score',0,'played',true))));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'rows_changed')::int<>1 THEN RAISE EXCEPTION 'first result not applied %',r; END IF;
      SELECT ctid INTO before_row FROM game WHERE id='${f.game}';
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'rows_changed')::int<>0 OR (SELECT ctid FROM game WHERE id='${f.game}')<>before_row THEN RAISE EXCEPTION 'unchanged result rewrote game'; END IF;
      UPDATE game SET home_score=2 WHERE id='${f.game}';
      p:=jsonb_set(p,'{rows,0,fields,home_score}','3');
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int=0 OR (SELECT home_score FROM game WHERE id='${f.game}')<>2 THEN RAISE EXCEPTION 'manual score lost'; END IF;
      DELETE FROM sofa.baseline WHERE table_name='game' AND local_id='${f.game}';
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int=0 OR (SELECT home_score FROM game WHERE id='${f.game}')<>2 THEN RAISE EXCEPTION 'unowned final overwritten'; END IF;
    END $$;
    SELECT true; ROLLBACK;`), "t");
});

Deno.test("Sofa details reuse natural appearances and protect manual collections", async () => {
  const f = fixture();
  const [appearance, proposed, goal, manual] = Array.from({ length: 4 }, id);
  assertEquals(await query(`BEGIN; ${f.setup}
    INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute) VALUES ('${appearance}','${f.game}','${f.player}','home',0,90);
    INSERT INTO goal(id,game_id,player_id,side,minute) VALUES ('${manual}','${f.game}','${f.player}','home',10);
    DO $$ DECLARE p jsonb; r jsonb;
    BEGIN
      p:=jsonb_build_object('event',jsonb_build_object('external_id','${f.event}'),'bindings','[]'::jsonb,'reviews','[]'::jsonb,
        'rows',jsonb_build_array(jsonb_build_object('table','player_game','id','${proposed}','fields',jsonb_build_object('game_id','${f.game}','player_id','${f.player}','side','home','on_minute',0,'off_minute',90))),
        'collections',jsonb_build_array(jsonb_build_object('table','player_game','game_id','${f.game}','ids',jsonb_build_array('${proposed}'))));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int<>0 OR NOT EXISTS(SELECT 1 FROM player_game WHERE id='${appearance}') OR EXISTS(SELECT 1 FROM player_game WHERE id='${proposed}') THEN RAISE EXCEPTION 'appearance natural key not reused %',r; END IF;
      p:=jsonb_build_object('event',jsonb_build_object('external_id','${f.event}'),'bindings','[]'::jsonb,'reviews','[]'::jsonb,
        'rows',jsonb_build_array(jsonb_build_object('table','goal','id','${goal}','fields',jsonb_build_object('game_id','${f.game}','player_id','${f.player}','side','home','minute',45,'added_time',2,'period','first','source_order',1))),
        'collections',jsonb_build_array(jsonb_build_object('table','goal','game_id','${f.game}','ids',jsonb_build_array('${goal}'))));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int=0 OR NOT EXISTS(SELECT 1 FROM goal WHERE id='${manual}') OR EXISTS(SELECT 1 FROM goal WHERE id='${goal}') THEN RAISE EXCEPTION 'manual goal not quarantined'; END IF;
      DELETE FROM goal WHERE id='${manual}';
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int<>0 OR NOT EXISTS(SELECT 1 FROM goal WHERE id='${goal}' AND minute=45 AND added_time=2 AND period='first' AND source_order=1) THEN RAISE EXCEPTION 'goal clock lost %',r; END IF;
    END $$;
    SELECT true; ROLLBACK;`), "t");
});

Deno.test("Sofa source stage keys are season scoped and refresh is service only", async () => {
  const f = fixture();
  const [otherChamp, otherPhase, otherSource] = Array.from({ length: 3 }, id);
  assertEquals(await query(`BEGIN; ${f.setup}
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${otherChamp}','Other Sofa season','Brasil','2027-01-01','2027-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${otherPhase}','${otherChamp}','Other Sofa phase');
    INSERT INTO sofa.source(id,championship_id,unique_tournament_id,season_id) VALUES ('${otherSource}','${otherChamp}',${f.tournament},2);
    INSERT INTO sofa.stage_binding(source_id,stage_key,phase_id) VALUES
      ('${f.source}','10','${f.phase}'),('${f.source}','11','${f.phase}'),('${otherSource}','10','${otherPhase}');
    SELECT (SELECT count(*) FROM sofa.stage_binding WHERE source_id='${f.source}' AND phase_id='${f.phase}')=2
       AND (SELECT phase_id FROM sofa.stage_binding WHERE source_id='${otherSource}' AND stage_key='10')='${otherPhase}'::uuid
       AND has_function_privilege('service','public.refresh_sofascore_queue()','EXECUTE')
       AND NOT has_function_privilege('app_user','public.refresh_sofascore_queue()','EXECUTE');
    ROLLBACK;`), "t");
});

Deno.test("Sofa schedule is authoritative while result and reviews remain guarded", async () => {
  const f = fixture();
  const otherPhase = id();
  assertEquals(await query(`BEGIN; ${f.setup}
    INSERT INTO phase(id,championship_id,name) VALUES ('${otherPhase}','${f.champ}','Other phase');
    UPDATE game SET kickoff='2026-10-27 13:00:00+00',round=1 WHERE id='${f.game}';
    DO $$ DECLARE p jsonb; r jsonb; before_row tid;
    BEGIN
      PERFORM sofa.review_item('${f.source}','game','${f.game}','manual fixture fields conflict with provider','{"fields":["day","kickoff"]}');
      PERFORM sofa.review_item('${f.source}','game','${f.game}','manual fixture fields conflict with provider','{"fields":["kickoff","round"]}');
      PERFORM sofa.review_item('${f.source}','game','${f.game}','manual fixture fields conflict with provider','{"fields":["sync_status"]}');
      p:=jsonb_build_object('event',jsonb_build_object('external_id','${f.event}'),'bindings','[]'::jsonb,'reviews','[]'::jsonb,'collections','[]'::jsonb,
        'rows',jsonb_build_array(jsonb_build_object('table','game','id','${f.game}','fields',jsonb_build_object(
          'phase_id','${otherPhase}','home_id','${f.home}','away_id','${f.away}','day','2026-10-28',
          'kickoff','2026-10-28T17:00:00Z','played',true,'home_score',1,'away_score',0,
          'home_aet',NULL,'away_aet',NULL,'home_pen',NULL,'away_pen',NULL))));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'applied')::boolean IS DISTINCT FROM false OR EXISTS(SELECT 1 FROM sofa.review WHERE source_id='${f.source}' AND evidence->'fields'='["day","kickoff"]'::jsonb AND resolved) THEN
        RAISE EXCEPTION 'blocked patch resolved schedule review %',r;
      END IF;
      p:=jsonb_set(p,'{rows,0,fields,phase_id}',to_jsonb('${f.phase}'::text));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'applied')::boolean IS NOT TRUE OR (r->>'result_ready')::boolean IS NOT TRUE OR (r->>'conflicts')::int<>0 OR
         NOT EXISTS(SELECT 1 FROM game WHERE id='${f.game}' AND day='2026-10-28' AND kickoff='2026-10-28 17:00:00+00' AND played AND home_score=1 AND away_score=0) OR
         NOT EXISTS(SELECT 1 FROM sofa.review WHERE source_id='${f.source}' AND evidence->'fields'='["day","kickoff"]'::jsonb AND resolved) OR
         (SELECT count(*) FROM sofa.review WHERE source_id='${f.source}' AND evidence->'fields' IN ('["kickoff","round"]'::jsonb,'["sync_status"]'::jsonb) AND NOT resolved)<>2 THEN
        RAISE EXCEPTION 'schedule not applied or unrelated review resolved %',r;
      END IF;
      SELECT ctid INTO before_row FROM game WHERE id='${f.game}';
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'rows_changed')::int<>0 OR (SELECT ctid FROM game WHERE id='${f.game}')<>before_row THEN RAISE EXCEPTION 'schedule replay rewrote game'; END IF;
      UPDATE game SET day='2026-10-29',kickoff='2026-10-29 12:00:00+00',home_score=2 WHERE id='${f.game}';
      p:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(p,'{rows,0,fields,day}','"2026-10-30"'),'{rows,0,fields,kickoff}','null'),'{rows,0,fields,home_score}','3'),'{rows,0,fields,away_score}','1');
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'applied')::boolean IS NOT TRUE OR (r->>'conflicts')::int=0 OR (r->>'result_ready')::boolean IS DISTINCT FROM false OR
         NOT EXISTS(SELECT 1 FROM game WHERE id='${f.game}' AND day='2026-10-30' AND kickoff IS NULL AND home_score=2 AND away_score=0) THEN
        RAISE EXCEPTION 'schedule or result protection failed %',r;
      END IF;
      SELECT ctid INTO before_row FROM game WHERE id='${f.game}';
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'rows_changed')::int<>0 OR (SELECT ctid FROM game WHERE id='${f.game}')<>before_row THEN RAISE EXCEPTION 'conflicted replay rewrote game'; END IF;
    END $$;
    SELECT true; ROLLBACK;`), "t");
});

Deno.test("Sofa fills missing kickoff and status for unplayed fixtures", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN; ${f.setup}
    DO $$ DECLARE p jsonb; r jsonb;
    BEGIN
      p:=jsonb_build_object('event',jsonb_build_object('external_id','${f.event}'),'bindings','[]'::jsonb,'reviews','[]'::jsonb,'collections','[]'::jsonb,
        'rows',jsonb_build_array(jsonb_build_object('table','game','id','${f.game}','fields',jsonb_build_object(
          'phase_id','${f.phase}','home_id','${f.home}','away_id','${f.away}','day','2026-10-27',
          'kickoff','2026-10-27T17:00:00Z','sync_status','postponed'))));
      r:=sofa.apply_source_patch('${f.source}',p,'{}');
      IF (r->>'conflicts')::int<>0 OR (r->>'result_ready')::boolean IS DISTINCT FROM false OR
         NOT EXISTS(SELECT 1 FROM game WHERE id='${f.game}' AND kickoff='2026-10-27 17:00:00+00' AND sync_status='postponed') THEN
        RAISE EXCEPTION 'missing fixture fields not filled %',r;
      END IF;
    END $$;
    SELECT true; ROLLBACK;`), "t");
});

Deno.test("editor game updates remove unavailable fixtures from projections", async () => {
  const f = fixture();
  const actor = id();
  assertEquals(await query(`BEGIN; ${f.setup}
    UPDATE game SET sync_status='cancelled',played=true,home_score=0,away_score=0 WHERE id='${f.game}';
    INSERT INTO app_user(id,handle) VALUES ('${actor}','sofa-editor-${actor}');
    INSERT INTO editor(app_user_id) VALUES ('${actor}');
    INSERT INTO team_game(id,team_id,game_id,side,opponent_id,opponent_name,championship_id,championship_name,day,played,result,phase_key,category_key)
      VALUES ('${f.home}:${f.game}','${f.home}','${f.game}','home','${f.away}','Sofa away','${f.champ}','Sofa season','2026-10-27',true,'d','','');
    INSERT INTO matches_game_card(id,phase_id,championship_id,day,played,home_id,away_id,home_name,away_name,championship_name,phase_name)
      VALUES ('${f.game}','${f.phase}','${f.champ}','2026-10-27',true,'${f.home}','${f.away}','Sofa home','Sofa away','Sofa season','Sofa phase');
    SET LOCAL app.scopes='public:,user:${actor}';
    SET LOCAL request.jwt.claims='{"sub":"${actor}","guest":false}';
    SET LOCAL ROLE app_user;
    UPDATE game SET played=false,home_score=NULL,away_score=NULL WHERE id='${f.game}';
    RESET ROLE;
    SELECT EXISTS(SELECT 1 FROM team_game WHERE game_id='${f.game}' AND NOT fixture_available)
      AND NOT EXISTS(SELECT 1 FROM matches_game_card WHERE id='${f.game}')
      AND EXISTS(SELECT 1 FROM game WHERE id='${f.game}' AND sync_status='cancelled' AND NOT played AND home_score IS NULL AND away_score IS NULL);
    ROLLBACK;`), "t");
});

// The cases tools/sofascore/normalize_fixtures.py recorded from normalize.py.
const normalizeCases: { name: string; input: { kind: string }; expect?: { day: string }[]; raises?: string }[] =
  JSON.parse(await Deno.readTextFile(new URL("./sofascore-normalize.json", import.meta.url)));
const jsonb = (value: unknown) => `$j$${JSON.stringify(value)}$j$::jsonb`;

Deno.test("Sofa events parse in the database and their day is normalize.py's", async () => {
  // A day computed in Jessie would need the zone rules; SQL has them, and an
  // unconfirmed start keeps Python's UTC date rather than Sao Paulo's.
  for (const c of normalizeCases.filter((c) => c.input.kind === "events" && c.expect?.length)) {
    const days = await query(`SELECT string_agg(sofa.event_day(e)::text, ',' ORDER BY n)
      FROM jsonb_array_elements(public.fn_sofascore_normalize(${jsonb(c.input)})) WITH ORDINALITY AS t(e, n);`);
    assertEquals(days, c.expect!.map((e) => e.day).join(","), c.name);
  }
});

Deno.test("Sofa normalization commits with the rows beside it and rolls them back when it fails", async () => {
  const good = normalizeCases.find((c) => c.name === "extra time and penalties")!;
  const bad = normalizeCases.find((c) => c.name === "events not a list")!;
  assertEquals(await query(`BEGIN;
    CREATE TEMP TABLE sofa_observation_probe (events jsonb) ON COMMIT DROP;
    INSERT INTO sofa_observation_probe SELECT public.fn_sofascore_normalize(${jsonb(good.input)});
    SELECT events->0->>'external_id' || '|' || (events->0->>'played') FROM sofa_observation_probe;
    ROLLBACK;`), "1|true");
  const probe = `sofa_normalize_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  await assertRejects(() => query(`BEGIN;
      CREATE TABLE ${probe} (v jsonb);
      INSERT INTO ${probe} VALUES ('{}');
      SELECT public.fn_sofascore_normalize(${jsonb(bad.input)});
      COMMIT;`), Error, "events must be a list");
  assertEquals(await query(`SELECT to_regclass('${probe}') IS NULL;`), "t");
});

// A round response as the transport answers it: the provider's body as text.
function roundAnswer(f: ReturnType<typeof fixture>, home: number, away: number) {
  const body = { events: [{ id: Number(f.event), homeTeam: { id: 10, name: "Sofa home" }, awayTeam: { id: 20, name: "Sofa away" },
    tournament: { id: 30, uniqueTournament: { id: f.tournament } }, season: { id: 1 }, roundInfo: { round: 1 },
    startTimestamp: 1793120400, status: { type: "finished" },
    homeScore: { normaltime: home, current: home }, awayScore: { normaltime: away, current: away } }] };
  return jsonb({ kind: "done", data: { status: 200, headers: {}, body: JSON.stringify(body), error: null } });
}
const received = (f: ReturnType<typeof fixture>) => `
  INSERT INTO sofa.binding(entity_kind,external_id,local_id) VALUES ('team','10','${f.home}'),('team','20','${f.away}')
    ON CONFLICT DO NOTHING;
  INSERT INTO sofa.stage_binding(source_id,stage_key,phase_id) VALUES ('${f.source}','30','${f.phase}');`;

Deno.test("Sofa receive stores the answer, parses it in the database and applies its result", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN;
    DELETE FROM sofa.binding WHERE entity_kind='team' AND external_id IN ('10','20');
    ${f.setup}${received(f)}
    DO $$ BEGIN PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${roundAnswer(f, 2, 1)}); END $$;
    SELECT (SELECT played::text || '|' || home_score || '-' || away_score || '|' || day FROM game WHERE id='${f.game}')
      || '|' || (SELECT normalized->0->>'external_id' = '${f.event}' FROM sofa.observation WHERE request_id='${f.request}')
      || '|' || (SELECT snapshot->>'status' FROM sofa.event WHERE source_id='${f.source}' AND external_id='${f.event}');
    ROLLBACK;`), "true|2-1|2026-10-27|true|finished");
});

// Each answer carries the sequence its request was admitted at; an older
// answer arriving later, as a redriven dead letter would, is kept and never
// applied over the newer one.
Deno.test("Sofa receive keeps a late answer and never applies it", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN;
    DELETE FROM sofa.binding WHERE entity_kind='team' AND external_id IN ('10','20');
    ${f.setup}${received(f)}
    DO $$ BEGIN
      PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',2,${roundAnswer(f, 2, 1)});
      PERFORM sofa.receive('${f.later}','${f.source}','round','round/1',1,${roundAnswer(f, 0, 0)});
    END $$;
    SELECT (SELECT home_score || '-' || away_score FROM game WHERE id='${f.game}')
      || '|' || (SELECT count(*) FROM sofa.observation WHERE source_id='${f.source}')
      || '|' || (SELECT seq FROM sofa.current WHERE source_id='${f.source}' AND resource_key='round/1')
      || '|' || (SELECT normalized IS NULL FROM sofa.observation WHERE request_id='${f.later}');
    ROLLBACK;`), "2-1|2|2|true");
});

// A fixture new to the source gets a database id and a binding in the commit
// that creates it, so the next delivery of the same event finds that game
// instead of creating another.
Deno.test("Sofa receive creates a new fixture once and binds every later delivery to it", async () => {
  const f = fixture();
  assertEquals(await query(`BEGIN;
    DELETE FROM sofa.binding WHERE entity_kind='team' AND external_id IN ('10','20');
    ${f.setup}${received(f)}
    DELETE FROM sofa.binding WHERE entity_kind='game' AND external_id='${f.event}';
    DELETE FROM game WHERE id='${f.game}';
    DO $$ BEGIN
      PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${roundAnswer(f, 0, 0)});
      PERFORM sofa.receive('${f.later}','${f.source}','round','round/1',2,${roundAnswer(f, 2, 1)});
    END $$;
    SELECT (SELECT count(*) FROM game WHERE phase_id='${f.phase}')
      || '|' || (SELECT g.home_score || '-' || g.away_score FROM game g JOIN sofa.binding b ON b.local_id=g.id
                  WHERE b.entity_kind='game' AND b.external_id='${f.event}')
      || '|' || (SELECT count(*) FROM sofa.binding WHERE entity_kind='game' AND external_id='${f.event}');
    ROLLBACK;`), "1|2-1|1");
});

Deno.test("Sofa receive fails its commit on a payload it cannot parse, storing nothing", async () => {
  const f = fixture();
  const answer = jsonb({ kind: "done", data: { status: 200, headers: {}, body: "{not json", error: null } });
  assertEquals(await query(`BEGIN;
    ${f.setup}
    DO $$ BEGIN
      PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${answer});
      RAISE EXCEPTION 'unparseable answer accepted';
    EXCEPTION WHEN invalid_text_representation THEN NULL;
    END $$;
    SELECT count(*) FROM sofa.observation WHERE source_id='${f.source}';
    ROLLBACK;`), "0");
});

// Admission is where the source's budget is spent: one unit per request at
// the source's next sequence, never past the minute's limit, and never twice
// for a resource whose request is still acquiring.
Deno.test("Sofa admission spends the minute's budget and numbers requests by source", async () => {
  const f = fixture();
  const [second, third] = [id(), id()];
  assertEquals(await query(`BEGIN;
    DO $$ BEGIN PERFORM 1 FROM sofa.control WHERE id FOR UPDATE; END $$;
    ${f.setup}
    UPDATE sofa.source SET enabled=false WHERE id<>'${f.source}';
    UPDATE sofa.control SET minute_limit=2,used=0,budget_minute=date_trunc('minute',clock_timestamp());
    ${open}
    INSERT INTO sofa.resource(id,source_id,family,resource_key,path,priority) VALUES
      ('${second}','${f.source}','round','round/2','round/2',20),
      ('${third}','${f.source}','round','round/3','round/3',30);
    ${ripe(second, "round")}${ripe(third, "round")}
    SELECT sofa.admit();
    SELECT sofa.admit();
    SELECT (SELECT string_agg(resource_key || '@' || seq, ',' ORDER BY seq) FROM sofa_request WHERE source_id='${f.source}')
      || '|' || (SELECT used FROM sofa.control)
      || '|' || (SELECT count(*) FROM sofa.resource r WHERE source_id='${f.source}' AND sofa.resource_state(r.id)->>'phase'='acquiring');
    ROLLBACK;`), "2\n0\nround/1@1,round/2@2|2|2");
  assertEquals(await query(`BEGIN;
    DO $$ BEGIN PERFORM 1 FROM sofa.control WHERE id FOR UPDATE; END $$;
    ${f.setup}
    UPDATE sofa.source SET enabled=false WHERE id<>'${f.source}';
    UPDATE sofa.control SET minute_limit=6,used=0,budget_minute=date_trunc('minute',clock_timestamp());
    ${open}
    SELECT sofa.admit();
    SELECT sofa.admit();
    SELECT count(*) FROM sofa_request WHERE resource_id='${f.resource}';
    ROLLBACK;`), "1\n0\n1");
});

// Every redirect the transport followed was a request SofaScore served, so
// an answer pays for the requests beyond the one admission spent.
Deno.test("Sofa answers pay for the redirects they followed, failures included", async () => {
  const f = fixture();
  const failed = jsonb({ kind: "failed", data: { status: 503, headers: {}, body: "", error: null, requests: 2 } });
  const answer = (requests: number) => roundAnswer(f, 2, 1).replace(`"error":null`, `"error":null,"requests":${requests}`);
  assertEquals(await query(`BEGIN;
    DELETE FROM sofa.binding WHERE entity_kind='team' AND external_id IN ('10','20');
    ${f.setup}${received(f)}
    UPDATE sofa.control SET used=1,budget_minute=date_trunc('minute',clock_timestamp());
    DO $$ BEGIN PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${answer(3)}); END $$;
    SELECT (SELECT used FROM sofa.control)::text;
    DO $$ BEGIN PERFORM sofa.fail('${f.resource}',${failed}); END $$;
    SELECT (SELECT used FROM sofa.control) || '|' || (SELECT ${state(f.resource, "failures")} || ':' || last_error FROM sofa.resource WHERE id='${f.resource}');
    ROLLBACK;`), "3\n4|1:status 503");
});

// The cadence itself is the resource reducer's (tests/sofascore-schedule.ts).
Deno.test("Sofa round paths name the round, its slug or prefix and its page", async () => {
  assertEquals(await query(`SELECT sofa.round_path(384,87760,'{"round":28,"name":"Semifinals","slug":"semifinals"}') || '|' ||
    sofa.round_path(384,87760,'{"round":28,"slug":"semifinals"}',1) || '|' || sofa.round_path(1,2,'{"round":3,"prefix":"Fase única"}');`),
    "unique-tournament/384/season/87760/events/round/28/slug/semifinals|" +
      "unique-tournament/384/season/87760/events/round/28/slug/semifinals?page=1|" +
      "unique-tournament/1/season/2/events/round/3/prefix/Fase%20%C3%BAnica");
});

const inventory = (body: unknown) => jsonb({ kind: "done", data: { status: 200, headers: {}, body: JSON.stringify(body), error: null } });

Deno.test("Sofa inventory owes the current, pending and later rounds and checks itself daily", async () => {
  const f = fixture();
  const rounds = inventory({ rounds: [{ round: 1 }, { round: 2 }, { round: 3 }], currentRound: { round: 2 } });
  assertEquals(await query(`BEGIN; ${f.setup}${received(f)}
    UPDATE game SET round=1 WHERE id='${f.game}';
    INSERT INTO sofa.resource(id,source_id,family,resource_key,path) VALUES ('${f.later}','${f.source}','rounds','rounds','rounds');
    ${ripe(f.later, "rounds")}
    DO $$ BEGIN PERFORM sofa.receive('${f.request}','${f.source}','rounds','rounds',1,${rounds}); END $$;
    SELECT (SELECT string_agg(split_part(resource_key,'/',7),',' ORDER BY resource_key) FROM sofa.resource WHERE source_id='${f.source}' AND family='round' AND resource_key<>'round/1')
      || '|' || (${dueIn(f.later)} BETWEEN 23*3600000 AND 25*3600000);
    ROLLBACK;`), "1,2,3|true");
});

Deno.test("Sofa owes a detailable final its lineups and incidents and applies them as a pair", async () => {
  const f = fixture();
  const c = normalizeCases.find((c) => c.name === "complete final")! as unknown as {
    input: { lineups: unknown; incidents: unknown; event: Record<string, unknown> } };
  const detail = (body: unknown) => jsonb({ kind: "done", data: { status: 200, headers: {}, body: JSON.stringify(body), error: null } });
  const event = { ...c.input.event, external_id: f.event };
  assertEquals(await query(`BEGIN; ${f.setup}${received(f)}
    UPDATE sofa.source SET detail_after='2026-01-01',create_players=true WHERE id='${f.source}';
    DO $$ BEGIN PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${roundAnswer(f, 2, 1)}); END $$;
    SELECT string_agg(family || '@' || ((sofa.resource_state(id)->>'due')::bigint<=sofa.ms(now())),',' ORDER BY family) FROM sofa.resource
      WHERE source_id='${f.source}' AND family IN ('lineups','incidents');
    UPDATE sofa.event SET snapshot=${jsonb(event)} WHERE source_id='${f.source}' AND external_id='${f.event}';
    UPDATE game SET played=true,home_score=1,away_score=1,home_aet=1,away_aet=0,home_pen=4,away_pen=3 WHERE id='${f.game}';
    DO $$ BEGIN PERFORM sofa.receive(gen_random_uuid(),'${f.source}','lineups','event/${f.event}/lineups',2,${detail(c.input.lineups)}); END $$;
    SELECT (SELECT count(*) FROM player_game WHERE game_id='${f.game}') || '|' ||
      (SELECT (sofa.resource_state(id)->>'checks') || ':' || ((sofa.resource_state(id)->>'due')::bigint-sofa.ms(now()) BETWEEN 19*60000 AND 21*60000)
       FROM sofa.resource WHERE source_id='${f.source}' AND family='lineups');
    DO $$ BEGIN PERFORM sofa.receive(gen_random_uuid(),'${f.source}','incidents','event/${f.event}/incidents',3,${detail(c.input.incidents)}); END $$;
    SELECT (SELECT count(*)>0 FROM player_game WHERE game_id='${f.game}') || '|' ||
      (SELECT count(*) FROM goal WHERE game_id='${f.game}') || '|' ||
      (SELECT string_agg(family || ':' || (sofa.resource_state(id)->>'complete'),',' ORDER BY family) FROM sofa.resource WHERE source_id='${f.source}' AND family IN ('lineups','incidents'));
    ROLLBACK;`), "incidents@true,lineups@true\n0|1:true\ntrue|3|incidents:true,lineups:true");
});

Deno.test("Sofa details keep a bound player's id and bind each player they create to its derived id", async () => {
  // A derived id names a provider player only while nothing binds it: a
  // player an editor already bound keeps the archive's row, and one the
  // details create is bound to the id derived for it, so a later delivery
  // finds that binding instead of deriving again.
  const f = fixture();
  const c = normalizeCases.find((c) => c.name === "complete final")! as unknown as {
    input: { lineups: unknown; incidents: unknown; event: Record<string, unknown> } };
  const detail = (body: unknown) => jsonb({ kind: "done", data: { status: 200, headers: {}, body: JSON.stringify(body), error: null } });
  const event = { ...c.input.event, external_id: f.event };
  const pair = (seq: number) => `
    DO $$ BEGIN PERFORM sofa.receive(gen_random_uuid(),'${f.source}','lineups','event/${f.event}/lineups',${seq},${detail(c.input.lineups)}); END $$;
    DO $$ BEGIN PERFORM sofa.receive(gen_random_uuid(),'${f.source}','incidents','event/${f.event}/incidents',${seq + 1},${detail(c.input.incidents)}); END $$;`;
  assertEquals(await query(`BEGIN; ${f.setup}${received(f)}
    UPDATE sofa.source SET detail_after='2026-01-01',create_players=true WHERE id='${f.source}';
    INSERT INTO sofa.binding(entity_kind,external_id,local_id) VALUES ('player','1','${f.player}');
    DO $$ BEGIN PERFORM sofa.receive('${f.request}','${f.source}','round','round/1',1,${roundAnswer(f, 2, 1)}); END $$;
    UPDATE sofa.event SET snapshot=${jsonb(event)} WHERE source_id='${f.source}' AND external_id='${f.event}';
    UPDATE game SET played=true,home_score=1,away_score=1,home_aet=1,away_aet=0,home_pen=4,away_pen=3 WHERE id='${f.game}';
    ${pair(2)}
    SELECT (SELECT count(*) FROM player_game WHERE game_id='${f.game}' AND player_id='${f.player}') || '|' ||
      ((SELECT local_id FROM sofa.binding WHERE entity_kind='player' AND external_id='1')::text='${f.player}') || '|' ||
      (SELECT bool_and(b.local_id=sofa.derived_id(jsonb_build_array('player',b.external_id))
         AND EXISTS (SELECT 1 FROM player p WHERE p.id=b.local_id))
       FROM sofa.binding b WHERE b.entity_kind='player' AND b.external_id<>'1');
    CREATE TEMP TABLE before_players AS SELECT count(*) AS n FROM player;
    UPDATE sofa.resource SET meta=meta-'complete' WHERE source_id='${f.source}' AND family IN ('lineups','incidents');
    ${pair(4)}
    SELECT (SELECT count(*) FROM player)-(SELECT n FROM before_players);
    ROLLBACK;`), "1|true|true\n0");
});

Deno.test("Sofa failures back off, pause on refusal and send exhausted details to review", async () => {
  const f = fixture();
  const failed = (status: number, headers: Record<string, string> = {}) =>
    jsonb({ kind: "failed", data: { status, headers, body: "", error: null, requests: 1 } });
  assertEquals(await query(`BEGIN; ${f.setup}
    ${open}
    DO $$ BEGIN PERFORM sofa.fail('${f.resource}',${failed(500)}); PERFORM sofa.fail('${f.resource}',${failed(500)}); END $$;
    SELECT ${state(f.resource, "failures")} || ':' || (${dueIn(f.resource)} BETWEEN 110000 AND 130000);
    DO $$ BEGIN PERFORM sofa.fail('${f.resource}',${failed(429, { "retry-after": "600" })}); END $$;
    SELECT (((sofa.provider()->>'until')::bigint-sofa.ms(now())) BETWEEN 590000 AND 610000) || '|' || (sofa.provider()->>'phase'='blocked');
    DO $$ BEGIN PERFORM sofa.fail('${f.resource}',${failed(403)}); END $$;
    SELECT (sofa.provider()->>'phase'='paused') || ':' || (sofa.provider()->>'reason');
    INSERT INTO sofa.resource(id,source_id,family,resource_key,path,meta) VALUES ('${f.later}','${f.source}','lineups','event/1/lineups','event/1/lineups','{"event_id":"1"}');
    ${ripe(f.later, "lineups")}
    DO $$ BEGIN FOR i IN 1..5 LOOP PERFORM sofa.fail('${f.later}',${failed(500)}); END LOOP; END $$;
    SELECT (${state(f.later, "phase")}='review') || '|' ||
      (SELECT count(*) FROM sofa.review WHERE source_id='${f.source}' AND reason='detail HTTP retries exhausted');
    ROLLBACK;`), "2:true\ntrue|true\ntrue:HTTP 403\ntrue|1");
});

Deno.test("Sofa enrollment binds a source once, and the tick seeds fixtures and flags requests that never answered", async () => {
  const f = fixture();
  const [other] = [id()];
  assertEquals(await query(`BEGIN; ${f.setup}
    UPDATE sofa.control SET minute_limit=6,used=0,budget_minute=date_trunc('minute',clock_timestamp());
    ${open}
    DELETE FROM sofa.resource WHERE source_id='${f.source}';
    DELETE FROM sofa.source WHERE id='${f.source}';
    SELECT (sofa.enable('${f.champ}','${f.phase}',${f.tournament},7,'30')).event_scope;
    SELECT resource_key FROM sofa.resource r JOIN sofa.source s ON s.id=r.source_id WHERE s.championship_id='${f.champ}';
    DO $$ BEGIN
      PERFORM sofa.enable('${f.champ}','${f.phase}',${f.tournament},8,'30');
      RAISE EXCEPTION 'identity changed';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'source identity is immutable' THEN RAISE; END IF; END $$;
    UPDATE sofa.source SET event_scope='fixtures' WHERE championship_id='${f.champ}';
    DO $$ BEGIN PERFORM sofa.tell(r.id,'ripe','{}') FROM sofa.resource r JOIN sofa.source s ON s.id=r.source_id WHERE s.championship_id='${f.champ}'; END $$;
    SELECT sofa.tick();
    SELECT string_agg(resource_key,',' ORDER BY resource_key) FROM sofa.resource r JOIN sofa.source s ON s.id=r.source_id WHERE s.championship_id='${f.champ}';
    UPDATE sofa_request SET admitted_at=clock_timestamp()-interval '1 hour' WHERE resource_key LIKE '%/rounds';
    SELECT sofa.tick();
    SELECT (SELECT stuck_at IS NOT NULL FROM sofa_request WHERE resource_key LIKE '%/rounds') || '|' ||
      (SELECT count(*) FROM sofa.review r JOIN sofa.source s ON s.id=r.source_id WHERE s.championship_id='${f.champ}' AND reason='request never answered');
    ROLLBACK;`), `competition\nunique-tournament/${f.tournament}/season/7/rounds\n1\nevent/${f.event},unique-tournament/${f.tournament}/season/7/rounds\n0\ntrue|1`);
});

Deno.test("Sofa identity recovery binds a reviewed plan whole or not at all", async () => {
  const f = fixture();
  const plan = (local: string, external = "77") => jsonb({
    candidate_bindings: [{ entity_kind: "team", external_id: external, local_id: local, provenance: "archive", evidence: {} }],
    conflicts: [{ entity_kind: "team", external_id: "78", reason: "duplicate" }],
  });
  assertEquals(await query(`BEGIN; ${f.setup}
    SELECT sofa.recover_bindings(${plan(f.home)})->>'bindings';
    SELECT local_id='${f.home}' FROM sofa.binding WHERE entity_kind='team' AND external_id='77';
    DO $$ BEGIN
      PERFORM sofa.recover_bindings(${plan(f.away)});
      RAISE EXCEPTION 'conflicting plan applied';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'binding conflict' THEN RAISE; END IF; END $$;
    SELECT count(*) FROM sofa.review WHERE reason='identity recovery conflict' AND evidence->>'external_id'='78';
    ROLLBACK;`), "1\nt\n1");
});

Deno.test("Sofa event-driven admission wakes due resources, avoids repeat fixture writes and arms budget schedule only when rate-limited", async () => {
  const f = fixture();
  const [first, second] = [id(), id()];
  assertEquals(await query(`BEGIN;
    DO $$ BEGIN PERFORM 1 FROM sofa.control WHERE id FOR UPDATE; END $$;
    ${f.setup}
    UPDATE sofa.source SET enabled=false WHERE id<>'${f.source}';
    UPDATE sofa.source SET event_scope='fixtures' WHERE id='${f.source}';
    UPDATE sofa.control SET minute_limit=1,used=0,budget_minute=date_trunc('minute',clock_timestamp());
    ${open}
    DELETE FROM sofa.resource WHERE source_id='${f.source}';
    UPDATE public.game SET kickoff=NULL WHERE id='${f.game}';
    DO $$ DECLARE before_tid tid;
    BEGIN
      PERFORM sofa.seed_fixtures(now());
      SELECT ctid INTO before_tid FROM sofa.resource WHERE source_id='${f.source}' AND resource_key='event/${f.event}';
      IF before_tid IS NULL THEN
        RAISE EXCEPTION 'seed_fixtures did not insert fixture resource';
      END IF;
      PERFORM sofa.seed_fixtures(now());
      IF (SELECT ctid FROM sofa.resource WHERE source_id='${f.source}' AND resource_key='event/${f.event}')<>before_tid THEN
        RAISE EXCEPTION 'seed_fixtures rewrote unchanged fixture resource';
      END IF;
    END $$;
    INSERT INTO sofa.resource(id,source_id,family,resource_key,path,priority)
      VALUES ('${first}','${f.source}','round','round/1','round/1',10),
             ('${second}','${f.source}','round','round/2','round/2',20);
    DO $$ BEGIN
      PERFORM hybrid_sofa_resource.spawn('${first}',jsonb_build_object('family','round','due',sofa.ms(now())-1000,'owed','[]'::jsonb),
        jsonb_build_object('service',sofa.service_actor()));
      PERFORM hybrid_sofa_resource.spawn('${second}',jsonb_build_object('family','round','due',sofa.ms(now())-1000,'owed','[]'::jsonb),
        jsonb_build_object('service',sofa.service_actor()));
    END $$;
    SELECT sofa.tick();
    SELECT (SELECT count(*) FROM public.schedule WHERE name='sofascore-budget')
      || '|' || (SELECT ${state(second, "phase")});
    UPDATE sofa.control SET minute_limit=6;
    SELECT sofa.admit();
    SELECT count(*) FROM public.schedule WHERE name='sofascore-budget';
    ROLLBACK;`), "1\n1|due\n1\n0");
});
