/// <reference lib="dom" />
import { Buffer } from "node:buffer";
import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { chromium, type Page } from "npm:playwright@1.61.1";
import { SignJWT } from "npm:jose@6.0.11";
import { baseUrl } from "omnishell/base-url.ts";
import { query } from "./db.ts";

const base = await baseUrl(Deno.args[0] ?? ".");
const active = ".shell-screen:not([hidden]):not([data-served])";
const timeout = 30_000;
const form = (page: Page, name: string) =>
	page.locator(`${active} form[data-form="${name}"]`);
async function persisted(sql: string, expected: string) {
	const deadline = Date.now() + timeout;
	let actual;
	do {
		actual = await query(sql);
		if (actual === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	assertEquals(actual, expected, sql);
}
async function visit(page: Page, route: string, screen = route.split("/")[0]) {
	await page.goto(`${base}/${route}`);
	await page.locator(`${active} [data-screen="${screen}"]`).waitFor({
		timeout,
	});
}
const profileEligibility = (page: Page) =>
	page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname.endsWith("/community_access") &&
			new URL(response.url()).searchParams.get("kind") === "eq.profile" &&
			response.request().method() === "GET",
		{ timeout },
	);

async function fixture() {
	const [owner, other, championship, phase, home, away, game] = Array.from({
		length: 7,
	}, () => crypto.randomUUID());
	const prefix = `Community-${owner.slice(0, 8)}`;
	await query(
		`INSERT INTO app_user(id,handle) VALUES ('${owner}','${prefix}-owner'),('${other}','${prefix}-other');
    INSERT INTO editor(app_user_id) VALUES ('${owner}');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${championship}','${prefix}','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${championship}','Community phase');
    INSERT INTO team(id,name,country) VALUES ('${home}','${prefix} Home','Brasil'),('${away}','${prefix} Away','Brasil');
    INSERT INTO game(id,phase_id,home_id,away_id,day) VALUES ('${game}','${phase}','${home}','${away}','2026-06-01');`,
	);
	const secret = Deno.env.get("PGRST_JWT_SECRET");
	if (!secret) throw new Error("PGRST_JWT_SECRET is unset");
	async function session(id: string, guest = false) {
		const handle = `${prefix}-${id === owner ? "owner" : "other"}`;
		const token = await new SignJWT({ role: "app_user", handle, guest })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject(id).setExpirationTime("1h").sign(
				new TextEncoder().encode(secret),
			);
		return { token, user: { id, handle, guest } };
	}
	const browser = await chromium.launch({
		headless: true,
		args: ["--no-sandbox", "--ignore-certificate-errors"],
	});
	async function open(id?: string, guest = false) {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 900 },
			// A Brazilian reader, as acceptance.ts's: the assertions read pt-BR text.
			locale: "pt-BR",
			// page.request does not inherit the launch flag.
			ignoreHTTPSErrors: true,
		});
		if (id) {
			await context.addInitScript(
				(value) =>
					sessionStorage.setItem("pronto-token", JSON.stringify(value)),
				await session(id, guest),
			);
		}
		return await context.newPage();
	}
	return {
		owner,
		other,
		home,
		game,
		prefix,
		open,
		session,
		championshipSlug: await query(
			`SELECT slug FROM championship WHERE id='${championship}'`,
		),
		gameSlug: await query(`SELECT slug FROM game WHERE id='${game}'`),
		teamSlug: await query(`SELECT slug FROM team WHERE id='${home}'`),
		async close() {
			await browser.close();
			await query(
				`DELETE FROM championship WHERE id='${championship}'; DELETE FROM team WHERE id IN ('${home}','${away}'); DELETE FROM app_user WHERE id IN ('${owner}','${other}');`,
			);
		},
	};
}

