/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { chromium, type Page } from "npm:playwright@1.61.1";
import { baseUrl } from "omnishell/base-url.ts";
import { address, fixturePath } from "./addresses.ts";
import { query } from "./db.ts";

const VIVEROS = "0c000000-0000-4000-8000-000000000126";
const ATHLETICO = "07000000-0000-4000-8000-000000000003";
const BRASILEIRO = "02000000-0000-4000-8000-000000000001";
const active = ".shell-screen:not([hidden]):not([data-served])";
const base = await baseUrl(Deno.args[0] ?? ".");
const number = (text: string) =>
	Number(text.replaceAll(".", "").replace(",", ".").trim());
const quoted = (text: string | null) =>
	text === null ? "NULL" : `'${text.replaceAll("'", "''")}'`;

const visit = async (page: Page, path: string, screen: string) => {
	await page.goto(`${base}${path}`);
	await page.waitForSelector(
		`${active} .screen[data-screen='${screen}'][data-state='populated']`,
		{ timeout: 30_000 },
	);
};

const totals = async (predicate: string) =>
	JSON.parse(
		await query(`
  SELECT json_build_object('rows',count(*),'minutes',sum(minutes),'goals',sum(goals),
    'bench',sum(bench),'own_goals',sum(own_goals)) FROM player_stat
  WHERE championship_id='${BRASILEIRO}' ${predicate}`),
	) as {
		rows: number;
		minutes: number;
		goals: number;
		bench: number;
		own_goals: number;
	};

const awaitTotals = async (
	page: Page,
	expected: Awaited<ReturnType<typeof totals>>,
	minimumMinutes = 0,
) => {
	await page.waitForFunction(
		({ active, expected, minimumMinutes }) => {
			const root = document.querySelector(`${active} .season-table tfoot`);
			const read = (key: string) =>
				Number(
					root?.querySelector(`[data-text='{${key}}']`)?.textContent
						?.replaceAll(".", "").replace(",", ".").trim(),
				);
			// Totals and the visible page settle through separate requests.
			const rows = document.querySelectorAll(
				`${active} .season-table tbody tr`,
			);
			const minutes = document.querySelectorAll(
				`${active} .season-table tbody [data-text='{minutes}']`,
			);
			return rows.length === Math.min(40, expected.rows) &&
				Array.from(minutes).every((cell) =>
					Number(
						cell.textContent?.replaceAll(".", "").replace(",", ".").trim(),
					) >= minimumMinutes
				) &&
				read("minutes") === expected.minutes &&
				read("goals") === expected.goals &&
				read("bench") === expected.bench &&
				read("own_goals") === expected.own_goals;
		},
		{ active, expected, minimumMinutes },
		{ timeout: 30_000 },
	);
};

const awaitCsv = async (page: Page, rows: number) => {
	await page.waitForFunction(({ active, rows }) => {
		const link = document.querySelector(`${active} .player-csv-export`);
		const href = link?.getAttribute("href");
		if (!href?.startsWith("data:text/csv;charset=utf-8,")) return false;
		const text = decodeURIComponent(
			href.slice("data:text/csv;charset=utf-8,".length),
		);
		return text.startsWith("\uFEFF") && text.split("\r\n").length === rows + 2;
	}, { active, rows });
	const link = page.locator(`${active} .player-csv-export`);
	assertEquals(await link.innerText(), "Exportar página exibida (CSV)");
	assertEquals(await link.getAttribute("download"), "jogadores-pagina.csv");
	return link;
};

