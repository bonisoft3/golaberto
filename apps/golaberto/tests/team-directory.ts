/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project === "golaberto") {
  throw new Error("team-directory fixtures require an explicit disposable check/test compose project");
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
const fixtureIds = Array.from({ length: 5 }, () => crypto.randomUUID()).sort();
const [equalA, equalB, future, zero, unrated] = fixtureIds;
const ratingIds = Array.from({ length: 6 }, () => crypto.randomUUID()).sort();
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const mapSearchEquivalences = (value: string) => value.replaceAll("ı", "i").replaceAll("þ", "th").replaceAll("Þ", "th");

Deno.test("team directory refresh chooses latest stored ratings and changes only changed rows", async () => {
  const output = await psql(`BEGIN;
    INSERT INTO team (id,name,city,country) VALUES
      (${quote(equalA)},'Equal','First City','Brasil'),
      (${quote(equalB)},'Equal','Second City','Brasil'),
      (${quote(future)},'Future Club','Future City','Brasil'),
      (${quote(zero)},'Zero Club','Zero City','Brasil'),
      (${quote(unrated)},'Unrated Club','', 'Brasil');
    INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES
      (${quote(ratingIds[0])},${quote(future)},'2020-01-01',1,1,99),
      (${quote(ratingIds[1])},${quote(future)},'2099-01-01',1,1,20),
      (${quote(ratingIds[2])},${quote(future)},'2099-01-01',1,1,30),
      (${quote(ratingIds[3])},${quote(equalA)},'2098-01-01',1,1,8),
      (${quote(ratingIds[4])},${quote(equalB)},'2098-01-01',1,1,8),
      (${quote(ratingIds[5])},${quote(zero)},'2098-01-01',1,1,0);
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT rating FROM team_directory WHERE id='${future}') IS DISTINCT FROM 20::portable_double
        THEN RAISE EXCEPTION 'latest date/id rating should win, regardless of an older maximum or future date'; END IF;
      IF (SELECT rating_display FROM team_directory WHERE id='${future}') <> '20.00'
        THEN RAISE EXCEPTION 'rated teams should have a two-decimal display value'; END IF;
      IF (SELECT rating FROM team_directory WHERE id='${unrated}') IS NOT NULL
        OR (SELECT rating_display FROM team_directory WHERE id='${unrated}') <> '—'
        THEN RAISE EXCEPTION 'unrated team should retain a null rating and dash display'; END IF;
      IF (SELECT rating FROM team_directory WHERE id='${zero}') IS DISTINCT FROM 0::portable_double
        OR (SELECT rating_display FROM team_directory WHERE id='${zero}') <> '0.00'
        THEN RAISE EXCEPTION 'zero rating should remain distinct from unrated'; END IF;
      IF (SELECT array_agg(id ORDER BY rating DESC NULLS LAST,name,id) FROM team_directory WHERE id IN ('${equalA}','${equalB}'))
        IS DISTINCT FROM ARRAY['${equalA}'::uuid,'${equalB}'::uuid]
        THEN RAISE EXCEPTION 'equal ratings should sort by name and id'; END IF;
      IF (SELECT array_agg(id ORDER BY rating DESC NULLS LAST,name,id)
          FROM team_directory WHERE id IN ('${equalA}','${equalB}','${future}','${zero}','${unrated}'))
        IS DISTINCT FROM ARRAY['${future}'::uuid,'${equalA}'::uuid,'${equalB}'::uuid,'${zero}'::uuid,'${unrated}'::uuid]
        THEN RAISE EXCEPTION 'directory order should be rating descending, null last, then name and id'; END IF;
    END $$;
    CREATE TEMP TABLE team_directory_writes (id uuid);
    CREATE FUNCTION pg_temp.record_team_directory_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO team_directory_writes VALUES (CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER team_directory_change_probe AFTER INSERT OR UPDATE OR DELETE ON team_directory
      FOR EACH ROW EXECUTE FUNCTION pg_temp.record_team_directory_write();
    SELECT refresh_team_directory();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM team_directory_writes)
      THEN RAISE EXCEPTION 'an unchanged refresh wrote projection rows'; END IF; END $$;
    UPDATE team SET city='Updated City' WHERE id='${future}';
    DELETE FROM team_rating WHERE id=${quote(ratingIds[1])};
    DELETE FROM team WHERE id='${unrated}';
    SELECT refresh_team_directory();
    DO $$ BEGIN
      IF (SELECT rating FROM team_directory WHERE id='${future}') IS DISTINCT FROM 30::portable_double
        THEN RAISE EXCEPTION 'deleting the latest rating should fall back to the next stored rating'; END IF;
      IF (SELECT city FROM team_directory WHERE id='${future}') <> 'Updated City'
        THEN RAISE EXCEPTION 'source edits should refresh projected fields'; END IF;
      IF EXISTS (SELECT 1 FROM team_directory WHERE id='${unrated}')
        THEN RAISE EXCEPTION 'deleted source teams should be removed from the projection'; END IF;
    END $$;
    SET LOCAL ROLE service;
    SELECT refresh_team_directory();
    RESET ROLE;
    SET LOCAL app.scopes='public:';
    SET LOCAL ROLE app_user;
    DO $$ BEGIN
      IF (SELECT count(*) FROM team_directory WHERE id IN ('${equalA}','${equalB}','${future}','${zero}')) <> 4
        THEN RAISE EXCEPTION 'app users should read public projection rows'; END IF;
      UPDATE team_directory SET rating=999 WHERE id='${zero}';
      IF FOUND THEN RAISE EXCEPTION 'app users must not write projection rows'; END IF;
    END $$;
    RESET ROLE;
    SELECT json_build_array(
      has_function_privilege('service','refresh_team_directory()','EXECUTE'),
      has_function_privilege('anon','refresh_team_directory()','EXECUTE'),
      has_function_privilege('app_user','refresh_team_directory()','EXECUTE'),
      EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_default' AND tablename='team_directory'),
      EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND tablename='team_directory'));
    ROLLBACK;`);
  assertEquals(JSON.parse(output), [true, false, false, true, false]);
});

const { chromium } = await import("npm:playwright@1.59.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(".");
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const prefix = `Directory${tag}`;
const teamIds = Array.from({ length: 42 }, () => crypto.randomUUID());
const userId = crypto.randomUUID();
const handle = `directory-${tag}`;

for (const width of [390, 1366]) {
  Deno.test(`team directory filters, paging, and persistence at ${width}px`, async () => {
    const browser = await chromium.launch();
    try {
      const values = teamIds.map((id, i) => {
        const name = `${prefix} ${i < 4 ? "Atlético" : "Other"} ${String(i).padStart(2, "0")}`;
        const countries = ["Colômbia", "Colômbia", "Colômbia", "Colômbia", "Iceland", "ıceland", "Þorland", "Thorland", "Ærø", "Aero"];
        const country = quote(countries[i] ?? "Brasil");
        const city = i === 2 ? "A very long city name that should wrap safely inside the team directory" : `City ${i}`;
        return `(${quote(id)},${quote(name)},${quote(city)},${country})`;
      });
      await psql(`BEGIN; INSERT INTO team (id,name,city,country) VALUES ${values.join(",")};
        INSERT INTO team_rating (id,team_id,measure_date,offense,defense,rating) VALUES
        ('${crypto.randomUUID()}',${quote(teamIds[0])},'2026-01-01',1,1,0),
        ('${crypto.randomUUID()}',${quote(teamIds[1])},'2026-01-01',1,1,12.345),
        ('${crypto.randomUUID()}',${quote(teamIds[2])},'2026-01-01',1,1,55);
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
      await page.waitForSelector("#teams-q");
      const waitForRows = async (count: number) => page.waitForFunction((expected) =>
        document.querySelectorAll('.catalog-table a[data-route="equipe"]').length === expected, count);
      const query = async (name: string, country: string, expectedIds: string[]) => {
        const response = page.waitForResponse((r) => {
          const url = new URL(r.url());
          return url.pathname === "/crud/team_directory" &&
            url.searchParams.get("search_key") === `like.*${mapSearchEquivalences(name)}*` &&
            url.searchParams.get("country_search_key") === `like.*${mapSearchEquivalences(country)}*`;
        });
        await page.fill("#teams-q", name);
        await page.fill("#teams-country", country);
        assert((await response).ok(), "combined name and country search should succeed");
        await page.waitForFunction((expected) => {
          const actual = [...document.querySelectorAll<HTMLAnchorElement>('.catalog-table a[data-route="equipe"]')]
            .map((link) => new URL(link.href).pathname.split("/").at(-1));
          return JSON.stringify(actual) === JSON.stringify(expected);
        }, expectedIds);
        const actualIds = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLAnchorElement).href).pathname.split("/").at(-1)));
        assertEquals(actualIds, expectedIds);
      };

      await query(`${prefix} atletico`, "colombia", [teamIds[2], teamIds[1], teamIds[0], teamIds[3]]);
      await query(`${prefix} ATLÉTICO`, "COLÔMBIA", [teamIds[2], teamIds[1], teamIds[0], teamIds[3]]);
      await query(`${prefix} atletico`, "colo\u0302mbia", [teamIds[2], teamIds[1], teamIds[0], teamIds[3]]);
      await query(prefix, "ıceland", [teamIds[4], teamIds[5]]);
      await query(prefix, "ICELAND", [teamIds[4], teamIds[5]]);
      await query(prefix, "þorland", [teamIds[6], teamIds[7]]);
      await query(prefix, "THORLAND", [teamIds[6], teamIds[7]]);
      await query(prefix, "AERO", [teamIds[8], teamIds[9]]);
      await query(`${prefix} atletico`, "colombia", [teamIds[2], teamIds[1], teamIds[0], teamIds[3]]);
      const rows = page.locator(".catalog-table tbody tr");
      const firstRow = rows.nth(0);
      const cityCell = firstRow.locator("td").nth(2);
      if (width < 600) assertEquals(await cityCell.isVisible(), false, "city should be hidden on a phone-width layout");
      else assert(await cityCell.textContent().then((v) => v?.includes("very long city name")), "long city names should remain readable on wide layouts");
      if (width < 600) assert(await firstRow.evaluate((row) => row.scrollWidth <= row.clientWidth), "long city values should not create horizontal overflow on a phone");
      assert(await firstRow.locator("td").nth(3).textContent().then((v) => v?.includes("Colômbia")), "country remains visible in the directory");
      assertEquals(await rows.nth(2).locator("td").nth(1).textContent(), "0.00", "zero rating should render in its rating cell with two decimals");
      assert((await page.locator("body").innerText()).includes("12.35"), "rating display should show the generated two-decimal value");

      await page.fill("#teams-country", "");
      await waitForRows(4);
      await page.fill("#teams-q", prefix);
      await waitForRows(40);
      const firstPage = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname));
      await page.click("#teams-next");
      await waitForRows(2);
      const tail = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname));
      assertEquals(new Set([...firstPage, ...tail]).size, 42, "pager should traverse all matches with a one-row next probe");
      await query(`${prefix} atletico`, "", [teamIds[2], teamIds[1], teamIds[0], teamIds[3]]);
      assert(requests.some((url) => url.searchParams.get("search_key") === `like.*${prefix} atletico*` && url.searchParams.get("offset") === "0"), "changing name on page two resets the offset");
      await page.fill("#teams-q", prefix);
      await waitForRows(40);
      await page.click("#teams-next");
      await waitForRows(2);
      const countryResponse = page.waitForResponse((r) => {
        const url = new URL(r.url());
        return url.pathname === "/crud/team_directory" &&
          url.searchParams.get("search_key") === `like.*${prefix}*` &&
          url.searchParams.get("country_search_key") === "like.*colombia*";
      });
      await page.fill("#teams-country", "colombia");
      assert((await countryResponse).ok(), "changing country on page two should issue the combined filtered query");
      await waitForRows(4);
      const countryFilteredIds = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) =>
        links.map((link) => new URL((link as HTMLAnchorElement).href).pathname.split("/").at(-1)));
      assertEquals(countryFilteredIds, [teamIds[2], teamIds[1], teamIds[0], teamIds[3]], "changing country should reset pagination to the first page");
      await page.locator('.catalog-table a[data-route="equipe"]').first().click();
      await page.waitForURL((url) => url.pathname.startsWith("/equipe/"));
      await page.goBack();
      await waitForRows(4);
      assertEquals(await page.locator("#teams-q").inputValue(), prefix, "search state should survive back navigation");
      assertEquals(await page.locator("#teams-country").inputValue(), "colombia", "country filter should survive back navigation");
      assert(requests.some((url) => url.searchParams.get("limit") === "40"), "directory reads should request at most forty rows");
      assert(requests.some((url) => url.searchParams.get("limit") === "1"), "directory paging should use a separate one-row next probe");
      for (const url of requests) assert(Number(url.searchParams.get("limit")) <= 40, "directory requests should stay bounded");

      await page.fill("#teams-country", "");
      await waitForRows(40);
      await page.fill("#teams-q", `${prefix} unmatched`);
      await waitForRows(0);
      await page.fill("#teams-q", `${prefix} Other`);
      await waitForRows(38);
      const emptyRating = await psql(`SELECT rating_display FROM team_directory WHERE id='${teamIds[3]}';`);
      assertEquals(emptyRating, "—", "unrated display should be a dash");
      assert((await page.locator(".catalog-table").innerText()).includes("—"), "unrated teams should show the dash in the directory");
    } finally {
      await browser.close();
      await psql(`BEGIN; DELETE FROM team WHERE id IN (${teamIds.map(quote).join(",")}); DELETE FROM app_user WHERE id=${quote(userId)}; COMMIT;`);
    }
  });
}
