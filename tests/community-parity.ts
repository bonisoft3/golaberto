import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";

import { query, replayLock } from "./db.ts";
import { fixture, identity } from "./community-fixture.ts";

async function refused(script: string, code = "42501") {
	const error = await assertRejects(() => query(`BEGIN;${script}`));
	assertEquals((error as Error & { code: string }).code, code);
}

Deno.test("community biographies are public, self-owned, bounded and independent of authentication handles", async () => {
	const f = fixture();
	await query(`BEGIN;${f.setup}${identity(f.reader)}
    INSERT INTO user_biography(display_name,location,about_me)
      VALUES ('Nome Público','São Paulo','Public biography');
    UPDATE user_biography SET display_name='Edited public name',about_me=NULL WHERE app_user_id='${f.reader}';
    ${identity(f.other)}
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM user_directory WHERE id='${f.reader}'
        AND display_name='Edited public name' AND location='São Paulo' AND about_me IS NULL
        AND handle='reader-${f.reader}' AND comment_count=0 AND edit_count=0)
        THEN RAISE EXCEPTION 'public biography edits did not preserve auth identity'; END IF;
      IF NOT EXISTS (SELECT 1 FROM user_directory WHERE id='${f.legacy}' AND display_name='Legacy biography')
        THEN RAISE EXCEPTION 'legacy public identity disappeared'; END IF;
      -- The search collation folds case and accents; ILIKE refuses a nondeterministic collation.
      IF NOT EXISTS (SELECT 1 FROM user_directory WHERE id='${f.reader}' AND search_key LIKE '%EDÍTED%')
        THEN RAISE EXCEPTION 'directory search must fold case and accents'; END IF;
      IF (SELECT comment_count FROM user_directory WHERE id='${f.actor}')<>2
        THEN RAISE EXCEPTION 'both comment subjects must contribute to profile counts'; END IF;
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('user_directory'::regclass,'user_biography'::regclass)
        AND attname IN ('email','birthday','password','public_key','last_login','identity_url'))
        THEN RAISE EXCEPTION 'private account data was added to the public profile'; END IF;
    END $$;
    ${identity(f.reader)}
    UPDATE user_biography SET display_name=' ' WHERE app_user_id='${f.reader}';
    DO $$ BEGIN
      IF (SELECT display_name FROM user_directory WHERE id='${f.reader}') IS DISTINCT FROM 'reader-${f.reader}'
        THEN RAISE EXCEPTION 'a cleared public name must retain the existing byline'; END IF;
    END $$;
    SET LOCAL app.scopes='';
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM user_directory) THEN RAISE EXCEPTION 'profile view bypassed the scope floor'; END IF;
    END $$;
    ROLLBACK;`);
	for (const field of ["display_name", "location", "about_me"]) {
		await refused(
			`${f.setup}${
				identity(f.reader)
			}INSERT INTO user_biography(${field}) VALUES (repeat('x',${
				field === "about_me" ? 2001 : 101
			}));`,
			"23514",
		);
	}
});

Deno.test("guests, other authors and editors cannot claim profiles by matching a legacy byline", async () => {
	const f = fixture();
	await refused(
		`${f.setup}${
			identity(f.reader, true)
		}INSERT INTO user_biography(display_name) VALUES ('Guest');`,
	);
	await refused(
		`${f.setup}${
			identity(f.reader, null)
		}INSERT INTO user_biography(display_name) VALUES ('Missing guest claim');`,
	);
	await refused(
		`${f.setup}${
			identity(f.reader)
		}INSERT INTO user_biography(app_user_id,display_name) VALUES ('${f.legacy}','Legacy biography');`,
	);
	for (const actor of [f.reader, f.actor]) {
		await refused(
			`${f.setup}${
				identity(actor)
			}UPDATE user_biography SET display_name='Claimed' WHERE id='${f.biography}';`,
		);
		await refused(
			`${f.setup}${
				identity(actor)
			}UPDATE user_biography SET app_user_id='${actor}' WHERE id='${f.biography}';`,
		);
		assertEquals(
			await query(`BEGIN;${f.setup}${identity(actor)}
      UPDATE app_user SET handle='claimed-${actor}' WHERE id='${actor}';
      SELECT count(*) FROM app_user WHERE id='${actor}' AND handle='claimed-${actor}';ROLLBACK;`),
			"0",
		);
	}
	await refused(
		`${f.setup}${
			identity(f.reader)
		}INSERT INTO user_biography(app_user_id,display_name,updated_at)
    VALUES ('${f.reader}','Forged timestamp','2000-01-01');`,
	);
	await query(`BEGIN;${f.setup}${identity(f.reader)}
    INSERT INTO user_biography(display_name) VALUES ('legacy-${f.legacy}');
    DO $$ BEGIN
      IF (SELECT app_user_id FROM user_biography WHERE display_name='legacy-${f.legacy}') IS DISTINCT FROM '${f.reader}'::uuid
        OR (SELECT display_name FROM user_directory WHERE id='${f.legacy}') IS DISTINCT FROM 'Legacy biography'
        THEN RAISE EXCEPTION 'public names conferred ownership'; END IF;
    END $$;ROLLBACK;`);
});

