/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test|prs)/i.test(project) || project === "golaberto") {
  throw new Error("geography fixtures require an explicit disposable check/test compose project");
}
const psql = async (sql: string) => {
  const process = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await process.output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const geographyCatalog = JSON.parse(await Deno.readTextFile("geography.json"));
const locales = ["pt-BR", "en-GB", "es-AR", "it-IT", "de-DE", "fr-FR"];
const localeMessages = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
  locale,
  JSON.parse(await Deno.readTextFile(`messages/${locale}.json`)),
])));

Deno.test("all six locale catalogs translate every fixed geography label", async () => {
  const keys = [...geographyCatalog.regions, ...geographyCatalog.countries].map((entry: { message_key: string }) => entry.message_key);
  for (const locale of ["de-DE", "en-GB", "es-AR", "fr-FR", "it-IT", "pt-BR"]) {
    const messages = JSON.parse(await Deno.readTextFile(`messages/${locale}.json`));
    for (const key of keys) assert(typeof messages[key] === "string" && messages[key].length > 0, `${locale} must translate ${key}`);
  }
});

Deno.test("fixed geography catalog, joins, and read-only access", async () => {
  const unknownId = crypto.randomUUID();
  // The temp table and probe trigger below are this script's scaffolding:
  // pgroll's event trigger would record each as an inferred migration, and two
  // checks recording against one parent fail on its history_is_linear index.
  const output = await psql(`BEGIN;
    SET LOCAL pgroll.no_inferred_migrations = 'TRUE';
    DO $$ BEGIN
      IF (SELECT count(*) FROM geography_region) <> 6 THEN RAISE EXCEPTION 'expected six football regions'; END IF;
      IF (SELECT count(*) FROM geography_country) <> 225 THEN RAISE EXCEPTION 'expected 225 fixed countries'; END IF;
      IF (SELECT count(DISTINCT id) FROM geography_region) <> 6 OR
         (SELECT count(DISTINCT id) FROM geography_country) <> 225 THEN RAISE EXCEPTION 'geography ids must be unique'; END IF;
      IF (SELECT region_id FROM geography_country WHERE lower(name)='australia') IS DISTINCT FROM 'asia' THEN RAISE EXCEPTION 'Australia should be in Asia'; END IF;
      IF (SELECT region_id FROM geography_country WHERE lower(name)='israel') IS DISTINCT FROM 'europe' THEN RAISE EXCEPTION 'Israel should be in Europe'; END IF;
      IF (SELECT region_id FROM geography_country WHERE lower(name)='guyana') IS DISTINCT FROM 'concacaf' THEN RAISE EXCEPTION 'Guyana should be in CONCACAF'; END IF;
      IF (SELECT region_id FROM geography_country WHERE lower(name)='greenland') IS DISTINCT FROM '' THEN RAISE EXCEPTION 'Greenland should have no football region'; END IF;
      IF EXISTS (SELECT 1 FROM geography_country WHERE region_id<>'' AND NOT EXISTS
        (SELECT 1 FROM geography_region WHERE id=geography_country.region_id)) THEN RAISE EXCEPTION 'country references must resolve'; END IF;
    END $$;
    INSERT INTO team (id,name,country) VALUES (${quote(unknownId)},'Geography unknown fixture','Unmappedland');
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT country FROM team_directory WHERE id='${unknownId}') <> 'Unmappedland' THEN RAISE EXCEPTION 'unknown country label must be retained'; END IF;
      IF (SELECT country_id||'|'||region_id FROM team_directory WHERE id='${unknownId}') <> '|' THEN RAISE EXCEPTION 'unknown country must not receive fabricated geography ids'; END IF;
      IF (SELECT country_search_key FROM team_directory WHERE id='${unknownId}') NOT LIKE '%unmappedland%' THEN RAISE EXCEPTION 'unknown country remains searchable'; END IF;
    END $$;
    CREATE TEMP TABLE geography_directory_writes (id uuid);
    CREATE FUNCTION pg_temp.record_geography_directory_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO geography_directory_writes VALUES (CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER geography_directory_change_probe AFTER INSERT OR UPDATE OR DELETE ON team_directory
      FOR EACH ROW EXECUTE FUNCTION pg_temp.record_geography_directory_write();
    SELECT refresh_team_directory();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM geography_directory_writes) THEN RAISE EXCEPTION 'unchanged geography projection refresh wrote rows'; END IF; END $$;
    SELECT json_build_array(
      has_table_privilege('app_user','geography_country','SELECT'),
      has_table_privilege('app_user','geography_region','SELECT'),
      has_table_privilege('app_user','geography_country','INSERT'),
      has_table_privilege('app_user','geography_country','UPDATE'),
      has_table_privilege('app_user','geography_region','INSERT'),
      has_table_privilege('app_user','geography_region','UPDATE'));
    ROLLBACK;`);
  assertEquals(JSON.parse(output), [true, true, false, false, false, false]);
});