Deno.test("accept-community-profile", async () => {
	const f = await fixture();
	try {
		const page = await f.open(f.other);
		await visit(page, `usuario/${f.other}`);
		await page.locator(`${active} .community-edit > summary`).click();
		const create = form(page, "community-biography-create");
		await create.locator('[name="display_name"]').fill(
			`${f.prefix} Public name`,
		);
		await create.locator('[name="location"]').fill("Porto Alegre");
		await create.locator('[name="about_me"]').fill(
			"<img src=x onerror=alert(1)>\nMy football archive.",
		);
		await create.locator('button[type="submit"]').click();
		await persisted(
			`SELECT display_name FROM user_biography WHERE app_user_id='${f.other}'`,
			`${f.prefix} Public name`,
		);
		await form(page, "community-biography-update").waitFor({
			state: "attached",
			timeout,
		});
		await page.locator(`${active} .community-edit > summary`).click();
		const update = form(page, "community-biography-update");
		assertEquals(
			await update.locator('[name="location"]').inputValue(),
			"Porto Alegre",
		);
		await update.locator('[name="display_name"]').fill(`${f.prefix} Revised`);
		await update.locator('button[type="submit"]').click();
		await persisted(
			`SELECT display_name FROM user_biography WHERE app_user_id='${f.other}'`,
			`${f.prefix} Revised`,
		);
		await page.locator(`${active} h1`).filter({
			hasText: `${f.prefix} Revised`,
		}).waitFor({ timeout });
		const guest = await f.open();
		const guestEligibility = profileEligibility(guest);
		await visit(guest, `usuario/${f.other}`);
		assertEquals(await (await guestEligibility).json(), []);
		await guest.locator(`${active} h1`).filter({
			hasText: `${f.prefix} Revised`,
		}).waitFor({ timeout });
		assertEquals(
			await guest.locator(`${active} .community-about img`).count(),
			0,
		);
		assert(
			(await guest.locator(`${active} .community-about`).innerText()).includes(
				"<img src=x",
			),
		);
		assertEquals(await guest.locator(`${active} .community-edit`).count(), 0);
		await visit(guest, "usuarios");
		await guest.locator(`${active} #community-users-q`).fill(
			`${f.prefix} Revised`,
		);
		// The match may already sit in the unfiltered first page, so wait for the
		// filtered page itself before counting it.
		await guest.waitForFunction(
			(selector) => document.querySelectorAll(selector).length === 1,
			`${active} .community-list > li`,
			{ timeout },
		);
		assert(
			(await guest.locator(`${active} .community-list > li`).innerText())
				.includes(`${f.prefix} Revised`),
		);
		await visit(guest, `usuario/${crypto.randomUUID()}`);
		await guest.locator(`${active} [data-live="user_directory"]`).filter({
			hasText: "Perfil não encontrado.",
		}).waitFor({ timeout });
	} finally {
		await f.close();
	}
});

Deno.test("accept-community-ownership", async () => {
	const f = await fixture();
	try {
		const [owned, foreign, teamOwned] = Array.from(
			{ length: 3 },
			() => crypto.randomUUID(),
		);
		await query(
			`INSERT INTO comment(id,game_id,app_user_id,body) VALUES ('${owned}','${f.game}','${f.owner}','Own comment'),('${foreign}','${f.game}','${f.other}','Other comment');
      INSERT INTO team_comment(id,team_id,app_user_id,body) VALUES ('${teamOwned}','${f.home}','${f.owner}','Own team comment');`,
		);
		const page = await f.open(f.owner);
		await visit(page, `jogo/${f.gameSlug}`);
		const own = page.locator(`${active} .comment-list > li`).filter({
			hasText: "Own comment",
		});
		const others = page.locator(`${active} .comment-list > li`).filter({
			hasText: "Other comment",
		});
		await own.locator(".community-comment-delete > summary").click();
		assertEquals(await others.locator("form").count(), 0);
		await own.locator('input[type="checkbox"]').check();
		await own.locator('button[type="submit"]').click();
		await persisted(`SELECT count(*) FROM comment WHERE id='${owned}'`, "0");
		await persisted(`SELECT count(*) FROM comment WHERE id='${foreign}'`, "1");
		await visit(page, `equipe/${f.teamSlug}`);
		await page.locator(`${active} .community-comment-delete > summary`).click();
		await form(page, "community-team_comment-delete").locator(
			'input[type="checkbox"]',
		).check();
		await form(page, "community-team_comment-delete").locator(
			'button[type="submit"]',
		).click();
		await persisted(
			`SELECT count(*) FROM team_comment WHERE id='${teamOwned}'`,
			"0",
		);
		const context = await page.context().browser()!.newContext({
			locale: "pt-BR",
			ignoreHTTPSErrors: true,
		});
		const switching = await context.newPage();
		await switching.goto(base);
		await switching.evaluate(
			(value) => sessionStorage.setItem("pronto-token", JSON.stringify(value)),
			await f.session(f.owner),
		);
		await visit(switching, `usuario/${f.owner}`);
		await switching.locator(`${active} .community-edit`).waitFor({ timeout });
		await switching.evaluate(
			(value) => sessionStorage.setItem("pronto-token", JSON.stringify(value)),
			await f.session(f.other),
		);
		const switchedEligibility = profileEligibility(switching);
		await switching.reload();
		assertEquals(await (await switchedEligibility).json(), []);
		await switching.locator(`${active} h1`).filter({
			hasText: `${f.prefix}-owner`,
		}).waitFor({ timeout });
		assertEquals(
			await switching.locator(`${active} .community-edit`).count(),
			0,
		);
		await switching.evaluate(
			(value) => sessionStorage.setItem("pronto-token", JSON.stringify(value)),
			await f.session(f.owner, true),
		);
		const demotedEligibility = profileEligibility(switching);
		await switching.reload();
		assertEquals(await (await demotedEligibility).json(), []);
		await switching.locator(`${active} h1`).filter({
			hasText: `${f.prefix}-owner`,
		}).waitFor({ timeout });
		assertEquals(
			await switching.locator(`${active} .community-edit`).count(),
			0,
		);
		await context.close();
	} finally {
		await f.close();
	}
});

