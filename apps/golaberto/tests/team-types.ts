/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project === "golaberto") {
  throw new Error("team type fixtures require an explicit disposable check/test compose project");
}
const psql = async (sql: string) => {
  const process = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
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
const locales = ["pt-BR", "en-GB", "es-AR", "it-IT", "de-DE", "fr-FR"];
const localeMessages = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
  locale,
  JSON.parse(await Deno.readTextFile(`messages/${locale}.json`)),
])));

Deno.test("all six locale catalogs translate the team type selector", () => {
  for (const locale of locales) {
    const messages = localeMessages[locale];
    for (const key of ["teams_type", "teams_clubs", "teams_national"]) {
      assert(typeof messages[key] === "string" && messages[key].length > 0, `${locale} must translate ${key}`);
    }
  }
});

Deno.test("team directory refresh projects source type and uses the typed order index", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const ratingIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const [club, national] = ids;
  const [oldRating, latestClubRating, nationalRating] = ratingIds;
  const output = await psql(`BEGIN;
    INSERT INTO team (id,name,city,country,team_type) VALUES
      (${quote(club)},'Type projection club','Berlin','Germany','club'),
      (${quote(national)},'Type projection national','Berlin','Germany','national');
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES
      (${quote(oldRating)},${quote(club)},'2025-01-01',1,1,90),
      (${quote(latestClubRating)},${quote(club)},'2026-01-01',1,1,12.5),
      (${quote(nationalRating)},${quote(national)},'2026-01-01',1,1,20);
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT team_type FROM team_directory WHERE id='${club}') IS DISTINCT FROM 'club'
        OR (SELECT team_type FROM team_directory WHERE id='${national}') IS DISTINCT FROM 'national'
        THEN RAISE EXCEPTION 'directory type must project Team.team_type'; END IF;
      IF (SELECT rating FROM team_directory WHERE id='${club}') IS DISTINCT FROM 12.5::portable_double
        OR (SELECT measure_date FROM team_directory WHERE id='${club}') IS DISTINCT FROM '2026-01-01'::portable_date
        THEN RAISE EXCEPTION 'type projection must retain the latest stored rating'; END IF;
      IF (SELECT country_id||'|'||region_id FROM team_directory WHERE id='${club}') <> 'de|europe'
        THEN RAISE EXCEPTION 'type projection must retain geography fields'; END IF;
    END $$;
    CREATE TEMP TABLE team_type_directory_writes (id uuid);
    CREATE FUNCTION pg_temp.record_team_type_directory_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO team_type_directory_writes VALUES (CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER team_type_directory_change_probe AFTER INSERT OR UPDATE OR DELETE ON team_directory
      FOR EACH ROW EXECUTE FUNCTION pg_temp.record_team_type_directory_write();
    SELECT refresh_team_directory();
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM team_type_directory_writes)
      THEN RAISE EXCEPTION 'an unchanged type refresh wrote projection rows'; END IF; END $$;
    UPDATE team SET team_type='national' WHERE id='${club}';
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT team_type FROM team_directory WHERE id='${club}') IS DISTINCT FROM 'national'
        THEN RAISE EXCEPTION 'source type changes must update the directory projection'; END IF;
      IF NOT EXISTS (SELECT 1 FROM team_type_directory_writes WHERE id='${club}')
        THEN RAISE EXCEPTION 'changed source type must write its projection row'; END IF;
    END $$;
    SET LOCAL enable_seqscan=off;
    EXPLAIN (COSTS OFF) SELECT id FROM team_directory WHERE team_type='club'
      ORDER BY rating DESC NULLS LAST,name,id LIMIT 40;
    ROLLBACK;`);
  assert(output.includes("team_directory_by_type_rating"), "exact type plus rating order should use the matching index");
  assert(!output.includes("Sort"), "exact type query should not add a sort");
});

