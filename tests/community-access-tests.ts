import { assertEquals } from "jsr:@std/assert@1.0.11";
const { query } = await import(
  Deno.env.get("COMMUNITY_DB_HELPER") ?? "./db.ts"
);
const identity = (id: string, guest = false) =>
  `RESET ROLE; SET LOCAL app.scopes='public:,user:${id}'; SET LOCAL request.jwt.claims='{"sub":"${id}","guest":${guest}}'; SET LOCAL ROLE app_user;`;
Deno.test("community UI eligibility follows the authenticated owner and biography lifecycle", async () => {
  const [
    owner,
    other,
    champ,
    phase,
    home,
    away,
    game,
    comment,
    teamComment,
    biography,
  ] = Array.from({ length: 10 }, () => crypto.randomUUID());
  const result = await query(`BEGIN;
 INSERT INTO app_user(id,handle) VALUES ('${owner}','${owner}'),('${other}','${other}');
 INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Eligibility','Brasil','2026-01-01','2026-12-31');
 INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Eligibility');
 INSERT INTO team(id,name,country) VALUES ('${home}','Eligibility home','Brasil'),('${away}','Eligibility away','Brasil');
 INSERT INTO game(id,phase_id,home_id,away_id,day) VALUES ('${game}','${phase}','${home}','${away}','2026-06-01');
 INSERT INTO comment(id,game_id,app_user_id,body) VALUES ('${comment}','${game}','${owner}','Own');
 INSERT INTO team_comment(id,team_id,app_user_id,body) VALUES ('${teamComment}','${home}','${owner}','Own');
 ${identity(owner)}
 SELECT count(*),count(biography_id) FROM community_access;
 INSERT INTO user_biography(id,display_name) VALUES ('${biography}','Public biography');
 SELECT biography_id FROM community_access WHERE kind='profile';
 SELECT p.display_name FROM community_access a CROSS JOIN LATERAL user_biography(a) p WHERE a.kind='profile';
 SELECT p.display_name FROM user_directory a CROSS JOIN LATERAL user_biography(a) p WHERE a.id='${owner}';
 ${identity(other)}
 SELECT count(*) FROM community_access WHERE record_id IN ('${owner}','${comment}','${teamComment}');
 SELECT record_id FROM community_access;
 ${identity(owner, true)}
 SELECT count(*) FROM community_access;
 ${identity(owner)}
 DELETE FROM comment WHERE id='${comment}';
 SELECT count(*) FROM community_access WHERE kind='comment';
 ROLLBACK;`);
  assertEquals(
    result,
    `3|0\n${biography}\nPublic biography\nPublic biography\n0\n${other}\n0\n0`,
  );
});