Deno.test("comment deletion requires its signed-in author and refuses guest or editor impersonation", async () => {
	const f = fixture();
	for (
		const [table, id] of [["comment", f.comment], [
			"team_comment",
			f.teamComment,
		]]
	) {
		for (
			const [actor, guest] of [[f.actor, true], [f.other, false], [
				f.reader,
				false,
			], [f.actor, null]] as const
		) {
			await refused(
				`${f.setup}${
					identity(actor, guest)
				}DELETE FROM ${table} WHERE id='${id}';`,
			);
		}
	}
	await query(`BEGIN;${f.setup}${identity(f.actor)}
    DELETE FROM comment WHERE id='${f.comment}';
    DELETE FROM team_comment WHERE id='${f.teamComment}';
    DO $$ BEGIN
      IF (SELECT comment_count FROM user_directory WHERE id='${f.actor}')<>0
        THEN RAISE EXCEPTION 'author deletion did not update profile counts'; END IF;
    END $$;ROLLBACK;`);
});

Deno.test("game corrections retain immutable actor snapshots, field diffs and scoped paginated history", async () => {
	const f = fixture();
	await query(`BEGIN;${f.setup}${identity(f.actor)}
    UPDATE game SET home_score=2,attendance=0 WHERE id='${f.game}';
    UPDATE game SET home_score=2,attendance=0 WHERE id='${f.game}';
    ${identity(f.other)}
    UPDATE game SET attendance=1200 WHERE id='${f.game}';
    UPDATE game SET day='2026-01-03' WHERE id='${f.game}';
    DO $$ BEGIN
      IF (SELECT count(*) FROM game_change WHERE game_id='${f.game}')<>3
        THEN RAISE EXCEPTION 'no-op correction fabricated a version'; END IF;
      IF NOT EXISTS(SELECT 1 FROM game_change WHERE game_id='${f.game}' AND version=1
        AND actor_id='${f.actor}' AND actor_handle='actor-${f.actor}'
        AND changes_json::jsonb='{"attendance":{"before":null,"after":0},"home_score":{"before":0,"after":2}}'::jsonb)
        THEN RAISE EXCEPTION 'the first correction lost actor, zero or null semantics'; END IF;
      IF (SELECT version FROM game_change WHERE game_id='${f.game}' ORDER BY version DESC LIMIT 1 OFFSET 1)<>2
        THEN RAISE EXCEPTION 'scoped history pagination lost a version'; END IF;
      IF (SELECT edit_count FROM user_directory WHERE id='${f.actor}')<>1
        OR (SELECT edit_count FROM user_directory WHERE id='${f.other}')<>2
        OR (SELECT last_edit_at FROM user_directory WHERE id='${f.actor}') IS NULL
        THEN RAISE EXCEPTION 'profile edit counters disagree with recorded corrections'; END IF;
      IF EXISTS (SELECT 1 FROM game_change c CROSS JOIN LATERAL jsonb_object_keys(c.changes_json::jsonb) k
        WHERE c.game_id='${f.game}' AND k IN ('created_by','updated_by','txid','scope_id','slug'))
        THEN RAISE EXCEPTION 'history included metadata outside the public field allowlist'; END IF;
    END $$;
    RESET ROLE;
    UPDATE app_user SET handle='renamed-${f.actor}' WHERE id='${f.actor}';
    UPDATE game SET updated_by='${f.reader}' WHERE id='${f.game}';
    DO $$ BEGIN
      IF (SELECT actor_handle FROM game_change WHERE game_id='${f.game}' AND version=1) IS DISTINCT FROM 'actor-${f.actor}'
        OR (SELECT count(*) FROM game_change WHERE game_id='${f.game}')<>3
        THEN RAISE EXCEPTION 'account or attribution metadata rewrote public history'; END IF;
      -- Raw identifiers and ISO timestamps once reached the public history.
      IF (SELECT changes_json::jsonb->'day'->>'after' FROM game_change WHERE game_id='${f.game}' AND version=3)<>'03/01/2026'
        OR community_change_display(jsonb_build_object('home_id',jsonb_build_object('before','${f.home}','after','${f.away}')))
          <>'{"home_id":{"before":"Community home","after":"Community away"}}'::jsonb
        THEN RAISE EXCEPTION 'history must record names and archive dates, not identifiers'; END IF;
    END $$;
    SET LOCAL request.jwt.claims='{"sub":"${f.actor}","guest":false}';
    SET LOCAL ROLE service;
    UPDATE game SET attendance=1300 WHERE id='${f.game}';
    RESET ROLE;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM game_change WHERE game_id='${f.game}' AND version=4
        AND actor_id IS NULL AND actor_handle IS NULL)
        THEN RAISE EXCEPTION 'a service write reused ambient human attribution'; END IF;
    END $$;
    DELETE FROM comment WHERE id='${f.comment}';
    DELETE FROM team_comment WHERE id='${f.teamComment}';
    DELETE FROM game WHERE id='${f.game}';
    DELETE FROM app_user WHERE id='${f.actor}';
    ${identity(f.reader)}
    DO $$ BEGIN
      IF (SELECT count(*) FROM game_change WHERE game_id='${f.game}')<>4
        OR NOT EXISTS(SELECT 1 FROM game_change WHERE game_id='${f.game}' AND version=1
          AND actor_id='${f.actor}' AND home_name='Community home' AND away_name='Community away')
        THEN RAISE EXCEPTION 'source deletion erased immutable history'; END IF;
    END $$;ROLLBACK;`);
});