const { chromium } = await import("npm:playwright@1.59.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(".");
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const prefix = `Type${tag}`;
const teamIds = Array.from({ length: 43 }, () => crypto.randomUUID());
const userId = crypto.randomUUID();
const handle = `team-type-${tag}`;
const geography = JSON.parse(await psql(`SELECT json_build_object(
  'region', (SELECT id FROM geography_region WHERE id='europe'),
  'country', (SELECT id FROM geography_country WHERE lower(name)='germany'))`));

for (const width of [390, 1366]) {
  Deno.test(`team type filter, paging, and tab navigation at ${width}px`, async () => {
    const browser = await chromium.launch();
    try {
      const values = teamIds.map((id, i) => {
        const type = i < 41 ? "club" : "national";
        const name = `${prefix} ${type === "club" ? `Club ${String(i).padStart(2, "0")}` : `National ${i - 41}`}`;
        return `(${quote(id)},${quote(name)},'Berlin','Germany',${quote(type)})`;
      });
      const ratings = teamIds.map((id, i) => {
        const rating = i < 41 ? 80 - i : 95 - (i - 41) * 5;
        return `(${quote(crypto.randomUUID())},${quote(id)},'2026-01-01',1,1,${rating})`;
      });
      await psql(`BEGIN;
        INSERT INTO team (id,name,city,country,team_type) VALUES ${values.join(",")};
        INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES ${ratings.join(",")};
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
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/crud/team_directory") requests.push(url);
      });
      await page.goto(`${base}/equipes?lang=pt-BR`);
      await page.waitForSelector("#teams-type");
      const controlIds = ["teams-q", "teams-country-open", "teams-region", "teams-type"];
      const controlOrder = await page.locator(".filters [id]").evaluateAll((elements, ids) =>
        elements.map((element) => element.id).filter((id) => ids.includes(id)), controlIds);
      assertEquals(controlOrder, controlIds, "reading and keyboard order follows name, country, region, type");
      const positions = await page.evaluate((ids) => ids.map((id) => {
        const rect = document.getElementById(id)!.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      }), controlIds);
      for (let i = 1; i < positions.length; i++) {
        assert(positions[i].y > positions[i - 1].y ||
          (positions[i].y === positions[i - 1].y && positions[i].x > positions[i - 1].x),
          "wrapped visual order must follow the reading order");
      }
      const typeSelect = page.locator("#teams-type");
      const countryOpen = page.locator("#teams-country-open");
      const countryPop = page.locator("#teams-country-pop");
      const openCountries = async () => {
        if (!(await countryPop.isVisible())) await countryOpen.click();
        await countryPop.waitFor({ state: "visible" });
      };
      const chooseCountry = async (id: string) => {
        await openCountries();
        await page.locator(`#teams-country-options button[value="${id}"]`).click();
        await countryPop.waitFor({ state: "hidden" });
      };
      const waitForIds = async (expectedIds: string[]) => {
        await page.waitForFunction((expected) => {
          const actual = [...document.querySelectorAll<HTMLAnchorElement>('.catalog-table a[data-route="equipe"]')]
            .map((link) => link.getAttribute("data-param-id"));
          return JSON.stringify(actual) === JSON.stringify(expected);
        }, expectedIds);
        const actual = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) =>
          links.map((link) => link.getAttribute("data-param-id")));
        assertEquals(actual, expectedIds);
      };
      const waitForResponse = (criteria: Record<string, string>) => page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/crud/team_directory" && Object.entries(criteria).every(([key, value]) => url.searchParams.get(key) === value);
      });
      const queryBase = {
        search_key: `like.*${prefix}*`,
        region_id: `like.${geography.region}`,
        country_id: `like.${geography.country}`,
      };
      const filters = (type: string, offset: number) => ({ ...queryBase, team_type: `eq.${type}`, offset: String(offset) });
      const firstClubIds = teamIds.slice(0, 40);
      const secondClubIds = [teamIds[40]];
      const nationalIds = [teamIds[41], teamIds[42]];

      assertEquals(await typeSelect.inputValue(), "club", "clubs should be the default team type");
      assertEquals(await typeSelect.locator("option").count(), 2);
      const initial = waitForResponse(filters("club", 0));
      const initialProbe = waitForResponse({ ...filters("club", 40), limit: "1" });
      await page.fill("#teams-q", prefix);
      await page.locator("#teams-region").focus();
      await page.selectOption("#teams-region", geography.region);
      const exactCountryResponse = waitForResponse({ ...filters("club", 0), country_id: `like.${geography.country}` });
      await chooseCountry(geography.country);
      assert((await exactCountryResponse).ok(), "choosing a catalog country applies its exact id");
      assert((await initial).ok(), "default club directory query should succeed");
      await waitForIds(firstClubIds);
      assert((await initialProbe).ok(), "club next-page probe should use the same exact type and geography filters");
      assert(requests.some((url) => url.searchParams.get("team_type") === "eq.club" && url.searchParams.get("offset") === "40" && url.searchParams.get("limit") === "1" && url.searchParams.get("region_id") === `like.${geography.region}` && url.searchParams.get("country_id") === `like.${geography.country}`), "the next probe carries type and both geography selections");
      await page.click("#teams-next");
      await waitForIds(secondClubIds);

      const nationalResponse = waitForResponse(filters("national", 0));
      await typeSelect.focus();
      await typeSelect.selectOption("national");
      assert((await nationalResponse).ok(), "switching type should query national teams from page one");
      await waitForIds(nationalIds);
      assertEquals(await page.locator("#teams-q").inputValue(), prefix, "type change preserves the name search");
      assertEquals(await page.locator("#teams-region").inputValue(), geography.region, "type change preserves region selection");
      assertEquals(await countryOpen.getAttribute("data-country-selection"), geography.country, "type change preserves the exact country selection");
      assert(requests.some((url) => url.searchParams.get("team_type") === "eq.club" && url.searchParams.get("limit") === "1"), "the next probe carries the selected type");
      assert(requests.filter((url) => url.pathname === "/crud/team_directory").every((url) => url.searchParams.get("team_type") === "eq.club" || url.searchParams.get("team_type") === "eq.national"), "every list and probe request carries one exact team type");

      await page.locator('.catalog-table a[data-route="equipe"]').first().click();
      await page.waitForURL((url) => url.pathname.startsWith("/equipe/"));
      await page.goBack();
      await waitForIds(nationalIds);
      assertEquals(await typeSelect.inputValue(), "national", "selected type survives detail/back navigation");
      assertEquals(await page.locator("#teams-q").inputValue(), prefix);
      assertEquals(await page.locator("#teams-region").inputValue(), geography.region);
      assertEquals(await countryOpen.getAttribute("data-country-selection"), geography.country);

      await typeSelect.focus();
      await page.selectOption("#teams-type", "club");
      await waitForIds(firstClubIds);
      const nameResponse = waitForResponse({ ...filters("club", 0), search_key: `like.*${prefix} Club*` });
      await page.fill("#teams-q", `${prefix} Club`);
      assert((await nameResponse).ok(), "name filtering remains combined with type and geography");
      await waitForIds(firstClubIds);
      assert(requests.some((url) => url.searchParams.get("team_type") === "eq.club" && url.searchParams.get("search_key") === `like.*${prefix} Club*`), "name search retains its exact type predicate");
      if (width < 600) {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "type and geography filters should not create horizontal overflow on a phone");
      }
    } finally {
      await browser.close();
      await psql(`BEGIN; DELETE FROM team WHERE id IN (${teamIds.map(quote).join(",")}); DELETE FROM app_user WHERE id=${quote(userId)}; COMMIT;`);
    }
  });
}
