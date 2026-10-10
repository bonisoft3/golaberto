/// <reference lib="dom" />
// Browser acceptance for the split team profile and championship pages. All
// committed fixture rows are removed in finally from an explicitly disposable stack.
import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { address as fixtureAddress, fixturePath } from "./addresses.ts";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test|prs)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error(
    "team-page-split requires an explicit disposable COMPOSE_PROJECT_NAME containing check or test",
  );
}

const { chromium } = await import("npm:playwright@1.61.1");
const base = await baseUrl(".");
const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
// deno-lint-ignore no-explicit-any
type Page = any;
const psql = async (sql: string): Promise<string> => {
  const result = await new Deno.Command("docker", {
    args: [
      "compose", "-p", project, "exec", "-T", "golaberto-database",
      "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1",
      "-qAt",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = result.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const output = await result.output();
  assert(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
};

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const uuid = () => crypto.randomUUID();
const uuid5 = async (name: string) => {
  const namespace = "6f1c5d2e-9a3b-4c7d-8e1f-2a4b6c8d0e1f";
  const nsBytes = new Uint8Array(namespace.replaceAll("-", "").match(/../g)!.map((byte) => parseInt(byte, 16)));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes);
  input.set(nameBytes, nsBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const team = uuid();
const opponent = uuid();
const currentChamp = uuid();
const pastChamp = uuid();
const opponentChamp = uuid();
const missingChamp = "missing-championship";
const currentPhase = uuid();
const pastPhase = uuid();
const opponentPhase = uuid();
const currentGroup = uuid();
const opponentGroup = uuid();
const currentZone = uuid();
const pastGame = uuid();
const currentGame = uuid();
const otherGame = uuid();
const campaignGame = uuid();
const otherZone = uuid();
const sharedPlayer = uuid();
const pastPlayer = uuid();
const zeroPlayer = uuid();
const rosterPlayers = Array.from({ length: 41 }, () => uuid());
const allPlayers = [sharedPlayer, pastPlayer, zeroPlayer, ...rosterPlayers];
const allChamps = [currentChamp, pastChamp, opponentChamp];
const allTeams = [team, opponent];
const tableReady = '.shell-screen:not([hidden]) .screen[data-state="populated"]';

const addFixtures = async () => {
  const players = [
    `(${q(sharedPlayer)},'Shared Across Seasons','fw','Brasil')`,
    `(${q(pastPlayer)},'Past Only Player','dc','Brasil')`,
    `(${q(zeroPlayer)},'A Zero Átlético','g','Brasil')`,
    ...rosterPlayers.map((id, index) =>
      `(${q(id)},'Roster Player ${String(index + 1).padStart(2, "0")}','cm','Brasil')`
    ),
  ].join(",");
  const teamGames = [
    `(${q(`${team}:${currentGame}`)},${q(team)},${q(currentGame)},'home',${q(opponent)},'Split Opponent',${q(currentChamp)},'Split Current',(now() AT TIME ZONE 'America/Sao_Paulo')::date + 1,NULL,false,NULL,NULL,'')`,
    `(${q(`${team}:${pastGame}`)},${q(team)},${q(pastGame)},'away',${q(opponent)},'Split Opponent',${q(pastChamp)},'Split Past',(now() AT TIME ZONE 'America/Sao_Paulo')::date - 80,NULL,true,2,0,'w')`,
    `(${q(`${team}:${otherGame}`)},${q(team)},${q(otherGame)},'home',${q(opponent)},'Split Opponent',${q(opponentChamp)},'Other Team Cup',(now() AT TIME ZONE 'America/Sao_Paulo')::date + 2,NULL,false,NULL,NULL,'')`,
  ].join(",");
  const standingRows = [team, opponent].map((id, index) =>
    `(${q(`${currentGroup}:${id}`)},${q(currentGroup)},${q(id)},${q(id === team ? "Split Target" : "Split Opponent")},${index + 1},${index === 0 ? 3 : 0},1,1,0,0,2,0,2,'w','','','','','champion')`
  ).join(",");
  const otherStandingRows = [team, opponent].map((id, index) =>
    `(${q(`${opponentGroup}:${id}`)},${q(opponentGroup)},${q(id)},${q(id === team ? "Split Target" : "Split Opponent")},${index + 1},${index === 0 ? 3 : 0},1,1,0,0,1,0,1,'w','','','','','champion')`
  ).join(",");
  const currentTeamChance = await uuid5(`${currentGroup}:${team}`);
  const currentOpponentChance = await uuid5(`${currentGroup}:${opponent}`);
  const otherTeamChance = await uuid5(`${opponentGroup}:${team}`);
  const otherOpponentChance = await uuid5(`${opponentGroup}:${opponent}`);
  const currentTeamPosition = await uuid5(`${currentGroup}:${team}:1`);
  const otherTeamPosition = await uuid5(`${opponentGroup}:${team}:1`);
  const otherOpponentPosition = await uuid5(`${opponentGroup}:${opponent}:1`);
  const currentTeamZone = await uuid5(`${currentGroup}:${team}:${currentZone}`);
  const otherTeamZone = await uuid5(`${opponentGroup}:${team}:${otherZone}`);

  await psql(`BEGIN;
    INSERT INTO team (id,name,full_name,city,country,foundation) VALUES
      (${q(team)},'Split Target','Split Target Full Name','Split City','Brasil','1910-02-03'),
      (${q(opponent)},'Split Opponent','Split Opponent Full Name','Elsewhere','Brasil','1912-04-05');
    UPDATE team SET latitude=-25.43,longitude=-49.27 WHERE id=${q(team)};
    INSERT INTO player (id,name,position,country) VALUES ${players};
    INSERT INTO championship (id,name,region_name,begins,ends) VALUES
      (${q(currentChamp)},'Split Current','Brasil',(now() AT TIME ZONE 'America/Sao_Paulo')::date - 20,(now() AT TIME ZONE 'America/Sao_Paulo')::date + 20),
      (${q(pastChamp)},'Split Past','Brasil',(now() AT TIME ZONE 'America/Sao_Paulo')::date - 100,(now() AT TIME ZONE 'America/Sao_Paulo')::date - 60),
      (${q(opponentChamp)},'Other Team Cup','Brasil',(now() AT TIME ZONE 'America/Sao_Paulo')::date - 20,(now() AT TIME ZONE 'America/Sao_Paulo')::date + 20);
    INSERT INTO team_player (championship_id,team_id,player_id) VALUES
      ${[
        ...[zeroPlayer, ...rosterPlayers].map((id) => `(${q(currentChamp)},${q(team)},${q(id)})`),
        `(${q(currentChamp)},${q(team)},${q(sharedPlayer)})`,
        `(${q(pastChamp)},${q(team)},${q(sharedPlayer)})`,
        `(${q(pastChamp)},${q(team)},${q(pastPlayer)})`,
        `(${q(opponentChamp)},${q(team)},${q(sharedPlayer)})`,
      ].join(",")};
    INSERT INTO phase (id,championship_id,name) VALUES
      (${q(currentPhase)},${q(currentChamp)},'Current Phase'),
      (${q(pastPhase)},${q(pastChamp)},'Past Phase'),
      (${q(opponentPhase)},${q(opponentChamp)},'Other Phase');
    INSERT INTO stage_group (id,phase_id,name) VALUES
      (${q(currentGroup)},${q(currentPhase)},'Split Group'),
      (${q(opponentGroup)},${q(opponentPhase)},'Other Team Group');
    INSERT INTO zone (id,group_id,name,color,first,last) VALUES
      (${q(currentZone)},${q(currentGroup)},'Title places','champion',1,1),
      (${q(otherZone)},${q(opponentGroup)},'Other title places','champion',1,1);
    INSERT INTO team_group (group_id,team_id) VALUES
      (${q(currentGroup)},${q(team)}),(${q(currentGroup)},${q(opponent)}),
      (${q(opponentGroup)},${q(team)}),(${q(opponentGroup)},${q(opponent)});
    INSERT INTO standing (id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone) VALUES
      ${standingRows},${otherStandingRows};
    INSERT INTO game (id,phase_id,day,home_id,away_id,played,home_score,away_score) VALUES
      (${q(currentGame)},${q(currentPhase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date + 1,${q(team)},${q(opponent)},false,NULL,NULL),
      (${q(pastGame)},${q(pastPhase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date - 80,${q(opponent)},${q(team)},true,0,2),
      (${q(otherGame)},${q(opponentPhase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date + 2,${q(team)},${q(opponent)},false,NULL,NULL),
      (${q(campaignGame)},${q(currentPhase)},(now() AT TIME ZONE 'America/Sao_Paulo')::date - 1,${q(team)},${q(opponent)},true,2,0);
    INSERT INTO team_game (id,team_id,game_id,side,opponent_id,opponent_name,championship_id,championship_name,day,kickoff,played,goals_for,goals_against,result) VALUES ${teamGames};
    INSERT INTO team_chance (id,group_id,team_id,team_name,rank,points,played) VALUES
      (${q(currentTeamChance)},${q(currentGroup)},${q(team)},'Split Target',1,3,1),
      (${q(currentOpponentChance)},${q(currentGroup)},${q(opponent)},'Split Opponent',2,0,1),
      (${q(otherTeamChance)},${q(opponentGroup)},${q(team)},'Split Target',2,1,1),
      (${q(otherOpponentChance)},${q(opponentGroup)},${q(opponent)},'Split Opponent',1,3,1);
    INSERT INTO position_chance (id,group_id,team_id,position,percent,band,current,reach) VALUES
      (${q(currentTeamPosition)},${q(currentGroup)},${q(team)},1,62.5,3,true,''),
      (${q(otherTeamPosition)},${q(opponentGroup)},${q(team)},1,12,1,true,''),
      (${q(otherOpponentPosition)},${q(opponentGroup)},${q(opponent)},1,88,4,true,'');
    INSERT INTO zone_chance (id,group_id,team_id,zone_id,first,percent,color,band,last,reach) VALUES
      (${q(currentTeamZone)},${q(currentGroup)},${q(team)},${q(currentZone)},1,62.5,'champion',3,1,''),
      (${q(otherTeamZone)},${q(opponentGroup)},${q(team)},${q(otherZone)},1,12,'champion',1,1,'');
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES
      (gen_random_uuid(),${q(team)},current_date-10,1.1,1.2,40),
      (gen_random_uuid(),${q(team)},current_date-5,1.2,1.3,50);
    SELECT refresh_one_team_rating_chart(${q(team)}::uuid);
    INSERT INTO team_game (id,team_id,game_id,side,opponent_id,opponent_name,championship_id,championship_name,day,played,goals_for,goals_against,result)
      VALUES (${q(`${team}:${campaignGame}`)},${q(team)},${q(campaignGame)},'home',${q(opponent)},'Split Opponent',${q(currentChamp)},'Split Current',current_date-1,true,2,0,'w');
    INSERT INTO team_odds_history (id,group_id,team_id,recorded_on,captured_at,position,percent,source) VALUES
      (${q(`${currentGroup}:${team}:2026-01-01:1`)},${q(currentGroup)},${q(team)},'2026-01-01',NULL,1,25,'imported'),
      (${q(`${currentGroup}:${team}:2026-01-02:1`)},${q(currentGroup)},${q(team)},'2026-01-02',NULL,1,62.5,'imported');
    SELECT refresh_team_odds_charts(${q(currentGroup)}::uuid);
    DO $$ BEGIN PERFORM refresh_team_profiles(50); END $$;
    COMMIT;`);
};

const removeFixtures = async () => {
  await psql(`BEGIN;
    DELETE FROM team WHERE id IN (${allTeams.map(q).join(",")});
    DELETE FROM championship WHERE id IN (${allChamps.map(q).join(",")});
    DELETE FROM player WHERE id IN (${allPlayers.map(q).join(",")});
    COMMIT;`);
};

const visit = async (page: Page, path: string) => {
  await page.goto(`${base}${await fixturePath(path, psql)}`);
  await page.waitForSelector(tableReady, { timeout: 30_000 });
};

Deno.test("team profile and championship pages keep memberships, players, and season data in scope", async () => {
  await addFixtures();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "pt-BR",
    hasTouch: true,
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    const screen = () => page.locator(".shell-screen:not([hidden])");
    await visit(page, `/equipe/${team}?lang=pt-BR`);
    await page.waitForFunction((id: string) =>
      [...(document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll<HTMLAnchorElement>(".team-current-championships a[data-route='equipe-campeonato']") ?? [])]
        .some((link) => link.dataset.paramChampionship === id), await fixtureAddress("championship", currentChamp, psql));
    await page.waitForFunction((id: string) =>
      [...(document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll<HTMLAnchorElement>(".team-past-championships a[data-route='equipe-campeonato']") ?? [])]
        .some((link) => link.dataset.paramChampionship === id), await fixtureAddress("championship", pastChamp, psql));
    await page.waitForFunction(() => {
      const active = document.querySelector(".shell-screen:not([hidden])");
      return active?.querySelectorAll(".team-current-players a[data-route='jogador']").length === 40 &&
        active.querySelectorAll(".team-past-players a[data-route='jogador']").length === 1;
    });
    assertEquals(await screen().locator(".team-current-championships a").count(), 2);
    assertEquals(await screen().locator(".team-past-championships a").count(), 1);
    const currentPlayers = await screen().locator(".team-current-players a").evaluateAll((links: HTMLAnchorElement[]) =>
      links.map((link) => ({
        id: link.getAttribute("data-param-slug"),
        label: link.textContent?.replace(/\s+/g, " ").trim(),
      })));
    assertEquals(new Set(currentPlayers.map((player) => player.id)).size, currentPlayers.length, "the current-player page has no duplicates");
    assert(currentPlayers.some((player) => player.label === "A Zero Átlético g"), "current registrations include players without an appearance");
    await screen().locator("#team-current-players-next").click();
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-current-players a[data-route='jogador']").length === 3);
    const secondHistoryPageIds = await screen().locator(".team-current-players a[data-route='jogador']")
      .evaluateAll((links: HTMLAnchorElement[]) => links.map((link) => link.getAttribute("data-param-slug")));
    const allCurrentPlayerIds = [...currentPlayers.map((player) => player.id), ...secondHistoryPageIds];
    assertEquals(new Set(allCurrentPlayerIds).size, 43, "history paging shows each player once across current seasons");
    assert((await screen().locator(".team-current-players").innerText()).includes("Shared Across Seasons"));
    assertEquals(await screen().locator(".team-past-players a").evaluateAll((links: HTMLAnchorElement[]) =>
      links.map((link) => link.textContent?.replace(/\s+/g, " ").trim())),
      ["Past Only Player dc"]);

    assertEquals(await screen().locator('#team-upcoming-category').count(), 1, 'all-competition archives retain category filtering');
    await screen().locator('.team-rating-history svg').waitFor();
    assertEquals(await screen().locator('.team-location a').getAttribute('href'), 'https://www.openstreetmap.org/?mlat=-25.43&mlon=-49.27#map=14/-25.43/-49.27');
    await screen().locator('#team-rating-period').selectOption('all');
    const today = new Date();
    const isoDaysAgo = (days: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days)).toISOString().slice(0, 10);
    await screen().locator('#team-rating-from').fill(isoDaysAgo(7));
    await screen().locator('#team-rating-from').press('Tab');
    await screen().locator('#team-rating-to').fill(isoDaysAgo(1));
    await screen().locator('#team-rating-to').press('Tab');
    await page.waitForFunction(() => document.querySelectorAll('.shell-screen:not([hidden]) .team-rating-history svg circle').length === 1);
    assertEquals(await screen().locator('#team-rating-period').inputValue(), 'all', 'custom dates read the bounded all-history projection');
    await screen().locator('#team-rating-from').fill(isoDaysAgo(0));
    await screen().locator('#team-rating-from').press('Tab');
    await screen().locator('.team-rating-history [role="alert"]').waitFor();
    await screen().locator('#team-rating-reset').click();
    await page.waitForFunction(() => document.querySelectorAll('.shell-screen:not([hidden]) .team-rating-history svg circle').length === 2);
    assertEquals(await screen().locator('#team-rating-period').inputValue(), '1y');
    assertEquals(await screen().locator('#team-rating-from').inputValue(), '');
    assertEquals(await screen().locator('#team-rating-to').inputValue(), '');
    await screen().locator('#team-current-players-q').fill('atletico');
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-current-players .team-player-list')?.textContent?.includes('A Zero Átlético'));
    assertEquals(await screen().locator('.team-current-players a[data-route="jogador"]').count(),1,'accent-insensitive search resets the page and finds the matching player');
    await screen().locator('#team-current-players-q').fill('');
    await screen().locator('#team-comment-body').fill('Keep this team note after refusal');
    await screen().locator('#team-comment-post').click();
    await screen().locator('.composer[data-state="refused"]').waitFor();
    assertEquals(await screen().locator('#team-comment-body').inputValue(),'Keep this team note after refusal','guest refusal preserves the team draft');

    await screen().locator(`.team-current-championships a[data-param-championship="${await fixtureAddress("championship", currentChamp, psql)}"]`).click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${team}/${currentChamp}**`, psql));
    await screen().locator(".team-championship-page").waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 40);
    assertEquals(await screen().locator(".team-current-championships").count(), 0);
    assertEquals(await screen().locator(".team-next .game-row").count(), 1);
    assertEquals(await screen().locator(".team-results .game-row").count(), 1);
    assertEquals(await screen().locator(".team-standings .standings tbody tr").count(), 2);
    assertEquals(await screen().locator('.team-championship-page select[id$="-category"], .team-championship-page [data-live="category"]').count(), 0, 'category is fixed within a championship');
    assertEquals(await screen().locator('.team-championship-page details.team-name-disclosure, .team-championship-page .team-name-full').count(), 0, 'names have no disclosure controls');
    assert(!(await screen().locator('.team-next tbody[data-live="team_game"]').getAttribute('data-filter'))?.includes('category_key'), 'scoped fixtures cannot retain a hidden category filter');
    const homeFixture = screen().locator(`.team-results .fixture-row[data-game-id="${campaignGame}"]`);
    assertEquals(await homeFixture.locator('.home .team-name').textContent(), 'Split Target');
    assertEquals(await homeFixture.locator('.away .team-name').textContent(), 'Split Opponent');
    assertEquals(await homeFixture.locator('.score b').allTextContents(), ['2', '0'], 'home goals precede away goals');
    assertEquals(await screen().locator('.team-fixture-table .where, .team-fixture-table .venue').count(), 0, 'scoped rows omit repeated championship and venue labels');
    assertEquals(await screen().locator('.team-next .team-fixture-table .score b:visible').count(), 0, 'upcoming games do not invent scores');
    assertEquals(await screen().locator('.team-results .team-fixture-table thead th').allTextContents(), ['Data', 'Mandante', 'Placar', 'Visitante', 'Resultado']);
    assertEquals(await screen().locator(".team-standings h3").allTextContents(), ["Current Phase · Split Group"], "the table stays in the selected championship");
    assertEquals(await screen().locator(".team-odds .team-odds-table tbody tr").count(), 1, await screen().locator(".team-odds").innerText());
    assert(/62[,.]5/.test(await screen().locator(".team-odds").innerText()));
    for (const section of ["team-table", "team-roster", "team-odds", "team-fixtures"]) {
      await screen().locator(`.team-section-links a[href$="#${section}"]`).click();
      const address = new URL(page.url());
      assertEquals(address.pathname, await fixturePath(`/equipe-campeonato/${team}/${currentChamp}`, psql), "section links retain both addresses");
      assertEquals(address.searchParams.get("lang"), "pt-BR", "section links retain the selected language");
      assertEquals(address.hash, `#${section}`);
      assert(await screen().locator(`#${section}`).isVisible());
      await page.waitForFunction((section: string) => {
        const target = document.querySelector(`.shell-screen:not([hidden]) #${section} h2`);
        const top = target?.getBoundingClientRect().top;
        const stripBottom = document.querySelector("body > nav")?.getBoundingClientRect().bottom ?? 0;
        return top !== undefined && top >= stripBottom - 2 && top < innerHeight;
      }, section, { timeout: 3000 });
    }
    const zero = screen().locator('.team-roster .squad-table tbody tr').filter({ hasText: "A Zero Átlético" });
    assertEquals(await zero.locator("td").nth(2).textContent(), "0", "registered players without appearances retain a zero row");
    const idsOnFirstPage = await screen().locator(".team-roster .squad-table a[data-route='jogador']")
      .evaluateAll((links: HTMLAnchorElement[]) => links.map((link) => link.getAttribute("data-param-slug")));
    assertEquals(idsOnFirstPage.length, 40);
    await screen().locator("#team-roster-next").click();
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 3);
    const idsOnSecondPage = await screen().locator(".team-roster .squad-table a[data-route='jogador']")
      .evaluateAll((links: HTMLAnchorElement[]) => links.map((link) => link.getAttribute("data-param-slug")));
    assertEquals(new Set([...idsOnFirstPage, ...idsOnSecondPage]).size, 43, "roster paging covers all current entries");

    await screen().locator('.team-campaign svg').waitFor();
    await screen().locator('.team-odds svg').first().waitFor();
    await screen().locator('.team-odds-evolution svg').waitFor();
    const positionFrom = screen().locator('.team-odds input[id$="-from"]').first();
    const positionTo = screen().locator('.team-odds input[id$="-to"]').first();
    await positionFrom.fill('1');
    await positionFrom.press('Tab');
    await positionTo.fill('1');
    await positionTo.press('Tab');
    await screen().locator('.team-odds .team-chart__selection[role="status"]').waitFor();
    assert(/62[,.]5%/.test(await screen().locator('.team-odds .team-chart__selection').first().innerText()), 'a keyboard-entered final-position range totals its inclusive probability');
    await positionFrom.fill('2');
    await positionFrom.press('Tab');
    await screen().locator('.team-odds .team-chart__selection[role="alert"]').waitFor();
    await screen().locator('.team-odds button[id$="-reset"]').first().click();
    assertEquals(await positionFrom.inputValue(), '');
    assertEquals(await positionTo.inputValue(), '');
    const zoneHistory = screen().locator('.team-odds-evolution details.team-zone-history').first();
    await zoneHistory.locator('summary').click();
    assertEquals(await zoneHistory.getAttribute('open'), null, 'zone histories remain selectable with the native disclosure control');
    await zoneHistory.locator('summary').click();
    assertEquals(await zoneHistory.getAttribute('open'), '', 'the selected probability history can be restored without another read');
    await screen().locator('#team-roster-q').fill('atletico');
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-roster tbody')?.querySelectorAll('tr').length === 1);
    await screen().locator('#team-roster-sort').selectOption('goals');
    assert((await screen().locator('.team-roster tbody').innerText()).includes('A Zero Átlético'));
    await screen().locator('#team-roster-q').fill('');
    await screen().locator('#team-roster-sort').selectOption('name');
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-roster tbody')?.querySelectorAll('tr').length === 40);
    await screen().locator('#team-roster-next').click();
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-roster tbody')?.querySelectorAll('tr').length === 3);
    await screen().locator('.team-campaign select').selectOption(opponent);
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-campaign svg')?.querySelectorAll('g').length === 2);
    await screen().locator('.team-campaign button[value="position"]').click();
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-campaign svg a')?.getAttribute('aria-label')?.endsWith(', 1'));
    await screen().locator('.team-campaign button[value="points"]').click();
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-campaign svg a')?.getAttribute('aria-label')?.endsWith(', 3'));
    await screen().locator('.team-campaign button[value="position"]').click();
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-campaign svg a')?.getAttribute('aria-label')?.endsWith(', 1'));
    const gameLink=await screen().locator('.team-campaign svg a').first().getAttribute('href');
    assert(gameLink?.endsWith(await fixtureAddress('game', campaignGame, psql)),'campaign points link to their actual match');

    await screen().locator('.team-switch select').selectOption(await fixtureAddress('team', opponent, psql));
    await screen().locator('.team-switch button').click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${opponent}/${currentChamp}**`, psql));
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) h1')?.textContent?.includes('Split Opponent'));
    await screen().locator('.team-switch select').selectOption(await fixtureAddress('team', team, psql));
    await screen().locator('.team-switch button').click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${team}/${currentChamp}**`, psql));
    await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .team-roster tbody')?.querySelectorAll('tr').length === 3);

    await screen().locator('.team-championship-links a[data-route="equipe"]').click();
    await page.waitForURL(await fixturePath(`**/equipe/${team}**`, psql));
    await screen().locator(`.team-current-championships a[data-param-championship="${await fixtureAddress("championship", opponentChamp, psql)}"]`).click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${team}/${opponentChamp}**`, psql));
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 1);
    assertEquals(await screen().locator(".team-next .game-row").count(), 1);
    assertEquals(await screen().locator(".team-standings h3").allTextContents(), ["Other Phase · Other Team Group"]);
    assertEquals(await screen().locator(".team-odds .team-odds-table tbody tr").count(), 1);
    assert(/12/.test(await screen().locator(".team-odds").innerText()));
    await screen().locator('.team-championship-links a[data-route="equipe"]').click();
    await page.waitForURL(await fixturePath(`**/equipe/${team}**`, psql));
    await screen().locator(`.team-current-championships a[data-param-championship="${await fixtureAddress("championship", currentChamp, psql)}"]`).click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${team}/${currentChamp}**`, psql));
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 3);
    assertEquals(await screen().locator(".team-roster .archive-pager .page-status b").textContent(), "2", "each championship keeps its own page offset");
    await screen().locator('.team-championship-links a[data-route="equipe"]').click();
    await page.waitForURL(await fixturePath(`**/equipe/${team}**`, psql));
    await screen().locator(`.team-past-championships a[data-param-championship="${await fixtureAddress("championship", pastChamp, psql)}"]`).click();
    await page.waitForURL(await fixturePath(`**/equipe-campeonato/${team}/${pastChamp}**`, psql));
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 2);
    assertEquals(await screen().locator(".team-next .game-row").count(), 0);
    assertEquals(await screen().locator(".team-results .game-row").count(), 1);
    const awayFixture = screen().locator(`.team-results .fixture-row[data-game-id="${pastGame}"]`);
    assertEquals(await awayFixture.locator('.home .team-name').textContent(), 'Split Opponent');
    assertEquals(await awayFixture.locator('.away .team-name').textContent(), 'Split Target');
    assertEquals(await awayFixture.locator('.score b').allTextContents(), ['0', '2'], 'away fixtures retain actual home-first scores');
    assertEquals(await screen().locator(".team-standings .standings tbody tr").count(), 0);
    assertEquals(await screen().locator(".team-standings h3").count(), 0);
    assertEquals(await screen().locator(".team-odds .team-odds-table tbody tr").count(), 0);
    assert((await screen().locator(".team-standings").innerText()).length > 0, "an untracked table shows its honest empty state");
    assert((await screen().locator(".team-odds").innerText()).length > 0, "uncomputed probabilities show their honest empty state");

    await page.goto(`${base}${await fixturePath(`/equipe-campeonato/${team}/${missingChamp}?lang=pt-BR`, psql)}`);
    await screen().locator('.screen[data-state="empty"]').waitFor();
    assert((await screen().locator(".team-membership").innerText()).includes("Esta equipe não está registrada neste campeonato."));

    const longTeamName = 'Associação Atlética Internacional de São João da Boa Vista';
    await psql(`UPDATE team SET name=${q(longTeamName)} WHERE id=${q(opponent)};
      UPDATE standing SET team_name=${q(longTeamName)} WHERE team_id=${q(opponent)};`);
    await visit(page, `/equipe-campeonato/${team}/${currentChamp}?lang=pt-BR`);
    const longName = screen().locator('.team-next a.team-name').filter({ hasText: longTeamName }).first();
    await longName.waitFor();
    assertEquals(await longName.getAttribute('title'), longTeamName, 'hover exposes the full name');
    assertEquals(await longName.getAttribute('data-param-slug'), await fixtureAddress('team', opponent, psql));
    assertEquals(await longName.getAttribute('data-param-championship'), await fixtureAddress('championship', currentChamp, psql));
    assertEquals(await longName.evaluate((name: HTMLElement) => getComputedStyle(name, '::after').content), 'none', 'names reserve no space for arrows');

    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, `/equipe-campeonato/${team}/${currentChamp}?lang=pt-BR`);
    await page.waitForFunction(() =>
      document.querySelector(".shell-screen:not([hidden])")?.querySelectorAll(".team-roster .squad-table tbody tr").length === 40);
    await page.waitForFunction(() => document.documentElement.lang === "pt-BR");
    await screen().locator('.team-section-links a[href$="#team-roster"]').click();
    await screen().locator('.masthead .langs a[data-locale="en-GB"]').click();
    await page.waitForURL(await fixturePath(`**/en/team-championship/${team}/${currentChamp}`, psql));
    await page.waitForFunction(() => document.documentElement.lang === "en-GB");
    assertEquals(new URL(page.url()).pathname, await fixturePath(`/en/team-championship/${team}/${currentChamp}`, psql));
    await screen().locator('.team-section-links a[href$="#team-roster"]').click();
    assertEquals(new URL(page.url()).pathname, await fixturePath(`/en/team-championship/${team}/${currentChamp}`, psql));
    assertEquals(new URL(page.url()).hash, "#team-roster", "translated section navigation preserves the championship");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page fits a phone without horizontal overflow");
    await screen().locator(".team-roster .squad-table tbody tr").first().waitFor();
    assert((await screen().locator(".team-roster .squad-table tbody tr").first().innerText()).includes("A Zero Átlético"), "long player names remain readable on a phone");
    const phoneName = screen().locator('.team-next a.team-name').filter({ hasText: longTeamName }).first();
    await phoneName.waitFor();
    const metrics = await phoneName.evaluate((name: HTMLElement) => {
      const style = getComputedStyle(name);
      return { whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, clipped: name.scrollWidth > name.clientWidth };
    });
    assertEquals(metrics, { whiteSpace: 'nowrap', overflow: 'hidden', ellipsis: 'ellipsis', clipped: true }, 'long fixture names visibly truncate on phones');
    assertEquals(await phoneName.getAttribute('title'), longTeamName);
    await psql(`UPDATE game SET home_id=${q(opponent)},away_id=${q(team)} WHERE id=${q(currentGame)};
      UPDATE team_game SET side='away' WHERE team_id=${q(team)} AND game_id=${q(currentGame)};`);
    await visit(page, `/en/team-championship/${team}/${currentChamp}`);
    const homeName = screen().locator(`.team-next .fixture-row[data-game-id="${currentGame}"] .home .team-name`);
    await page.waitForFunction((name: string) => document.querySelector('.shell-screen:not([hidden]) .team-next .home .team-name')?.textContent === name, longTeamName);
    assertEquals(await homeName.getAttribute('title'), longTeamName);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long home names never cause horizontal scrolling');
    const standingName = screen().locator('.team-standings a.team-name').filter({ hasText: longTeamName }).first();
    const standingMetrics = await standingName.evaluate((name: HTMLElement) => ({ clipped: name.scrollWidth > name.clientWidth, whiteSpace: getComputedStyle(name).whiteSpace }));
    assertEquals(standingMetrics, { clipped: true, whiteSpace: 'nowrap' }, 'long standings names truncate inside their allocated column');
    assertEquals(await standingName.getAttribute('title'), longTeamName);
    await standingName.click();
    await page.waitForURL(await fixturePath(`**/en/team-championship/${opponent}/${currentChamp}`, psql));
  } finally {
    await context.close();
    await browser.close();
    await removeFixtures();
  }
});

globalThis.addEventListener("unload", () => browser.close());