Deno.test({
	name:
		"player reading searches the directory and keeps biography, scoped statistics and filtered totals accurate",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const scheduled = {
			player: crypto.randomUUID(),
			team: crypto.randomUUID(),
			opponent: crypto.randomUUID(),
			championship: crypto.randomUUID(),
			phase: crypto.randomUUID(),
			game: crypto.randomUUID(),
			appearance: crypto.randomUUID(),
			playerSlug: `scheduled-player-${crypto.randomUUID()}`,
			teamSlug: `scheduled-team-${crypto.randomUUID()}`,
			opponentSlug: `scheduled-opponent-${crypto.randomUUID()}`,
			championshipSlug: `scheduled-championship-${crypto.randomUUID()}`,
			name: "Parity Scheduled Only",
		};
		await query(`BEGIN;
      INSERT INTO team(id,name,country,slug) VALUES
        ('${scheduled.team}','Parity Scheduled Club','Brasil','${scheduled.teamSlug}'),
        ('${scheduled.opponent}','Parity Scheduled Opponent','Brasil','${scheduled.opponentSlug}');
      INSERT INTO player(id,name,full_name,country,position,slug) VALUES
        ('${scheduled.player}',${
			quoted(scheduled.name)
		},'Parity Scheduled Full Name','Brasil','cm','${scheduled.playerSlug}');
      INSERT INTO championship(id,name,region_name,begins,ends,slug) VALUES
        ('${scheduled.championship}','Parity Scheduled Season','Brasil','2031-01-01','2031-12-31','${scheduled.championshipSlug}');
      INSERT INTO phase(id,championship_id,name) VALUES
        ('${scheduled.phase}','${scheduled.championship}','Parity Scheduled Phase');
      INSERT INTO game(id,phase_id,day,home_id,away_id) VALUES
        ('${scheduled.game}','${scheduled.phase}','2031-03-01','${scheduled.team}','${scheduled.opponent}');
      INSERT INTO player_game(id,game_id,player_id,side,on_minute,off_minute,bench) VALUES
        ('${scheduled.appearance}','${scheduled.game}','${scheduled.player}','home',0,NULL,false);
      COMMIT;`);
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
					) {
						failures.push(`${response.status()} ${response.url()}`);
					}
				});
				const playerSlug = await address("player", VIVEROS);
				const teamSlug = await address("team", ATHLETICO);
				const championshipSlug = await address("championship", BRASILEIRO);

				await visit(page, "/jogadores?lang=pt-BR", "jogadores");
				await page.locator(`${active} #players-directory-q`).fill("viveros");
				await page.locator(`${active} #players-directory-position`)
					.selectOption("fw");
				await page.locator(`${active} #players-directory-country`).fill(
					"colombia",
				);
				await page.locator(`${active} #players-directory-region`).selectOption(
					"south_america",
				);
				await page.waitForFunction(({ active, playerSlug }) => {
					const rows = document.querySelectorAll(
						`${active} .catalog-table tbody tr`,
					);
					return rows.length === 1 &&
						rows[0].querySelector("a[data-route='jogador']")?.getAttribute(
								"data-param-slug",
							) === playerSlug;
				}, { active, playerSlug });
				assert(
					(await page.locator(`${active} .catalog-table tbody tr`).innerText())
						.includes("K. Viveros"),
				);
				const currentClub = page.locator(
					`${active} .catalog-table tbody tr td`,
				).nth(4).locator("a[data-route='equipe']");
				assertEquals(await currentClub.count(), 1);
				assert(await currentClub.getAttribute("href"));
				await page.locator(`${active} #players-directory-q`).fill(
					"no-player-matches-this-search",
				);
				await page.waitForFunction(
					(active) =>
						document.querySelectorAll(
							`${active} .catalog-table tbody tr:not(.empty)`,
						).length === 0,
					active,
				);
				assert(
					(await page.locator(`${active}`).innerText()).includes(
						"Nenhum jogador corresponde aos filtros.",
					),
				);

				await visit(page, "/jogadores?lang=pt-BR", "jogadores");
				await page.locator(`${active} #players-directory-q`).fill(
					scheduled.name,
				);
				await page.waitForFunction(({ active, slug }) => {
					const rows = document.querySelectorAll(
						`${active} .catalog-table tbody tr`,
					);
					return rows.length === 1 &&
						rows[0].querySelector("a[data-route='jogador']")?.getAttribute(
								"data-param-slug",
							) === slug;
				}, { active, slug: scheduled.playerSlug });
				const scheduledDirectoryClub = page.locator(
					`${active} .catalog-table tbody tr td`,
				).nth(4).locator("a[data-route='equipe']");
				assertEquals(await scheduledDirectoryClub.count(), 0);
				assertEquals(
					await page.locator(`${active} .catalog-table tbody tr td`).nth(4)
						.locator("img").count(),
					0,
				);
				assertEquals(
					await page.locator(`${active} .catalog-table tbody tr td`).nth(4)
						.locator(".archive-icon").count(),
					0,
				);
				assertEquals(
					await page.locator(`${active} .catalog-table tbody tr td`).nth(4)
						.innerText(),
					"",
				);

				await visit(
					page,
					`/jogador/${scheduled.playerSlug}?lang=pt-BR`,
					"jogador",
				);
				const scheduledProfileClub = page.locator(
					`${active} .player > .page > .content > .game-facts a[data-route='equipe']`,
				);
				assertEquals(await scheduledProfileClub.count(), 0);
				const scheduledProfileClubValue = page.locator(
					`${active} .game-facts dt:has-text("Último clube") + dd`,
				);
				assertEquals(await scheduledProfileClubValue.innerText(), "");
				assertEquals(
					await scheduledProfileClubValue.locator(".archive-icon, img").count(),
					0,
				);
				await page.locator(`${active} #player-appearances-played`).selectOption(
					"false",
				);
				await page.waitForSelector(
					`${active} .player-games .player-appearance-detail`,
				);
				assertEquals(
					number(
						await page.locator(
							`${active} .player-appearance-detail [data-text='{minutes}']`,
						).innerText(),
					),
					0,
				);

				await visit(
					page,
					`${await fixturePath(`/jogador/${VIVEROS}`)}?lang=pt-BR`,
					"jogador",
				);
				await page.waitForSelector(`${active} .season-table tbody tr`);
				const biography = await page.locator(
					`${active} .player > .page > .content > .game-facts`,
				).innerText();
				for (
					const label of [
						"Nome completo",
						"Data de nascimento",
						"Altura",
						"Atacante",
						"Colômbia",
					]
				) assert(biography.includes(label), biography);
				const fields = await page.locator(
					`${active} .season-table thead th abbr`,
				).evaluateAll((headers) =>
					headers.map((header) => header.getAttribute("title"))
				);
				for (
					const label of [
						"Gols contra",
						"Gols por 90 minutos",
						"Contribuição registrada",
						"Banco sem entrar",
					]
				) assert(fields.includes(label), JSON.stringify(fields));
				const bio = JSON.parse(
					await query(`SELECT json_build_object(
          'name',p.name,'full_name',p.full_name,'birth',p.birth,'height',p.height,
          'team_name',t.name,'championship_name',c.name)
        FROM player p CROSS JOIN team t CROSS JOIN championship c
        WHERE p.id='${VIVEROS}' AND t.id='${ATHLETICO}' AND c.id='${BRASILEIRO}'`),
				) as {
					name: string;
					full_name: string | null;
					birth: string | null;
					height: number | null;
					team_name: string;
					championship_name: string;
				};
				assertEquals(
					await page.locator(
						`${active} .game-facts dd[data-text='{full_name}']`,
					).innerText(),
					bio.full_name ?? "",
				);
				assertEquals(
					await page.locator(`${active} .game-facts dd[data-text='{birth}']`)
						.innerText(),
					bio.birth ?? "",
				);
				assertEquals(
					await page.locator(
						`${active} .game-facts dd[data-text-format='player-height']`,
					).innerText(),
					bio.height === null ? "" : `${bio.height} cm`,
				);
				const season = page.locator(`${active} .season-table tbody tr`).first();
				assertEquals(
					number(await season.locator("[data-text='{goals}']").innerText()),
					18,
				);
				assertEquals(
					await season.locator("[data-text='{championship.season}']")
						.innerText(),
					"2026",
				);
				const scopedLink = season.locator("a[data-route='jogador-campeonato']");
				assertEquals(
					await scopedLink.getAttribute("data-param-slug"),
					playerSlug,
				);
				assertEquals(
					await scopedLink.getAttribute("data-param-team"),
					teamSlug,
				);
				assertEquals(
					await scopedLink.getAttribute("data-param-championship"),
					championshipSlug,
				);
				await awaitCsv(
					page,
					await page.locator(`${active} .season-table tbody tr`).count(),
				);
				await scopedLink.click();
				await page.waitForSelector(
					`${active} .screen[data-screen='jogador-campeonato'][data-state='populated']`,
				);
				assertEquals(
					await page.locator(`${active} h1`).innerText(),
					"K. Viveros",
				);
				assertEquals(
					number(
						await page.locator(
							`${active} .squad-table tbody [data-text='{goals}']`,
						).innerText(),
					),
					18,
				);
				await page.waitForSelector(`${active} .player-games .game-row`);
				assert(
					await page.locator(
						`${active} .player-appearance-detail [data-text='{contribution}']`,
					).count() > 0,
				);
				assertEquals(
					await page.locator(`${active} aside a[data-route='jogador']`)
						.getAttribute("data-param-slug"),
					playerSlug,
				);

				await visit(
					page,
					`/campeonato-jogadores/${championshipSlug}?lang=pt-BR`,
					"campeonato-jogadores",
				);
				const full = await totals("");
				assert(
					full.rows > 40,
					"The seeded championship must exceed one page to exercise complete totals.",
				);
				await awaitTotals(page, full);
				assertEquals(
					await page.locator(`${active} .season-table tbody tr`).count(),
					40,
				);
				await awaitCsv(page, 40);
				await page.locator(`${active} #championship-players-minimum-minutes`)
					.fill("2300");
				await page.locator(`${active} #championship-players-minimum-minutes`)
					.press("Tab");
				const filtered = await totals("AND minutes>=2300");
				assert(filtered.rows > 0 && filtered.rows < full.rows);
				await awaitTotals(page, filtered, 2300);
				const minutes = await page.locator(
					`${active} .season-table tbody [data-text='{minutes}']`,
				).allTextContents();
				assert(minutes.every((value) => number(value) >= 2300));
				await page.locator(`${active} #championship-players-minimum-minutes`)
					.fill("0");
				await page.locator(`${active} #championship-players-minimum-minutes`)
					.press("Tab");
				await page.locator(`${active} #championship-players-q`).fill("viveros");
				const searched = await totals("AND search_key LIKE '%viveros%'");
				await awaitTotals(page, searched);
				assertEquals(
					await page.locator(`${active} .season-table tbody tr`).count(),
					1,
				);
				const csvLink = await awaitCsv(page, 1);
				const csvMinutes = number(
					await page.locator(
						`${active} .season-table tbody [data-text='{minutes}']`,
					).innerText(),
				);
				const [download] = await Promise.all([
					page.waitForEvent("download"),
					csvLink.click(),
				]);
				assertEquals(download.suggestedFilename(), "jogadores-pagina.csv");
				const csvPath = await download.path();
				assert(csvPath !== null);
				const csv = await Deno.readTextFile(csvPath);
				assert(csv.includes('"K. Viveros"'));
				assert(csv.includes(`,${csvMinutes},18,`));
				await page.locator(`${active} #championship-players-sort`).selectOption(
					"minutes",
				);
				await awaitTotals(page, searched);

				assertEquals(
					await query(
						`SELECT count(*) FROM player WHERE id='${VIVEROS}' AND name=${
							quoted(bio.name)
						} AND slug=${quoted(playerSlug)}`,
					),
					"1",
				);
				assertEquals(searched.rows, 1);
				const fullName = "Parity Número Único Viveros";
				const playerName = "Parity Jogador Renomeado Viveros";
				const teamName = "Parity Clube Renomeado";
				const championshipName = "Parity Campeonato Renomeado";
				try {
					await query(`BEGIN;
          UPDATE player SET name=${quoted(playerName)},full_name=${
						quoted(fullName)
					} WHERE id='${VIVEROS}';
          UPDATE team SET name=${quoted(teamName)} WHERE id='${ATHLETICO}';
          UPDATE championship SET name=${
						quoted(championshipName)
					} WHERE id='${BRASILEIRO}';
          COMMIT;`);
					const championshipFullName = await query(
						`SELECT full_name FROM championship WHERE id='${BRASILEIRO}'`,
					);
					await visit(page, "/jogadores?lang=pt-BR", "jogadores");
					await page.locator(`${active} #players-directory-q`).fill(
						"jogador renomeado",
					);
					await page.waitForFunction(({ active, fullName, playerName }) => {
						const rows = document.querySelectorAll(
							`${active} .catalog-table tbody tr`,
						);
						return rows.length === 1 &&
							rows[0].textContent?.includes(fullName) &&
							rows[0].textContent?.includes(playerName);
					}, { active, fullName, playerName });
					await visit(
						page,
						`${await fixturePath(`/jogador/${VIVEROS}`)}?lang=pt-BR`,
						"jogador",
					);
					assertEquals(
						await page.locator(`${active} h1`).innerText(),
						playerName,
					);
					assertEquals(
						await page.locator(
							`${active} .game-facts dd[data-text='{full_name}']`,
						).innerText(),
						fullName,
					);
					await page.locator(`${active} #player-career-q`).fill(
						"no-player-matches-this-search",
					);
					await page.waitForFunction(
						(active) =>
							document.querySelectorAll(
								`${active} .season-table tbody tr:not(.empty)`,
							).length === 0,
						active,
					);
					await page.locator(`${active} #player-career-q`).fill(
						"clube renomeado",
					);
					await page.waitForFunction(
						({ active, teamName, championshipFullName }) => {
							const rows = [...document.querySelectorAll(
								`${active} .season-table tbody tr:not(.empty)`,
							)];
							return rows.length > 0 &&
								rows.some((row) =>
									row.textContent?.includes(teamName) &&
									row.textContent?.includes(championshipFullName)
								);
						},
						{ active, teamName, championshipFullName },
					);
					const careerRow = page.locator(`${active} .season-table tbody tr`)
						.first();
					assert((await careerRow.innerText()).includes(teamName));
					assert((await careerRow.innerText()).includes(championshipFullName));
					const careerCsvLink = await awaitCsv(
						page,
						await page.locator(`${active} .season-table tbody tr`).count(),
					);
					const careerCsvHref = await careerCsvLink.getAttribute("href");
					if (!careerCsvHref?.startsWith("data:text/csv;charset=utf-8,")) {
						throw new Error("player career CSV link is missing its data URL");
					}
					const careerCsv = decodeURIComponent(
						careerCsvHref.slice("data:text/csv;charset=utf-8,".length),
					);
					for (const current of [playerName, teamName, championshipFullName]) {
						assert(careerCsv.includes(`"${current}"`), careerCsv);
					}
					await visit(
						page,
						`/campeonato-jogadores/${championshipSlug}?lang=pt-BR`,
						"campeonato-jogadores",
					);
					await page.locator(`${active} #championship-players-q`).fill(
						"no-player-matches-this-search",
					);
					await page.waitForFunction(
						(active) =>
							document.querySelectorAll(
									`${active} .season-table tbody tr:not(.empty)`,
								).length === 0 &&
							document.querySelector(
									`${active} .season-table tfoot [data-text='{minutes}']`,
								)?.textContent === "",
						active,
					);
					await page.locator(`${active} #championship-players-q`).fill(
						"jogador renomeado",
					);
					const renamed = await totals(
						"AND search_key LIKE '%jogador renomeado%'",
					);
					await awaitTotals(page, renamed);
					await page.waitForFunction(
						({ active, playerName, teamName }) => {
							const rows = [...document.querySelectorAll(
								`${active} .season-table tbody tr:not(.empty)`,
							)];
							return rows.length === 1 &&
								rows[0].textContent?.includes(playerName) &&
								rows[0].textContent?.includes(teamName);
						},
						{ active, playerName, teamName },
					);
					assertEquals(
						await page.locator(`${active} .season-table tbody tr`).count(),
						1,
					);
					const renamedRow = page.locator(`${active} .season-table tbody tr`);
					assert((await renamedRow.innerText()).includes(playerName));
					assert((await renamedRow.innerText()).includes(teamName));
					const renamedCsvLink = await awaitCsv(page, 1);
					const renamedCsvHref = await renamedCsvLink.getAttribute("href");
					if (!renamedCsvHref?.startsWith("data:text/csv;charset=utf-8,")) {
						throw new Error(
							"championship player CSV link is missing its data URL",
						);
					}
					const renamedCsv = decodeURIComponent(
						renamedCsvHref.slice("data:text/csv;charset=utf-8,".length),
					);
					for (const current of [playerName, teamName, championshipFullName]) {
						assert(renamedCsv.includes(`"${current}"`), renamedCsv);
					}
					await visit(
						page,
						`/jogador-campeonato/${playerSlug}/${teamSlug}/${championshipSlug}?lang=pt-BR`,
						"jogador-campeonato",
					);
					assertEquals(
						await page.locator(`${active} h1`).innerText(),
						playerName,
					);
					const scope = await page.locator(`${active} .content > h2`)
						.innerText();
					assert(scope.includes(teamName), scope);
					assert(scope.includes(championshipFullName), scope);
				} finally {
					await query(`BEGIN;
          UPDATE player SET name=${quoted(bio.name)},full_name=${
						quoted(bio.full_name)
					} WHERE id='${VIVEROS}';
          UPDATE team SET name=${quoted(bio.team_name)} WHERE id='${ATHLETICO}';
          UPDATE championship SET name=${
						quoted(bio.championship_name)
					} WHERE id='${BRASILEIRO}';
          COMMIT;`);
				}
				assertEquals(failures, []);
				await context.close();
			} finally {
				await browser.close();
			}
		} finally {
			await query(`BEGIN;
        DELETE FROM player WHERE id='${scheduled.player}';
        DELETE FROM championship WHERE id='${scheduled.championship}';
        DELETE FROM team WHERE id IN ('${scheduled.team}','${scheduled.opponent}');
        COMMIT;`);
		}
	},
});
