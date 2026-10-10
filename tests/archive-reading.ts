/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { chromium, type Page } from "npm:playwright@1.61.1";
import { baseUrl } from "omnishell/base-url.ts";
import { query } from "./db.ts";

const active = ".shell-screen:not([hidden]):not([data-served])";
const base = await baseUrl(Deno.args[0] ?? ".");
const id = (n: number) =>
	`fa000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const championship = "archive-browser-cup";
const slug = (n: number) => `archive-browser-match-${n}`;
const setup = `
  BEGIN;
  INSERT INTO category(id,name) VALUES('${id(1)}','Archive browser category');
  INSERT INTO championship(id,name,region_name,begins,ends,category_id,slug) VALUES
    ('${id(2)}','Archive browser cup','Brasil','2026-01-01','2027-12-31','${
	id(1)
}','${championship}'),
    ('${
	id(3)
}','Archive browser professional','Brasil','2026-01-01','2027-12-31',NULL,'archive-browser-professional');
  INSERT INTO phase(id,championship_id,name) VALUES
    ('${id(4)}','${id(2)}','Archive browser phase'),('${id(5)}','${
	id(3)
}','Professional phase');
  INSERT INTO team(id,name,country,slug) VALUES
    ('${id(6)}','Archive browser home','Brazil','archive-browser-home'),
    ('${id(7)}','Archive browser away','Brazil','archive-browser-away');
  INSERT INTO game(id,phase_id,round,day,home_id,away_id,played,home_score,away_score,home_aet,away_aet,home_pen,away_pen,attendance,slug) VALUES
    ('${id(10)}','${id(4)}',1,'2026-12-28','${id(6)}','${
	id(7)
}',true,1,1,1,0,NULL,NULL,0,'${slug(10)}'),
    ('${id(11)}','${id(4)}',2,'2026-12-29','${id(6)}','${
	id(7)
}',true,1,1,0,0,5,4,100,'${slug(11)}'),
    ('${id(12)}','${id(4)}',2,'2026-12-30','${id(6)}','${
	id(7)
}',true,0,0,NULL,NULL,NULL,NULL,NULL,'${slug(12)}'),
    ('${id(13)}','${id(4)}',3,'2027-01-01','${id(6)}','${
	id(7)
}',false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'${slug(13)}'),
    ('${id(14)}','${id(4)}',4,'2027-01-02','${id(6)}','${
	id(7)
}',false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'${slug(14)}'),
    ('${id(15)}','${id(5)}',3,'2027-01-01','${id(6)}','${
	id(7)
}',false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'${slug(15)}');
  COMMIT;
`;
const cleanup = `BEGIN; DELETE FROM championship WHERE id IN ('${id(2)}','${
	id(3)
}');
  DELETE FROM category WHERE id='${id(1)}'; DELETE FROM team WHERE id IN ('${
	id(6)
}','${id(7)}'); COMMIT;`;
const visit = async (page: Page, path: string, screen: string) => {
	await page.goto(`${base}${path}?lang=pt-BR`);
	await page.waitForSelector(
		`${active} .screen[data-screen='${screen}'][data-state='populated']`,
		{ timeout: 30_000 },
	);
};
const rows = (page: Page) => page.locator(`${active} a.game-row`);
const expectMatches = async (page: Page, matches: number[]) => {
	await page.waitForFunction(
		({ active, wanted }) => {
			const actual = Array.from(
				document.querySelectorAll(`${active} a.game-row`),
			).map((row) => row.getAttribute("data-param-slug"));
			return JSON.stringify(actual) === JSON.stringify(wanted);
		},
		{ active, wanted: matches.map(slug) },
		{ timeout: 30_000 },
	);
};
const commitField = async (page: Page, selector: string, value: string) => {
	await page.locator(`${active} ${selector}`).fill(value);
	await page.locator(`${active} ${selector}`).press("Tab");
};

