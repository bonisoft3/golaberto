// SofaScore requests through the stack's real Airlock, against the bridge's
// simulator (simulators/sofascore), which answers each case's scripted path.
// Setup commits: Airlock acts on what an admission committed.
import { assertEquals } from "jsr:@std/assert@1";
import { query } from "./db.ts";

const id = () => crypto.randomUUID();

function enrolled(tournament: number) {
  const [champ, phase, home, away, game, source, resource] = Array.from({ length: 7 }, id);
  return {
    game, source, resource,
    sql: `
      INSERT INTO team(id,name,country) VALUES ('${home}','E2E home','Brasil'),('${away}','E2E away','Brasil');
      INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','E2E ${tournament}','Brasil','2026-01-01','2026-12-31');
      INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','E2E phase');
      INSERT INTO game(id,phase_id,day,home_id,away_id,played) VALUES ('${game}','${phase}','2026-10-27','${home}','${away}',false);
      INSERT INTO sofa.source(id,championship_id,unique_tournament_id,season_id,enabled) VALUES ('${source}','${champ}',${tournament},1,true);
      INSERT INTO sofa.binding(entity_kind,external_id,local_id) VALUES
        ('game','${tournament}','${game}'),('team','${tournament + 10}','${home}'),('team','${tournament + 20}','${away}');
      INSERT INTO sofa.stage_binding(source_id,stage_key,phase_id) VALUES ('${source}','${tournament + 30}','${phase}');
      INSERT INTO sofa.resource(id,source_id,family,resource_key,path)
        VALUES ('${resource}','${source}','round','round/1','e2e/${tournament}/round/1');
      DO $$ BEGIN
        PERFORM hybrid_sofa_resource.spawn('${resource}',jsonb_build_object('family','round','due',sofa.ms(now()),'owed','[]'::jsonb),
          jsonb_build_object('service',sofa.service_actor()));
        PERFORM sofa.tell('${resource}','ripe','{}');
      END $$;`,
  };
}

async function until(sql: string, want: string, what: string) {
  let got = "";
  for (let i = 0; i < 120; i++) {
    got = await query(sql);
    if (got === want) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const request = (source: string) => `SELECT status FROM sofa_request WHERE source_id='${source}'`;
const settled = (source: string) => `SELECT (l.outcome IS NOT NULL)::text FROM airlock.external_effect_ledger l
  JOIN sofa_request r ON l.row::text LIKE '%' || r.id || '%' WHERE l.effect='acquire' AND r.source_id='${source}'`;

Deno.test("SofaScore requests travel admission, Airlock, the transport and receive", async (t) => {
  const [applied, redirected, unparseable, refused] = [910001, 910002, 910003, 910004].map(enrolled);
  await query(`BEGIN;
    UPDATE sofa.source SET enabled=false;
    ${applied.sql}${redirected.sql}${unparseable.sql}${refused.sql}
    UPDATE sofa.control SET minute_limit=60,used=0,budget_minute=date_trunc('minute',clock_timestamp());
    DO $$ BEGIN PERFORM sofa.resume(); END $$;
    COMMIT;`);
  assertEquals(await query(`SELECT sofa.admit()`), "4");
  const admitted = await query(`SELECT used || '|' || budget_minute FROM sofa.control`);

  await t.step("an answer is received and applied", async () => {
    await until(request(applied.source), "applied", "applied request");
    assertEquals(await query(`SELECT played::text || '|' || home_score || '-' || away_score FROM game WHERE id='${applied.game}'`), "true|2-1");
  });

  await t.step("the redirects an answer followed are paid for", async () => {
    await until(request(redirected.source), "applied", "redirected request");
    assertEquals(await query(`SELECT response->>'requests' FROM sofa.observation WHERE source_id='${redirected.source}'`), "3");
    const [used, minute] = (await query(`SELECT used || '|' || budget_minute FROM sofa.control`)).split("|");
    const [spent, spentMinute] = admitted.split("|");
    // Admission spent one per request; the answer adds its two hops, in the
    // minute it lands in.
    assertEquals(Number(used), minute === spentMinute ? Number(spent) + 2 : 2);
  });

  await t.step("a provider refusal takes the request's error arrow and is recorded on its resource", async () => {
    await until(request(refused.source), "failed", "refused request");
    assertEquals(await query(`SELECT (sofa.resource_state(id)->>'failures') || '|' || (sofa.resource_state(id)->>'phase') || '|' || last_error
      FROM sofa.resource WHERE id='${refused.resource}'`), "1|backoff|status 503");
  });

  // Until Airlock bounds its dead letters, a move whose commit refuses the
  // answer stays owed: the outcome is in the ledger and the request waits.
  await t.step("an answer the database cannot parse leaves the request acquiring with its outcome kept", async () => {
    await until(settled(unparseable.source), "true", "ledger outcome");
    assertEquals(await query(request(unparseable.source)), "acquiring");
    assertEquals(await query(`SELECT count(*) FROM sofa.observation WHERE source_id='${unparseable.source}'`), "0");
  });

  await t.step("a body read error after HTTP 200 is charged and backed off", async () => {
    const broken = enrolled(910005);
    await query(`BEGIN; ${broken.sql} COMMIT;`);
    const before = await query(`SELECT used || '|' || budget_minute FROM sofa.control`);
    assertEquals(await query(`SELECT sofa.admit()`), "1");
    await until(request(broken.source), "failed", "body read failure");
    assertEquals(await query(`SELECT (sofa.resource_state(id)->>'failures') || '|' || (sofa.resource_state(id)->>'phase') || '|' || last_error
      FROM sofa.resource WHERE id='${broken.resource}'`), "1|backoff|read response: connection closed");
    const [used, minute] = (await query(`SELECT used || '|' || budget_minute FROM sofa.control`)).split("|");
    const [spent, spentMinute] = before.split("|");
    assertEquals(minute === spentMinute ? Number(used) === Number(spent) + 2 : [1, 2].includes(Number(used)), true);
  });
});