Deno.test("accept-community-history", async () => {
	const f = await fixture();
	try {
		await query(
			`BEGIN; SET LOCAL app.scopes='public:,user:${f.owner}'; SET LOCAL request.jwt.claims='{"sub":"${f.owner}","guest":false}'; SET LOCAL ROLE app_user;
      ${
				Array.from({ length: 41 }, (_, n) =>
					`UPDATE game SET attendance=${n} WHERE id='${f.game}';`).join("\n")
			} COMMIT;`,
		);
		const page = await f.open();
		await visit(page, `historico-jogo/${f.gameSlug}`);
		await page.locator(`${active} .community-history > li`).nth(39).waitFor({
			timeout,
		});
		assertEquals(
			await page.locator(`${active} .community-history > li`).count(),
			40,
		);
		const first = await page.locator(`${active} .community-history > li`)
			.first().getAttribute("data-id");
		assert(
			(await page.locator(`${active} .community-history`).innerText()).includes(
				`${f.prefix}-owner`,
			),
		);
		assert(
			(await page.locator(`${active} .community-diff`).first().innerText())
				.includes("Público"),
		);
		await page.locator(`${active} #community-game-history-next`).click();
		await page.waitForFunction(
			(selector) => document.querySelectorAll(selector).length === 1,
			`${active} .community-history > li`,
			{ timeout },
		);
		assert(
			await page.locator(`${active} .community-history > li`).first()
				.getAttribute("data-id") !== first,
		);
		await page.locator(`${active} #community-game-history-previous`).click();
		await page.locator(`${active} .community-history > li`).nth(39).waitFor({
			timeout,
		});
		assertEquals(
			await page.locator(`${active} .community-history > li`).first()
				.getAttribute("data-id"),
			first,
		);
		await visit(page, `usuario/${f.owner}`);
		await page.locator(`${active} .community-history > li`).nth(39).waitFor({
			timeout,
		});
		assert(
			(await page.locator(`${active} .community-counts`).innerText()).includes(
				"41",
			),
		);
		const replacement = crypto.randomUUID();
		await query(`WITH previous AS (
      DELETE FROM game WHERE id='${f.game}' RETURNING *
    ) INSERT INTO game(id,phase_id,home_id,away_id,day)
      SELECT '${replacement}',phase_id,home_id,away_id,day FROM previous;
      UPDATE game SET attendance=999 WHERE id='${replacement}';`);
		assertEquals(
			await query(`SELECT slug FROM game WHERE id='${replacement}'`),
			f.gameSlug,
		);
		const replacementChange = await query(
			`SELECT id FROM game_change WHERE game_id='${replacement}'`,
		);
		await visit(page, `historico-jogo/${f.gameSlug}`, "historico-jogo");
		await page.locator(
			`${active} .community-history > li[data-id="${replacementChange}"]`,
		).waitFor({ timeout });
		assertEquals(
			await page.locator(`${active} .community-history > li`).count(),
			1,
		);
	} finally {
		await f.close();
	}
});

