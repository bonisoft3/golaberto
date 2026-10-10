/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
	type BrowserContext,
	chromium,
	type Locator,
	type Page,
} from "npm:playwright@1.61.1";
import { SignJWT } from "npm:jose@6.0.11";
import { baseUrl } from "omnishell/base-url.ts";
import { query } from "./db.ts";
import { address } from "./addresses.ts";

const base = await baseUrl(Deno.args[0] ?? ".");
const timeout = 30_000;
const active = ".shell-screen:not([hidden]):not([data-served])";

async function account(handle: string, grant: boolean) {
	const id = crypto.randomUUID();
	await query(`INSERT INTO app_user(id,handle) VALUES ('${id}','${handle}');
    ${grant ? `INSERT INTO editor(app_user_id) VALUES ('${id}');` : ""}`);
	const secret = Deno.env.get("PGRST_JWT_SECRET");
	if (secret === undefined) throw new Error("PGRST_JWT_SECRET is unset");
	const token = await new SignJWT({ role: "app_user", handle, guest: false })
		.setProtectedHeader({ alg: "HS256" }).setSubject(id).setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret));
	return { token, user: { id, handle } };
}

async function persisted(sql: string, expected?: string) {
	const deadline = Date.now() + timeout;
	let actual = "";
	do {
		actual = await query(sql);
		if (expected === undefined ? actual !== "" : actual === expected) {
			return actual;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(
		`Persistence did not converge: ${sql}\nExpected ${
			expected ?? "a row"
		}; got ${JSON.stringify(actual)}`,
	);
}

async function visit(page: Page, route: string, editor = true) {
	await page.goto(`${base}/${route}`);
	await page.locator(`${active} [data-screen="${route.split("/")[0]}"]`)
		.waitFor({ timeout });
	const grant = page.locator(`${active} .content [data-live="editor"]`).first();
	if (editor) await grant.locator(".editing-workspace").waitFor({ timeout });
	else {
		await page.waitForFunction(
			(selector) => {
				const region = document.querySelector(selector);
				return region && !region.querySelector(".editing-workspace") &&
					region.textContent?.trim() ===
						"Entre com uma conta de editor para gerenciar o arquivo.";
			},
			`${active} .content [data-live="editor"]`,
			{ timeout },
		);
		assertEquals(await grant.locator("form").count(), 0);
	}
}

const form = (page: Page, name: string) =>
	page.locator(`${active} form[data-form="${name}"]`);
const submit = (target: Locator) =>
	target.locator('button[type="submit"]').click();
async function reveal(target: Locator) {
	const section = target.locator("xpath=ancestor::details[1]");
	if (
		await section.count() &&
		!await section.evaluate((element) => (element as HTMLDetailsElement).open)
	) {
		await section.locator(":scope > summary").click();
	}
}

async function choose(
	target: Locator,
	field: string,
	search: string,
	id: string,
) {
	const choice = target.locator(".editing-choice").filter({
		has: target.page().locator(`select[name="${field}"]`),
	});
	await choice.locator('input[type="search"]').fill(search);
	await choice.locator(`optgroup[data-order] option[value="${id}"]`).waitFor({
		state: "attached",
		timeout,
	});
	assert(
		(await choice.locator("optgroup[data-order] option").count()) <= 40,
		"search results exceeded the bounded picker",
	);
	await choice.locator("select").selectOption(id);
	assertEquals(await choice.locator("select").inputValue(), id);
	return choice;
}

async function fixture() {
	const prefix = `Edit ${crypto.randomUUID().slice(0, 8)}`;
	const [champ, phase, home, away, target, source, game] = Array.from({
		length: 7,
	}, () => crypto.randomUUID());
	const ed = await account(`editor-${crypto.randomUUID()}`, true);
	const reader = await account(`reader-${crypto.randomUUID()}`, false);
	await query(`BEGIN;
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES
      ('${champ}','${prefix} season','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','${prefix} phase');
    INSERT INTO team(id,name,country) VALUES ('${home}','${prefix} home','Brasil'),('${away}','${prefix} away','Brasil');
    INSERT INTO player(id,name,full_name,country) VALUES
      ('${target}','${prefix} target','Chosen biography','Brasil'),
      ('${source}','${prefix} source','Source biography','Portugal');
    INSERT INTO game(id,phase_id,day,home_id,away_id,played,home_score,away_score)
      VALUES ('${game}','${phase}','2026-01-02','${home}','${away}',true,1,0);
    INSERT INTO goal(game_id,player_id,side,minute) VALUES ('${game}','${source}','home',12);
    INSERT INTO stadium(name) SELECT '${prefix} ground '||n FROM generate_series(1,45) n;
    COMMIT;`);
	const browser = await chromium.launch({
		args: ["--ignore-certificate-errors"],
	});
	const open = async (session?: typeof ed) => {
		const context: BrowserContext = await browser.newContext({
			locale: "pt-BR",
			viewport: { width: 1366, height: 900 },
		});
		if (session) {
			await context.addInitScript(
				(value) =>
					sessionStorage.setItem("pronto-token", JSON.stringify(value)),
				session,
			);
		}
		return await context.newPage();
	};
	return {
		prefix,
		champ,
		phase,
		home,
		away,
		target,
		source,
		game,
		ed,
		reader,
		open,
		async close() {
			await browser.close();
			await query(`BEGIN;
        DELETE FROM goal WHERE game_id IN (SELECT id FROM game WHERE phase_id='${phase}');
        DELETE FROM player_game WHERE game_id IN (SELECT id FROM game WHERE phase_id='${phase}');
        DELETE FROM team_player WHERE championship_id='${champ}';
        DELETE FROM game WHERE phase_id='${phase}';
        DELETE FROM phase WHERE id='${phase}';
        DELETE FROM championship WHERE id='${champ}';
        DELETE FROM team WHERE id IN ('${home}','${away}');
        DELETE FROM player WHERE id IN ('${target}','${source}') OR created_by='${ed.user.id}';
        DELETE FROM stadium WHERE name LIKE '${prefix} %';
        DELETE FROM referee WHERE created_by='${ed.user.id}';
        DELETE FROM app_user WHERE id IN ('${ed.user.id}','${reader.user.id}');
        COMMIT;`);
		},
	};
}

Deno.test("accept-everyday-editing: editor forms persist records, bounded choices, match history and a player merge", async () => {
	const f = await fixture();
	try {
		const page = await f.open(f.ed);
		await visit(page, "novo-arbitro");
		const createReferee = form(page, "arbitro-create");
		await createReferee.locator('[name="name"]').fill(`${f.prefix} referee`);
		await createReferee.locator('[name="location"]').fill("Curitiba");
		await submit(createReferee);
		const referee = await persisted(
			`SELECT id FROM referee WHERE name='${f.prefix} referee' AND created_by='${f.ed.user.id}'`,
		);
		await visit(page, `editar-arbitro/${await address("referee", referee)}`);
		await form(page, "arbitro-update").locator('[name="location"]').fill(
			"Londrina",
		);
		await submit(form(page, "arbitro-update"));
		await persisted(
			`SELECT location FROM referee WHERE id='${referee}' AND updated_by='${f.ed.user.id}'`,
			"Londrina",
		);
		await page.reload();
		await page.waitForFunction(
			(selector) =>
				(document.querySelector(selector) as HTMLInputElement | null)?.value ===
					"Londrina",
			`${active} form[data-form="arbitro-update"] [name="location"]`,
			{ timeout },
		);

		await visit(page, "novo-jogo");
		const createGame = form(page, "jogo-create");
		const groundChoice = createGame.locator(".editing-choice").filter({
			has: page.locator('select[name="stadium_id"]'),
		});
		await groundChoice.locator('input[type="search"]').fill(
			`${f.prefix} GROUND`.toUpperCase(),
		);
		await page.waitForFunction(
			({ selector, prefix }) => {
				const options = [...document.querySelectorAll(selector)];
				return options.length === 40 &&
					options.every((option) => option.textContent?.startsWith(prefix));
			},
			{
				selector:
					`${active} form[data-form="jogo-create"] select[name="stadium_id"] optgroup[data-order] option`,
				prefix: `${f.prefix} ground`,
			},
			{ timeout },
		);
		const inline = form(page, "estadio-inline-create");
		await reveal(inline);
		await inline.locator('[name="name"]').fill(`${f.prefix} new ground`);
		await submit(inline);
		const stadium = await persisted(
			`SELECT id FROM stadium WHERE name='${f.prefix} new ground' AND created_by='${f.ed.user.id}'`,
		);
		await choose(createGame, "stadium_id", `${f.prefix} new ground`, stadium);
		await choose(createGame, "referee_id", `${f.prefix} referee`, referee);
		await choose(createGame, "phase_id", `${f.prefix} season`, f.phase);
		const homeChoice = await choose(
			createGame,
			"home_id",
			`${f.prefix} home`,
			f.home,
		);
		await homeChoice.locator('input[type="search"]').fill(`${f.prefix} away`);
		await homeChoice.locator(`optgroup[data-order] option[value="${f.away}"]`)
			.waitFor({ state: "attached", timeout });
		assertEquals(
			await homeChoice.locator("select").inputValue(),
			f.home,
			"changing a picker search must retain its selected record",
		);
		await choose(createGame, "away_id", `${f.prefix} away`, f.away);
		await createGame.locator('[name="day"]').fill("2026-02-02");
		await createGame.locator('[name="home_score"]').fill("0");
		await createGame.locator('[name="away_score"]').fill("0");
		await createGame.locator('[name="attendance"]').fill("0");
		await submit(createGame);
		const game = await persisted(
			`SELECT id FROM game WHERE phase_id='${f.phase}' AND day='2026-02-02'
      AND played AND home_score=0 AND away_score=0 AND attendance=0
      AND stadium_id='${stadium}' AND referee_id='${referee}' AND created_by='${f.ed.user.id}'`,
		);
		const gameSlug = await address("game", game);
		const playerSlug = await address("player", f.target);

		await page.waitForFunction(
			(selector) => {
				const current = document.querySelector(selector);
				return current &&
					[...current.querySelectorAll(
						'.editing-choice input[type="search"], .editing-choice select',
					)]
						.every((control) => (control as HTMLInputElement).value === "") &&
					!(current.querySelector('[name="played"]') as HTMLInputElement)
						.checked;
			},
			`${active} form[data-form="jogo-create"]`,
			{ timeout },
		);
		await choose(createGame, "phase_id", `${f.prefix} season`, f.phase);
		await choose(createGame, "home_id", `${f.prefix} home`, f.home);
		await choose(createGame, "away_id", `${f.prefix} away`, f.away);
		await createGame.locator('[name="day"]').fill("2026-02-04");
		await createGame.locator('[name="home_score"]').fill("1");
		await page.waitForFunction(
			(selector) =>
				!(document.querySelector(selector) as HTMLInputElement).checked,
			`${active} form[data-form="jogo-create"] [name="played"]`,
			{ timeout },
		);
		await createGame.locator('[name="home_score"]').fill("");
		await createGame.locator('[name="kickoff"]').fill("2026-02-04T20:30");
		await submit(createGame);
		await persisted(
			`SELECT count(*) FROM game WHERE phase_id='${f.phase}'
      AND day='2026-02-04' AND NOT played AND home_score IS NULL AND away_score IS NULL
      AND kickoff='2026-02-04T20:30:00Z' AND created_by='${f.ed.user.id}'`,
			"1",
		);

		await visit(page, `inscricoes-jogador/${playerSlug}`);
		const register = form(page, "inscricoes-jogador-create");
		await choose(register, "championship_id", `${f.prefix} season`, f.champ);
		await choose(register, "team_id", `${f.prefix} home`, f.home);
		await submit(register);
		await persisted(
			`SELECT count(*) FROM team_player WHERE player_id='${f.target}' AND team_id='${f.home}' AND championship_id='${f.champ}'`,
			"1",
		);

		await visit(page, `escalacao-jogo/${gameSlug}`);
		const lineup = form(page, "escalacao-jogo-create");
		await choose(lineup, "player_id", `${f.prefix} target`, f.target);
		await lineup.locator('[name="on_minute"]').fill("0");
		await lineup.locator('[name="off_minute"]').fill("90");
		await submit(lineup);
		await persisted(
			`SELECT count(*) FROM player_game WHERE game_id='${game}' AND player_id='${f.target}' AND side='home' AND on_minute=0 AND off_minute=90`,
			"1",
		);
		const updateLineup = form(page, "escalacao-jogo-update");
		await updateLineup.waitFor({ state: "attached", timeout });
		await reveal(updateLineup);
		await updateLineup.locator('[name="yellow"]').check();
		await submit(updateLineup);
		await persisted(
			`SELECT yellow::text FROM player_game WHERE game_id='${game}' AND player_id='${f.target}'`,
			"true",
		);

		await visit(page, `gols-jogo/${gameSlug}`);
		const goal = form(page, "gols-jogo-create");
		await choose(goal, "player_id", `${f.prefix} target`, f.target);
		await goal.locator('[name="minute"]').fill("37");
		await goal.locator('[name="penalty"]').check();
		await submit(goal);
		await persisted(
			`SELECT count(*) FROM goal WHERE game_id='${game}' AND player_id='${f.target}' AND minute=37 AND penalty`,
			"1",
		);

		await query(
			`UPDATE game SET kickoff='2026-02-02T20:30:05.125000Z' WHERE id='${game}'`,
		);
		await visit(page, `editar-jogo/${gameSlug}`);
		const editGame = form(page, "jogo-update");
		assertEquals(
			await editGame.locator('[name="kickoff"]').inputValue(),
			"2026-02-02T20:30:05.125",
		);
		await editGame.locator('[name="day"]').fill("2026-02-03");
		await editGame.locator('[name="home_score"]').fill("1");
		await submit(editGame);
		await persisted(
			`SELECT g.home_score||':'||a.day FROM game g JOIN player_game a ON a.game_id=g.id WHERE g.id='${game}'`,
			"1:2026-02-03",
		);
		assertEquals(
			await query(
				`SELECT (kickoff='2026-02-02T20:30:05.125000Z')::text FROM game WHERE id='${game}'`,
			),
			"true",
		);

		await visit(page, `editar-jogador/${playerSlug}`);
		const merge = form(page, "jogador-merge");
		await reveal(merge);
		await choose(merge, "source_player_id", `${f.prefix} source`, f.source);
		await merge.locator('input[type="checkbox"]').check();
		await submit(merge);
		await persisted(
			`SELECT count(*) FROM player_merge WHERE target_player_id='${f.target}' AND source_player_id='${f.source}' AND app_user_id='${f.ed.user.id}'`,
			"1",
		);
		assertEquals(
			await query(`SELECT count(*) FROM player WHERE id='${f.source}'`),
			"0",
		);
		assertEquals(
			await query(`SELECT full_name FROM player WHERE id='${f.target}'`),
			"Chosen biography",
		);
		assertEquals(
			await query(`SELECT player_id FROM goal WHERE game_id='${f.game}'`),
			f.target,
		);

		await visit(page, `inscricoes-jogador/${playerSlug}`);
		const registration = form(page, "inscricoes-jogador-update");
		await registration.waitFor({ state: "attached", timeout });
		await reveal(registration);
		const removeRegistration = form(page, "inscricoes-jogador-delete");
		await reveal(removeRegistration);
		await removeRegistration.locator('input[type="checkbox"]').check();
		await submit(removeRegistration);
		await persisted(
			`SELECT count(*) FROM team_player WHERE player_id='${f.target}' AND championship_id='${f.champ}'`,
			"0",
		);
		assertEquals(
			await query(
				`SELECT count(*) FROM player_game WHERE game_id='${game}' AND player_id='${f.target}'`,
			),
			"0",
		);
		assertEquals(
			await query(
				`SELECT count(*) FROM goal WHERE game_id='${game}' AND player_id='${f.target}'`,
			),
			"0",
		);
	} finally {
		await f.close();
	}
});

Deno.test("accept-editing-grant: guests and readers have no editing forms; dependency refusal preserves the archive", async () => {
	const f = await fixture();
	try {
		const sourceSlug = await address("player", f.source);
		for (const session of [undefined, f.reader]) {
			const page = await f.open(session);
			for (
				const route of [
					"gerenciar",
					"novo-jogador",
					`editar-jogador/${sourceSlug}`,
					`gols-jogo/${await address("game", f.game)}`,
				]
			) {
				await visit(page, route, false);
				assertEquals(
					await page.locator(`${active} .editing-workspace`).count(),
					0,
				);
			}
		}
		const page = await f.open(f.ed);
		await visit(page, `editar-jogador/${sourceSlug}`);
		const remove = form(page, "jogador-delete");
		await reveal(remove);
		await remove.locator('input[type="checkbox"]').check();
		await submit(remove);
		await remove.locator(".store-error:not([hidden])").waitFor({ timeout });
		assertEquals(
			await query(`SELECT count(*) FROM player WHERE id='${f.source}'`),
			"1",
		);
		assertEquals(
			await query(
				`SELECT count(*) FROM goal WHERE game_id='${f.game}' AND player_id='${f.source}'`,
			),
			"1",
		);
		assertEquals(
			await form(page, "jogador-update").locator('[name="name"]').inputValue(),
			`${f.prefix} source`,
		);

		await visit(page, "novo-jogador");
		const create = form(page, "jogador-create");
		await create.locator('[name="name"]').fill(`${f.prefix} invalid player`);
		await create.locator('[name="height"]').fill("99");
		await submit(create);
		assertEquals(
			await create.locator('[name="height"]').evaluate((input) =>
				(input as HTMLInputElement).validity.rangeUnderflow
			),
			true,
		);
		assertEquals(
			await create.locator('[name="name"]').inputValue(),
			`${f.prefix} invalid player`,
		);
		assertEquals(
			await query(
				`SELECT count(*) FROM player WHERE name='${f.prefix} invalid player'`,
			),
			"0",
		);
	} finally {
		await f.close();
	}
});
