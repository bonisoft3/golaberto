import postgres from "npm:postgres@3.4.9";
import { replayLock } from "./db.ts";
import { SignJWT } from "npm:jose@6.0.11";
import sharp from "npm:sharp@0.34.5";
import { normalize } from "../services/media/normalize.ts";
import { RequestError } from "../services/media/request.ts";
import {
  createNativeGateway,
  nativeRepository,
} from "../services/media/native-gateway.ts";
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("native object upload and ordinary field attachment enforce ownership, atomic replacement and bounded pending storage", async () => {
  // db.ts refuses to load without it.
  const url = Deno.env.get("DATABASE_URL")!;
  const sql = postgres(url, { max: 1 }), repository = nativeRepository(url);
  const secret = "native-media-test-secret-at-least-32-bytes";
  const gateway = createNativeGateway(repository, secret);
  const [owner, other, editor, team] = Array.from(
    { length: 4 },
    () => crypto.randomUUID(),
  );
  const key = () => `${crypto.randomUUID()}.png`;
  const red = await sharp({
    create: { width: 16, height: 32, channels: 4, background: "red" },
  }).png().toBuffer();
  const blue = await sharp({
    create: { width: 32, height: 16, channels: 4, background: "blue" },
  }).png().toBuffer();
  const token = async (actor: string, guest = false) =>
    await new SignJWT({ sub: actor, role: "app_user", guest })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(
        new TextEncoder().encode(secret),
      );
  async function upload(objectKey: string, bearer: string, body = red) {
    return await gateway(
      new Request(`http://media/blobs/mecha-objects/${objectKey}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "image/png",
        },
        body: new Uint8Array(body),
      }),
    );
  }
  const get = (objectKey: string) =>
    gateway(new Request(`http://media/blobs/mecha-objects/${objectKey}`));
  async function retired(objectKey: string, ...bearers: string[]) {
    for (const bearer of bearers) {
      assert(
        (await upload(objectKey, bearer, blue)).status === 409,
        "a retired public URL cannot be reassigned, including to its former owner",
      );
    }
    assert(
      (await get(objectKey)).status === 404,
      "rejected reuse must leave the retired public URL unavailable",
    );
    assert(
      (await sql`SELECT 1 FROM golaberto_upload.object WHERE key=${objectKey}`)
        .length === 0,
      "retiring a public URL must delete its image bytes",
    );
  }
  async function mutate(actor: string, script: string, guest = false) {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims',${
        JSON.stringify({ sub: actor, role: "app_user", guest })
      },true)`;
      await tx`SELECT set_config('app.scopes',${`public:,user:${actor}`},true)`;
      await tx`SET LOCAL ROLE app_user`;
      return await tx.unsafe(script);
    });
  }
  async function refuses(
    actor: string,
    script: string,
    code = "42501",
    guest = false,
  ) {
    try {
      await mutate(actor, script, guest);
    } catch (e) {
      assert(
        e instanceof postgres.PostgresError && e.code === code,
        `expected ${code}: ${e}`,
      );
      return;
    }
    throw new Error("Unexpected attachment authority");
  }
  try {
    // The checked database is migrated. Replaying 041 twice in a transaction
    // that rolls back proves it idempotent without committing DDL, which every
    // concurrent check would race for pgroll's linear ledger.
    const migration = (await Deno.readTextFile(
      new URL("../services/database/sql/041_native_media.sql", import.meta.url),
    )).replace(/^(BEGIN|COMMIT);$/gm, "");
    await sql.unsafe(`BEGIN;${replayLock}${migration}${migration}ROLLBACK;`);
    await sql`INSERT INTO app_user(id,handle) VALUES(${owner},${owner}),(${other},${other}),(${editor},${editor})`;
    await sql`INSERT INTO editor(id,app_user_id) VALUES(${crypto.randomUUID()},${editor})`;
    await sql`INSERT INTO team(id,name,country) VALUES(${team},'Native media','Brasil')`;
    const ownToken = await token(owner),
      otherToken = await token(other),
      editorToken = await token(editor);
    const first = key(), foreign = key(), replacement = key();
    assert((await upload(first, ownToken)).status === 204);
    assert((await get(first)).status === 404, "unbound bytes are private");
    assert(
      (await upload(first, ownToken)).status === 204,
      "same key/content retry succeeds",
    );
    assert(
      (await upload(first, ownToken, blue)).status === 409,
      "a key cannot overwrite different bytes",
    );
    assert(
      (await upload(first, otherToken)).status === 403,
      "another account cannot reuse key",
    );
    assert((await upload(key(), await token(owner, true))).status === 403);
    assert((await upload(foreign, otherToken)).status === 204);
    await refuses(
      owner,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${foreign}')`,
    );
    await refuses(
      other,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${first}')`,
    );
    await refuses(
      owner,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${key()}')`,
    );
    await mutate(
      owner,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${first}')`,
    );
    assert((await get(first)).status === 200);
    await mutate(
      owner,
      `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM community_access c, LATERAL user_avatar(c) a
        WHERE c.record_id='${owner}' AND c.avatar_id='${owner}' AND a.avatar_key='${first}')
        THEN RAISE EXCEPTION 'own avatar eligibility must invalidate into update controls'; END IF;
    END $$`,
    );
    for (const [actor, guest] of [[other, false], [owner, true]] as const) {
      await mutate(
        actor,
        `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM community_access WHERE record_id='${owner}')
          THEN RAISE EXCEPTION 'another account or guest saw owner controls'; END IF;
        IF NOT EXISTS (SELECT 1 FROM user_directory WHERE id='${owner}' AND avatar_key='${first}')
          THEN RAISE EXCEPTION 'public avatar missing from the directory'; END IF;
      END $$`,
        guest,
      );
    }
    assert(
      (await upload(first, ownToken)).status === 204,
      "retry remains idempotent after attachment",
    );
    await mutate(
      owner,
      `UPDATE user_avatar SET avatar_key='${first}' WHERE id='${owner}'`,
    );
    await refuses(
      other,
      `UPDATE user_avatar SET avatar_key='${foreign}' WHERE id='${owner}'`,
    );
    await refuses(other, `DELETE FROM user_avatar WHERE id='${owner}'`);
    await refuses(editor, `DELETE FROM user_avatar WHERE id='${owner}'`);
    await refuses(
      owner,
      `UPDATE user_avatar SET avatar_key=NULL WHERE id='${owner}'`,
      "42501",
      true,
    );
    assert((await upload(replacement, ownToken, blue)).status === 204);
    await refuses(
      owner,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${replacement}')`,
      "23505",
    );
    const rolledBack =
      await sql`SELECT attached_kind FROM golaberto_upload.object WHERE key=${replacement}`;
    assert(
      rolledBack[0].attached_kind === null,
      "later record failure rolls binding back",
    );
    await refuses(
      owner,
      `UPDATE user_avatar SET avatar_key='${foreign}' WHERE id='${owner}'`,
    );
    assert(
      (await get(first)).status === 200,
      "failed replacement preserves old image",
    );
    assert(
      (await get(replacement)).status === 404,
      "failed attachment leaves own pending private",
    );
    await mutate(
      owner,
      `UPDATE user_avatar SET avatar_key='${replacement}' WHERE id='${owner}'`,
    );
    assert(
      (await get(first)).status === 404 &&
        (await get(replacement)).status === 200,
      "replace unpublishes and removes old object atomically",
    );
    await retired(first, ownToken, otherToken);
    const logo = key();
    assert((await upload(logo, editorToken)).status === 204);
    await refuses(
      owner,
      `UPDATE team SET logo_key='${replacement}' WHERE id='${team}'`,
    );
    await mutate(
      editor,
      `UPDATE team SET logo_key='${logo}' WHERE id='${team}'`,
    );
    assert((await get(logo)).status === 200);
    const [opponent, player, season, phase, game, nextGame] = Array.from({
      length: 6,
    }, () => crypto.randomUUID());
    const readKeys =
      `SELECT home_logo_key AS key FROM game_archive WHERE id='${game}'
      UNION ALL SELECT home_logo_key FROM player_appearance WHERE game_id='${game}'
      UNION ALL SELECT latest_team_logo_key FROM player_directory WHERE id='${player}'
      UNION ALL SELECT team_logo_key FROM championship_attendance WHERE championship_id='${season}' AND team_id='${team}'
      UNION ALL SELECT home_logo_key FROM match_head_to_head WHERE target_game_id='${nextGame}' AND game_id='${game}'`;
    await sql.unsafe(`BEGIN;
      INSERT INTO team(id,name,country) VALUES('${opponent}','Logo opponent','Brasil');
      INSERT INTO player(id,name) VALUES('${player}','Logo player');
      INSERT INTO championship(id,name,region_name,begins,ends) VALUES('${season}','Logo season','Brasil','2026-01-01','2026-12-31');
      INSERT INTO phase(id,name,championship_id) VALUES('${phase}','Final','${season}');
      INSERT INTO game(id,phase_id,home_id,away_id,day,played,home_score,away_score,attendance)
        VALUES('${game}','${phase}','${team}','${opponent}','2026-06-01',true,0,0,5);
      INSERT INTO game(id,phase_id,home_id,away_id,day) VALUES('${nextGame}','${phase}','${team}','${opponent}','2026-06-02');
      INSERT INTO player_game(game_id,player_id,side,on_minute,off_minute) VALUES('${game}','${player}','home',0,90);
      SET LOCAL request.jwt.claims='{"sub":"${editor}","role":"app_user","guest":false}';
      SET LOCAL app.scopes='public:,user:${editor}';
      SET LOCAL ROLE app_user;
      DO $$ BEGIN
        IF (SELECT count(*) FROM (${readKeys}) logos WHERE key='${logo}')<>5
          THEN RAISE EXCEPTION 'archive, appearance, latest club and attendance reads must expose the current uploaded logo'; END IF;
      END $$;
      UPDATE team SET logo_key=NULL WHERE id='${team}';
      DO $$ BEGIN
        IF (SELECT count(*) FROM (${readKeys}) logos WHERE key IS NULL)<>5
          THEN RAISE EXCEPTION 'all request-time logo projections must clear immediately without rebuilding a stored read model'; END IF;
      END $$;
      ROLLBACK;`);
    await refuses(
      editor,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${editor}','${logo}')`,
      "23514",
    );
    await refuses(other, `UPDATE team SET logo_key=NULL WHERE id='${team}'`);
    await sql`DELETE FROM editor WHERE app_user_id=${editor}`;
    await refuses(editor, `UPDATE team SET logo_key=NULL WHERE id='${team}'`);
    const pending = Array.from({ length: 5 }, key);
    for (const objectKey of pending.slice(0, 4)) {
      assert((await upload(objectKey, ownToken)).status === 204);
    }
    assert(
      (await upload(pending[4], ownToken)).status === 429,
      "pending uploads are bounded",
    );
    assert(
      (await upload(pending[0], ownToken)).status === 204,
      "retry succeeds even at pending limit",
    );
    await sql`UPDATE golaberto_upload.object SET created_at=clock_timestamp()-interval '25 hours' WHERE owner_id=${owner}`;
    await refuses(
      owner,
      `UPDATE user_avatar SET avatar_key='${pending[0]}' WHERE id='${owner}'`,
      "23514",
    );
    assert(
      (await upload(pending[4], ownToken)).status === 204,
      "next upload reclaims expired pending objects",
    );
    const retained =
      await sql`SELECT key,attached_kind FROM golaberto_upload.object WHERE owner_id=${owner}`;
    assert(
      retained.length === 2 && retained.some((r) => r.key === replacement),
      "bound image survives TTL reclamation",
    );
    const metadataAfterExpiry = await mutate(
      owner,
      "SELECT * FROM user_pending_upload",
    );
    assert(
      metadataAfterExpiry.length === 1 &&
        metadataAfterExpiry[0].id === pending[4],
      "expiry removes matching private metadata",
    );
    assert(
      (await sql`SELECT 1 FROM golaberto_upload.key_registry WHERE key IN ${
        sql(pending.slice(0, 4))
      }`).length === 0,
      "expired images that were never public must not accumulate key reservations",
    );
    const remaining = Array.from({ length: 6 }, key);
    const normalized = await normalize(red, "image/png");
    const races = await Promise.allSettled(
      remaining.map((k) => repository.stage(owner, k, normalized)),
    );
    assert(races.filter((r) => r.status === "fulfilled").length === 3);
    assert(
      races.filter((r) =>
        r.status === "rejected" && r.reason instanceof RequestError &&
        r.reason.status === 429
      ).length === 3,
    );
    const count =
      await sql`SELECT count(*)::integer AS n FROM golaberto_upload.object WHERE owner_id=${owner} AND attached_kind IS NULL`;
    assert(count[0].n === 4, "concurrent upload cannot exceed budget");
    const privateList = await mutate(
      other,
      "SELECT * FROM user_pending_upload",
    );
    assert(
      privateList.length === 1 && privateList[0].id === foreign &&
        !("medium" in privateList[0]),
    );
    assert(
      (await mutate(
        other,
        `DELETE FROM user_pending_upload WHERE id='${pending[4]}' RETURNING id`,
      )).length === 0,
    );
    assert(
      (await mutate(owner, "SELECT * FROM user_pending_upload", true))
        .length === 0,
    );
    assert(
      (await mutate(
        owner,
        `DELETE FROM user_pending_upload WHERE id='${pending[4]}' RETURNING id`,
      )).length === 1,
    );
    assert(
      (await upload(key(), ownToken)).status === 204,
      "native pending delete releases budget",
    );
    assert(
      (await sql`SELECT 1 FROM golaberto_upload.key_registry WHERE key=${
        pending[4]
      }`).length === 0,
      "cancelled images that were never public must not accumulate key reservations",
    );
    assert(
      (await mutate(
        owner,
        `DELETE FROM user_pending_upload WHERE id='${replacement}' RETURNING id`,
      )).length === 0,
      "pending API never removes attached image",
    );
    await refuses(owner, "SELECT medium FROM golaberto_upload.object");
    await refuses(owner, "SELECT key FROM golaberto_upload.key_registry");
    await refuses(
      owner,
      `SELECT golaberto_upload.stage('${owner}','${key()}','${
        "a".repeat(64)
      }','x','x')`,
    );
    await mutate(owner, `DELETE FROM user_avatar WHERE id='${owner}'`);
    assert((await get(replacement)).status === 404);
    await retired(replacement, ownToken, otherToken);
    await sql`DELETE FROM app_user WHERE id=${editor}`;
    assert(
      (await get(logo)).status === 200,
      "deleting uploader preserves attached team logo",
    );
    await sql`DELETE FROM team WHERE id=${team}`;
    assert(
      (await get(logo)).status === 404,
      "deleting team removes its object",
    );
    await retired(logo, otherToken);
    const [accountAvatar] =
      await sql`SELECT key FROM golaberto_upload.object WHERE owner_id=${owner} AND attached_kind IS NULL LIMIT 1`;
    await mutate(
      owner,
      `INSERT INTO user_avatar(id,avatar_key) VALUES('${owner}','${accountAvatar.key}')`,
    );
    assert((await get(accountAvatar.key)).status === 200);
    await sql`DELETE FROM app_user WHERE id=${owner}`;
    await retired(accountAvatar.key, otherToken);
    assert(
      (await sql`SELECT 1 FROM golaberto_upload.object WHERE owner_id=${owner}`)
        .length === 0,
    );
  } finally {
    await sql`DELETE FROM team WHERE id=${team}`;
    await sql`DELETE FROM editor WHERE app_user_id IN (${owner},${other},${editor})`;
    await sql`DELETE FROM app_user WHERE id IN (${owner},${other},${editor})`;
    await repository.close();
    await sql.end();
  }
});