const { chromium } = await import("npm:playwright@1.61.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(".");
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const prefix = `Geo${tag}`;
const teamIds = Array.from({ length: 3 }, () => crypto.randomUUID());
const userId = crypto.randomUUID();
const handle = `geo-${tag}`;
const geometry = JSON.parse(await psql(`SELECT json_build_object(
  'asia', (SELECT id FROM geography_region WHERE id='asia'),
  'europe', (SELECT id FROM geography_region WHERE id='europe'),
  'worldless', (SELECT id FROM geography_country WHERE lower(name)='greenland'),
  'germany', (SELECT id FROM geography_country WHERE lower(name)='germany'),
  'brazil', (SELECT id FROM geography_country WHERE lower(name)='brazil'),
  'australia', (SELECT id FROM geography_country WHERE lower(name)='australia'))`));

for (const width of [390, 1366]) {
  Deno.test(`geography filters and fixed options at ${width}px`, async () => {
    const browser = await chromium.launch();
    try {
      await psql(`BEGIN;
        INSERT INTO team (id,name,city,country) VALUES
          (${quote(teamIds[0])},${quote(`${prefix} Deutschland`)},'Berlin','Germany'),
          (${quote(teamIds[1])},${quote(`${prefix} Brasil`)},'São Paulo','Brazil'),
          (${quote(teamIds[2])},${quote(`${prefix} Australia`)},'Sydney','Australia');
        SELECT refresh_team_directory();
        INSERT INTO app_user (id,handle) VALUES (${quote(userId)},${quote(handle)});
        INSERT INTO editor (app_user_id) VALUES (${quote(userId)}); COMMIT;`);
      const token = await new SignJWT({ role: "app_user", handle, guest: false })
        .setProtectedHeader({ alg: "HS256" }).setSubject(userId).setExpirationTime("1h")
        .sign(new TextEncoder().encode(Deno.env.get("PGRST_JWT_SECRET") ?? "mecha-dev-secret-please-override-32ch"));
      const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "pt-BR", viewport: { width, height: 900 } });
      await context.addInitScript((session) => sessionStorage.setItem("pronto-token", JSON.stringify(session)), { token, user: { id: userId, handle } });
      const page = await context.newPage();
      const requests: URL[] = [];
      const geographyRequests: URL[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/crud/team_directory") requests.push(url);
        if (url.pathname === "/crud/geography_country" || url.pathname === "/crud/geography_region") geographyRequests.push(url);
      });
      await page.goto(`${base}/equipes?lang=pt-BR`);
      await page.waitForSelector("#teams-region");
      const waitForTeams = (count: number) => page.waitForFunction((expected) =>
        document.querySelectorAll('.catalog-table a[data-route="equipe"]').length === expected, count);
      const responseFor = (criteria: Record<string, string>) => page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/crud/team_directory" && Object.entries(criteria).every(([key, value]) => url.searchParams.get(key) === value);
      });
      const regionSelect = page.locator("#teams-region");
      const countryOpen = page.locator("#teams-country-open");
      const countryPop = page.locator("#teams-country-pop");
      const countryOptions = page.locator("#teams-country-options");
      const countryText = page.locator("#teams-country");
      const openCountries = async () => {
        if (!(await countryPop.isVisible())) await countryOpen.click();
        await countryPop.waitFor({ state: "visible" });
      };
      const chooseCountry = async (id: string) => {
        await openCountries();
        await countryOptions.locator(`button[value="${id}"]`).click();
        await countryPop.waitFor({ state: "hidden" });
      };

      assertEquals(await regionSelect.inputValue(), "*", "region selector should start at World");
      assertEquals(await countryOpen.innerText(), localeMessages["pt-BR"].geography_all_countries, "country trigger should start at all countries");
      assertEquals(await countryOpen.getAttribute("data-country-selection"), "*", "all countries has no exact selection");
      await openCountries();
      await page.waitForFunction(() => document.querySelectorAll("#teams-country-options button[value]").length === 225);
      assertEquals(await countryOptions.locator("button[value]").count(), 225, "all 225 fixed countries remain available at World");
      assertEquals(await countryOptions.locator(`button[value="${geometry.worldless}"]`).count(), 1, "Greenland remains selectable without a football region");
      await countryOpen.click();
      const nameResponse = responseFor({ search_key: `like.*${prefix}*` });
      await page.fill("#teams-q", prefix);
      assert((await nameResponse).ok());
      await waitForTeams(3);

      await regionSelect.focus();
      await page.selectOption("#teams-region", geometry.asia);
      await waitForTeams(1);
      await openCountries();
      await page.waitForFunction(([australia, germany]) => {
        const values = [...document.querySelectorAll<HTMLButtonElement>("#teams-country-options button[value]")].map((button) => button.value);
        return values.includes(australia) && !values.includes(germany) && values.length > 2;
      }, [geometry.australia, geometry.germany]);
      assert(await countryOptions.locator("button[value]").count().then((count) => count > 2), "region selection narrows the fixed country catalog to Asian countries");
      await countryOpen.click();
      const australiaResponse = responseFor({ country_id: `like.${geometry.australia}` });
      await chooseCountry(geometry.australia);
      assert((await australiaResponse).ok());
      assertEquals(await countryOpen.getAttribute("data-country-selection"), geometry.australia, "choosing a country records its exact id");
      await page.waitForFunction((label) => document.querySelector<HTMLElement>("#teams-country-open")?.innerText.trim() === label, localeMessages["pt-BR"].geography_country_au);
      await waitForTeams(1);
      await openCountries();
      await page.waitForFunction((id) => document.querySelector(`#teams-country-option-${id}`)?.getAttribute("aria-pressed") === "true", geometry.australia);
      assertEquals(await countryOptions.locator('[aria-pressed="true"]').count(), 1, "the reopened list identifies exactly the selected country");
      assertEquals(await countryOptions.locator(`button[value="${geometry.australia}"]`).evaluate((button) => getComputedStyle(button, "::after").content), '"✓"', "the selected country has a visible checkmark");
      await page.locator("#teams-country-all").click();
      await page.waitForFunction(() => document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === "*");
      assertEquals(await countryOpen.getAttribute("data-country-selection"), "*");
      await waitForTeams(1);
      await page.waitForFunction(() => document.querySelectorAll('#teams-country-options [aria-pressed="true"]').length === 0);
      if (await countryPop.isVisible()) await countryOpen.click();
      await chooseCountry(geometry.australia);
      await page.waitForFunction((id) => document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === id, geometry.australia);
      assertEquals(await countryOpen.getAttribute("data-country-selection"), geometry.australia);
      await regionSelect.selectOption(geometry.europe);
      await page.waitForFunction(() => document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === "*");
      assertEquals(await countryOpen.getAttribute("data-country-selection"), "*");
      await waitForTeams(1);
      await regionSelect.selectOption(geometry.asia);
      await waitForTeams(1);
      await chooseCountry(geometry.australia);
      await page.waitForFunction((id) => document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === id, geometry.australia);
      await openCountries();
      await countryText.fill("Germany");
      await waitForTeams(0);
      assertEquals(await countryOpen.getAttribute("data-country-selection"), "*", "typing clears the selected country label and id");
      await waitForTeams(0);
      await countryOpen.click();
      await regionSelect.focus();
      await page.selectOption("#teams-region", geometry.europe);
      await waitForTeams(1);
      assertEquals(await countryText.inputValue(), "", "changing the region dropdown clears typed country text");
      assertEquals(await countryOpen.getAttribute("data-country-selection"), "*", "changing region clears any exact country selection");

      // The country popover supports ordinary keyboard navigation and dismissal.
      await openCountries();
      await countryText.focus();
      await countryText.press("Tab");
      const clearAll = page.locator("#teams-country-all");
      assert(await clearAll.evaluate((button) => button === document.activeElement), "Tab moves from search to the All countries button");
      await page.keyboard.press("Tab");
      const firstOption = countryOptions.locator("button[value]").first();
      await firstOption.waitFor({ state: "visible" });
      assert(await firstOption.evaluate((option) => option === document.activeElement), "Tab moves focus from country search to the first option");
      const keyboardCountry = await firstOption.getAttribute("value");
      assert(keyboardCountry);
      await page.keyboard.press("Enter");
      await countryPop.waitFor({ state: "hidden" });
      await page.waitForFunction((id) => document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === id, keyboardCountry);
      await openCountries();
      if (width < 600) assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "open country popover should fit within a phone viewport");
      await countryText.press("Escape");
      await countryPop.waitFor({ state: "hidden" });
      await openCountries();
      await page.locator("h1").click();
      await countryPop.waitFor({ state: "hidden" });
      if (width < 600) assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "country popover should not create horizontal overflow on a phone");

      const localeRoutes: Record<string, string> = {
        "pt-BR": "/equipes?lang=pt-BR",
        "en-GB": "/en/teams",
        "es-AR": "/es/equipos",
        "it-IT": "/it/squadre",
        "de-DE": "/de/mannschaften",
        "fr-FR": "/fr/equipes",
      };
      for (const locale of locales) {
        await page.goto(`${base}${localeRoutes[locale]}`);
        await page.waitForSelector("#teams-country-open");
        assertEquals(await countryOpen.innerText(), localeMessages[locale].geography_all_countries, `${locale} translates the all-countries trigger`);
        const messages = localeMessages[locale];
        const germanLabel = messages.geography_country_de;
        const europeLabel = messages.geography_region_europe;
        await openCountries();
        assert(await countryOptions.locator("button[value]").allTextContents().then((labels) => labels.includes(germanLabel)), `${locale} renders Germany as ${germanLabel}`);
        assert(await regionSelect.locator("option").allTextContents().then((labels) => labels.includes(europeLabel)), `${locale} renders Europe as ${europeLabel}`);
        await countryOpen.click();
        await page.fill("#teams-q", prefix);
        await waitForTeams(3);
        await openCountries();
        await countryText.fill(germanLabel);
        await waitForTeams(1);
        const germanyId = await page.locator('.catalog-table a[data-route="equipe"]').evaluate((link) =>
          link.closest("[data-id]")?.getAttribute("data-id"));
        assertEquals(germanyId, teamIds[0], `${locale} country search returns the Germany fixture`);
        await countryOptions.locator(`button[value="${geometry.germany}"]`).click();
        await countryPop.waitFor({ state: "hidden" });
        await page.waitForFunction(([id, label]) =>
          document.querySelector("#teams-country-open")?.getAttribute("data-country-selection") === id &&
          document.querySelector<HTMLElement>("#teams-country-open")?.innerText.trim() === label,
        [geometry.germany, germanLabel]);
      }

      assert(requests.some((url) => url.searchParams.get("search_key") === `like.*${prefix}*`), "name search continues to combine with geography filters");
      assert(requests.every((url) => !url.searchParams.has("region_search_key")), "region filtering uses only the native region selector");
      assert(requests.some((url) => url.searchParams.get("country_id") === `like.${geometry.australia}`));
      assert(requests.some((url) => url.searchParams.get("region_id") === `like.${geometry.asia}`));
      assert(requests.every((url) => Number(url.searchParams.get("limit")) <= 40), "directory reads stay bounded");
      assert(geographyRequests.some((url) => url.pathname === "/crud/geography_country"));
      assert(geographyRequests.filter((url) => url.pathname === "/crud/geography_country").every((url) => Number(url.searchParams.get("limit")) <= 250), "fixed country reads stay at or below 250");
      for (const url of geographyRequests.filter((url) => url.pathname === "/crud/geography_region")) {
        assert(Number(url.searchParams.get("limit")) <= 6, "fixed region reads stay at or below six");
      }
    } finally {
      await browser.close();
      await psql(`BEGIN; DELETE FROM team WHERE id IN (${teamIds.map(quote).join(",")}); DELETE FROM app_user WHERE id=${quote(userId)}; COMMIT;`);
    }
  });
}
