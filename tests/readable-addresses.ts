import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
	throw new Error(
		"readable-addresses requires DATABASE_URL for a disposable database",
	);
}

Deno.test("readable addresses resolve distinct records and keep relational identities", async () => {
	const sql = postgres(url, { max: 1 });
	const marker = crypto.randomUUID();
	const tx = await sql.reserve();
	try {
		await tx`BEGIN`;
		{
			const names = [
				`São Tomé ${marker}`,
				`São Tomé ${marker}`,
				`São Tomé ${marker}-2`,
			];
			const teams = [];
			for (const name of names) {
				const [team] =
					await tx`INSERT INTO team(name,country) VALUES (${name},'Brasil') RETURNING id,slug`;
				teams.push(team);
			}
			assertEquals(teams[0].slug, `sao-tome-${marker}`);
			assertEquals(teams[1].slug, `sao-tome-${marker}-2`);
			assertEquals(teams[2].slug, `sao-tome-${marker}-2-2`);
			const [championship] = await tx`
        INSERT INTO championship(name,region_name,begins,ends)
        VALUES (${`Série A ${marker}`},'Brasil','2026-01-01','2026-12-31') RETURNING id,slug`;
			assertEquals(championship.slug, `brasil-serie-a-${marker}-2026`);
			const [phase] = await tx`
        INSERT INTO phase(championship_id,name) VALUES (${championship.id},'Final') RETURNING id`;
			const [group] = await tx`
        INSERT INTO stage_group(phase_id,name) VALUES (${phase.id},'Único') RETURNING id,slug`;
			assertEquals(group.slug, `${championship.slug}-final-unico`);
			const [game] = await tx`
        INSERT INTO game(phase_id,day,home_id,away_id)
        VALUES (${phase.id},'2026-07-01',${teams[0].id},${
				teams[1].id
			}) RETURNING id,slug`;
			assert(game.slug.startsWith("2026-07-01-sao-tome-"));
			const [resolved] = await tx`
        SELECT game.id,game.home_id,game.away_id FROM game WHERE game.slug=${game.slug}`;
			assertEquals(resolved, {
				id: game.id,
				home_id: teams[0].id,
				away_id: teams[1].id,
			});
			for (const table of ["player", "stadium", "referee"]) {
				const [record] = await tx.unsafe(
					`INSERT INTO ${table}(name) VALUES ($1) RETURNING id,slug`,
					[`Álvaro ${marker}`],
				);
				assertEquals(record.slug, `alvaro-${marker}`);
			}
			assertEquals(
				(await tx`SELECT id FROM team WHERE slug=${`absent-${marker}`}`).length,
				0,
			);
		}
	} finally {
		await tx`ROLLBACK`;
		tx.release();
		await sql.end();
	}
});

Deno.test("concurrent colliding addresses allocate without overwriting either record", async () => {
	const sql = postgres(url, { max: 3 });
	const label = `Collision ${crypto.randomUUID()}`;
	const ids = [crypto.randomUUID(), crypto.randomUUID()];
	try {
		const rows = await Promise.all(ids.map((id) =>
			sql`
      INSERT INTO team(id,name,country) VALUES (${id},${label},'Brasil') RETURNING id,slug`
		));
		const addresses = rows.flat().map((row) => row.slug).sort();
		const base = label.toLowerCase().replaceAll(" ", "-");
		assertEquals(addresses, [base, `${base}-2`]);
		const duplicate = await assertRejects(
			() => sql`INSERT INTO team(name,slug,country) VALUES (${label},${base},'Brasil')`,
			postgres.PostgresError,
		);
		assertEquals(duplicate.code, "23505");
		const malformed = await assertRejects(
			() =>
				sql`INSERT INTO team(name,slug,country) VALUES (${label},${`${base}/invalid`},'Brasil')`,
			postgres.PostgresError,
		);
		assertEquals(malformed.code, "23514");
	} finally {
		await sql`DELETE FROM team WHERE id IN ${sql(ids)}`;
		await sql.end();
	}
});