Deno.test({
	name:
		"archive reading filters ISO weeks, rounds and categories and preserves final scores and known zero attendance",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		await query(setup);
		try {
			const browser = await chromium.launch({
				executablePath: Deno.env.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
				args: ["--ignore-certificate-errors"],
			});
			try {
				const context = await browser.newContext({
					ignoreHTTPSErrors: true,
					locale: "pt-BR",
					viewport: { width: 1366, height: 900 },
				});
				const page = await context.newPage();
				const failures: string[] = [];
				page.on("pageerror", (error) => failures.push(error.message));
				page.on("response", (response) => {
					if (
						new URL(response.url()).pathname.startsWith("/crud/") &&
						response.status() >= 400
					) failures.push(`${response.status()} ${response.url()}`);
				});
				await visit(
					page,
					`/campeonato/${championship}/arquivo`,
					"arquivo-campeonato",
				);
				await expectMatches(page, [12, 11, 10]);
				const extra = rows(page).filter({
					has: page.locator(
						`[data-text='{home_score}|{home_aet}|{msg.game_aet}']`,
					),
				}).filter({ hasText: "28/12/2026" });
				assertEquals(await extra.locator(".score > b").allTextContents(), [
					"2",
					"1",
				]);
				assert(
					(await rows(page).filter({ hasText: "29/12/2026" }).locator(
						".score-decider",
					).innerText()).includes("5–4"),
				);
				await commitField(
					page,
					"#championship-archive-games-week",
					"2027-01-01",
				);
				await expectMatches(page, [12, 11, 10]);
				await commitField(page, "#championship-archive-games-round", "2");
				await expectMatches(page, [12, 11]);
				await commitField(page, "#championship-archive-games-round", "");
				await page.locator(`${active} #championship-archive-games-played`)
					.selectOption("false");
				await expectMatches(page, [13, 14]);
				await page.locator(`${active} #championship-archive-games-phase`)
					.selectOption(id(4));
				await expectMatches(page, [13, 14]);
				await commitField(
					page,
					"#championship-archive-games-week",
					"2027-01-04",
				);
				await expectMatches(page, []);
				await page.locator(`${active} #championship-archive-games-all-weeks`)
					.click();
				await expectMatches(page, [13, 14]);

				await visit(page, "/arquivo", "arquivo");
				await page.locator(`${active} #archive-games-played`).selectOption(
					"false",
				);
				await commitField(page, "#archive-games-week", "2027-01-01");
				await page.locator(`${active} #archive-games-category`).selectOption(
					id(1),
				);
				await expectMatches(page, [13, 14]);
				await page.locator(`${active} #archive-games-category`).selectOption(
					"professional",
				);
				await page.waitForFunction(({ active, wanted, forbidden }) => {
					const slugs = Array.from(
						document.querySelectorAll(`${active} a.game-row`),
					).map((row) => row.getAttribute("data-param-slug"));
					return slugs.includes(wanted) &&
						!slugs.some((value) => forbidden.includes(value ?? ""));
				}, { active, wanted: slug(15), forbidden: [slug(13), slug(14)] });

				await visit(page, `/campeonato/${championship}/publico`, "publico");
				await expectMatches(page, [11, 10]);
				const team = page.locator(`${active} .standings tbody tr`).filter({
					hasText: "Archive browser home",
				});
				await page.waitForFunction(
					(active) =>
						document.querySelector(`${active} [data-text='{attendance_count}']`)
							?.textContent?.trim() === "2",
					active,
				);
				assertEquals(
					await team.locator("[data-text='{attendance_count}']").innerText(),
					"2",
				);
				assertEquals(
					await team.locator("[data-text='{average}']").innerText(),
					"50",
				);
				assertEquals(
					await team.locator("[data-text='{minimum}']").innerText(),
					"0",
				);
				assertEquals(
					await team.locator("[data-text='{maximum}']").innerText(),
					"100",
				);
				assertEquals(
					await team.locator("[data-text='{total}']").innerText(),
					"100",
				);
				assertEquals(failures, []);
				await context.close();
			} finally {
				await browser.close();
			}
		} finally {
			await query(cleanup);
		}
	},
});
