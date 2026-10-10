import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { createDatabase } from "mecha/packages/mecha-browser/src/database.ts";
import { browserTier } from "mecha/packages/mecha-browser/fence.ts";
import { fixture, identity } from "./community-fixture.ts";

Deno.test("community profile ownership and history also execute in the standalone PostgreSQL browser tier", async () => {
	const app = new URL("../", import.meta.url);
	const db = await createDatabase({});
	try {
		await db.exec(
			await Deno.readTextFile(
				new URL(import.meta.resolve("mecha/services/database/rls/rls.sql")),
			),
		);
		const shell = JSON.parse(
			await Deno.readTextFile(new URL("shell/shell.json", app)),
		) as { migrations: string[] };
		for (
			const migration of shell.migrations.filter((file) =>
				!file.endsWith("900_seed.sql")
			)
		) {
			await db.exec(
				browserTier(await Deno.readTextFile(new URL(migration, app))),
			);
		}
		await db.exec(
			browserTier(
				await Deno.readTextFile(
					new URL("services/database/sql/036_editing_parity.sql", app),
				),
			),
		);
		const migration = browserTier(
			await Deno.readTextFile(
				new URL("services/database/sql/040_community.sql", app),
			),
		);
		await db.exec(migration);
		await db.exec(migration);
		const f = fixture();
		await db.exec(`${f.setup}${identity(f.actor).replaceAll("SET LOCAL", "SET")}
      INSERT INTO user_biography(display_name,about_me) VALUES ('Portable profile','Public text');
      UPDATE game SET home_score=1 WHERE id='${f.game}';
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM user_directory WHERE id='${f.actor}' AND display_name='Portable profile'
          AND comment_count=2 AND edit_count=1)
          OR NOT EXISTS(SELECT 1 FROM game_change WHERE game_id='${f.game}' AND actor_id='${f.actor}'
            AND changes_json::jsonb='{"home_score":{"before":0,"after":1}}'::jsonb)
          THEN RAISE EXCEPTION 'browser tier lost public profile or immutable history'; END IF;
      END $$;`);
		const error = await assertRejects(() =>
			db.exec(`UPDATE user_biography SET display_name='Claimed'
      WHERE app_user_id='${f.legacy}';`)
		);
		assertEquals((error as Error & { code: string }).code, "42501");
		await db.exec(`DELETE FROM comment WHERE id='${f.comment}';
      DELETE FROM team_comment WHERE id='${f.teamComment}';`);
		const result = await db.query<{ comment_count: number }>(
			`SELECT comment_count FROM user_directory WHERE id='${f.actor}'`,
		);
		assertEquals(Number(result.rows[0].comment_count), 0);
		const forged = await assertRejects(() =>
			db.exec(`DELETE FROM game_change WHERE game_id='${f.game}';`)
		);
		assertEquals((forged as Error & { code: string }).code, "42501");
	} finally {
		await db.close();
	}
});