Deno.test("clients cannot forge, revise, remove or directly invoke the history writer", async () => {
	const f = fixture();
	const recorded = `${f.setup}${
		identity(f.actor)
	}UPDATE game SET home_score=1 WHERE id='${f.game}';`;
	for (const role of ["app_user", "service"]) {
		for (
			const operation of [
				`INSERT INTO game_change(game_id,version,actor_id,actor_handle,home_name,away_name,championship_name,changes_json)
        VALUES ('${f.game}',99,'${f.other}','Forged','H','A','C','{"home_score":{"before":0,"after":99}}');`,
				`UPDATE game_change SET actor_id='${f.other}' WHERE game_id='${f.game}';`,
				`DELETE FROM game_change WHERE game_id='${f.game}';`,
				`TRUNCATE game_change;`,
				`SELECT community_game_change();`,
			]
		) {
			await refused(
				`${recorded}RESET ROLE;SET LOCAL ROLE ${role};${operation}`,
			);
		}
	}
	await refused(
		`${recorded}RESET ROLE;UPDATE game_change SET actor_handle='Changed' WHERE game_id='${f.game}';`,
	);
	await refused(
		`${recorded}RESET ROLE;DELETE FROM game_change WHERE game_id='${f.game}';`,
	);
});

Deno.test("community migration replays without changing biography or history and converts a generated view placeholder", async () => {
	const migrationPath = new URL(
		"../services/database/sql/040_community.sql",
		import.meta.url,
	);
	const migration = (await Deno.readTextFile(migrationPath)).replaceAll(
		"\nBEGIN;\n",
		"\n",
	).replaceAll("\nCOMMIT;\n", "\n");
	const f = fixture();
	assertEquals(
		await query(`BEGIN;${replayLock}${f.setup}${identity(f.actor)}
    UPDATE game SET home_score=1 WHERE id='${f.game}';RESET ROLE;
    -- A setting, not a temp table: pgroll records DDL in its ledger, and
    -- concurrent checks recording against one parent collide.
    DO $$ BEGIN PERFORM set_config('golaberto.before_replay', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text), '[]')
      FROM game_change c WHERE game_id='${f.game}')::text, true); END $$;
    DROP VIEW user_directory CASCADE;CREATE TABLE user_directory(id uuid PRIMARY KEY);
    ${migration}${migration}
    DO $$ BEGIN
      IF (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text), '[]') FROM game_change c WHERE game_id='${f.game}')
          IS DISTINCT FROM current_setting('golaberto.before_replay')::jsonb
        OR NOT EXISTS(SELECT 1 FROM user_biography WHERE id='${f.biography}' AND display_name='Legacy biography')
        THEN RAISE EXCEPTION 'migration replay rewrote community records'; END IF;
    END $$;
    SELECT count(*) FROM pg_class WHERE oid='user_directory'::regclass AND relkind='v'
      AND reloptions @> ARRAY['security_invoker=true'];ROLLBACK;`),
		"1",
	);
	await refused(
		`${replayLock}${f.setup}DROP VIEW user_directory CASCADE;CREATE TABLE user_directory(id uuid PRIMARY KEY);
    INSERT INTO user_directory VALUES (gen_random_uuid());${migration}`,
		"P0001",
	);
});