Deno.test("accept-community-media", async () => {
	const f = await fixture();
	const image = {
		name: "portrait.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAQCAYAAAArij59AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwHx9mGFXwfwSFAwAJef8BYye1TAAAAABJRU5ErkJggg==",
			"base64",
		),
	};
	async function publicImage(page: Page, key: string) {
		const img = page.locator(
			`${active} img[src="/blobs/mecha-objects/${key}/medium.png"]`,
		);
		await img.waitFor({ timeout });
		await img.evaluate((node: HTMLImageElement) => node.decode());
		assertEquals(
			await img.evaluate((
				node: HTMLImageElement,
			) => [node.naturalWidth, node.naturalHeight]),
			[100, 100],
		);
	}
	try {
		const owner = await f.open(f.other);
		await visit(owner, `usuario/${f.other}`);
		const create = form(owner, "media-avatar-create");
		await create.locator('[name="avatar_key"]').setInputFiles(image);
		await create.locator('button[type="submit"]').click();
		await persisted(
			`SELECT count(*) FROM user_avatar WHERE id='${f.other}'`,
			"1",
		);
		const first = await query(
			`SELECT avatar_key FROM user_avatar WHERE id='${f.other}'`,
		);
		await form(owner, "media-avatar-update").waitFor({ timeout });
		await publicImage(owner, first);
		const update = form(owner, "media-avatar-update");
		await update.locator('[name="avatar_key"]').setInputFiles(image);
		await update.locator('button[type="submit"]').click();
		await persisted(
			`SELECT count(*) FROM user_avatar WHERE id='${f.other}' AND avatar_key<>'${first}'`,
			"1",
		);
		const replacement = await query(
			`SELECT avatar_key FROM user_avatar WHERE id='${f.other}'`,
		);
		await publicImage(owner, replacement);
		assertEquals(
			(await owner.request.get(
				`${base}/blobs/mecha-objects/${first}/medium.png`,
			)).status(),
			404,
		);
		for (const viewer of [await f.open(), await f.open(f.owner)]) {
			const eligibility = profileEligibility(viewer);
			await visit(viewer, `usuario/${f.other}`);
			assertEquals(await (await eligibility).json(), []);
			await publicImage(viewer, replacement);
			assertEquals(
				await viewer.locator(`${active} form[data-entity="user_avatar"]`)
					.count(),
				0,
			);
		}
		await form(owner, "media-avatar-delete").locator('button[type="submit"]')
			.click();
		await persisted(
			`SELECT count(*) FROM user_avatar WHERE id='${f.other}'`,
			"0",
		);
		await form(owner, "media-avatar-create").waitFor({ timeout });
		const editor = await f.open(f.owner);
		await visit(editor, `editar-equipe/${f.teamSlug}`);
		const team = form(editor, "equipe-update");
		await team.locator('[name="logo_key"]').setInputFiles(image);
		await team.locator('button[type="submit"]').click();
		await persisted(
			`SELECT count(*) FROM team WHERE id='${f.home}' AND logo_key IS NOT NULL`,
			"1",
		);
		const logo = await query(`SELECT logo_key FROM team WHERE id='${f.home}'`);
		const guest = await f.open();
		await visit(guest, `equipe/${f.teamSlug}`);
		await publicImage(guest, logo);
		await visit(guest, "equipes");
		await guest.locator(`${active} input[type="search"]`).fill(
			`${f.prefix} Home`,
		);
		await guest.locator(
			`${active} img[src="/blobs/mecha-objects/${logo}/thumb.png"]`,
		).waitFor({ timeout });
		await visit(
			guest,
			`campeonato/${f.championshipSlug}/arquivo`,
			"arquivo-campeonato",
		);
		await guest.locator(`${active} select[id$="-played"]`).selectOption(
			"false",
		);
		await guest.locator(
			`${active} img[src="/blobs/mecha-objects/${logo}/thumb.png"]`,
		).waitFor({ timeout });
		await form(editor, "media-logo-clear").locator('button[type="submit"]')
			.click();
		await persisted(
			`SELECT count(*) FROM team WHERE id='${f.home}' AND logo_key IS NULL`,
			"1",
		);
		assertEquals(
			(await guest.request.get(
				`${base}/blobs/mecha-objects/${logo}/medium.png`,
			)).status(),
			404,
		);
	} finally {
		await f.close();
	}
});
