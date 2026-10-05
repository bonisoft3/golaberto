/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(check|test)/i.test(project) || project === "golaberto") {
  throw new Error("accent-search fixtures require an explicit disposable check/test compose project");
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
const variants = ["atletico", "atlético", "ATLÉTICO", "atle\u0301tico"];

for (const baseline of [false, true]) {
  Deno.test(`search migration upgrades ${baseline ? "declared baseline" : "retained tables"} and replays`, async () => {
    const migration = (await Deno.readTextFile("services/database/sql/023_search_collation.sql"))
      .replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n");
    const output = await psql(`BEGIN;
      CREATE SCHEMA accent_search_probe;
      SET LOCAL search_path = accent_search_probe, public;
      CREATE TABLE championship (name portable_string, region_name portable_string, begins date, ends date);
      CREATE TABLE team (name portable_string);
      CREATE TABLE stadium (name portable_string);
      CREATE TABLE referee (name portable_string);
      ${baseline ? `ALTER TABLE championship ADD COLUMN search_name portable_string GENERATED ALWAYS AS
        (region_name || ' - ' || name || ' ' || extract(year from begins)::int::text ||
        CASE WHEN extract(year from begins) = extract(year from ends) THEN '' ELSE '/' || extract(year from ends)::int::text END) STORED;
        ALTER TABLE team ADD COLUMN search_name portable_string GENERATED ALWAYS AS (name) STORED;
        ALTER TABLE stadium ADD COLUMN search_name portable_string GENERATED ALWAYS AS (name) STORED;
        ALTER TABLE referee ADD COLUMN search_name portable_string GENERATED ALWAYS AS (name) STORED;` : ""}
      INSERT INTO championship (name,region_name,begins,ends) VALUES ('Atlético','Brasil','2026-01-01','2027-12-31'),('Atletico','Brasil','2026-01-01','2027-12-31'),(U&'Atle\\0301tico','Brasil','2026-01-01','2027-12-31');
      INSERT INTO team (name) VALUES ('Atlético'),('Atletico'),(U&'Atle\\0301tico'),('Atlântico');
      INSERT INTO stadium (name) SELECT name FROM team;
      INSERT INTO referee (name) SELECT name FROM team;
      ${migration}
      CREATE VIEW retained_search_view AS SELECT search_name FROM team;
      ${migration}
      ${["championship", "team", "stadium", "referee"].flatMap((table) => variants.map((q) =>
        `SELECT count(*) FROM ${table} WHERE search_name LIKE '%${q}%';`)).join("\n")}
      SELECT count(*) FROM retained_search_view WHERE search_name LIKE '%atletico%';
      SELECT search_name FROM championship WHERE name='Atletico';
      UPDATE team SET name='Renomé' WHERE name='Atlético';
      SELECT count(*) FROM team WHERE search_name LIKE '%renome%';
      SELECT count(*) FROM team WHERE name='Atletico';
      ROLLBACK;`);
    assertEquals(output.split("\n"), [...Array(17).fill("3"), "Brasil - Atletico 2026/2027", "1", "1"]);
  });
}

const searchVariants = [...variants, "atletico i th ae", "atlético ı þ æ", "ATLÉTICO İ Þ Æ"];

for (const baseline of [false, true]) {
  Deno.test(`extended search upgrades ${baseline ? "declared baseline" : "retained version views"} and replays`, async () => {
    const migration = (await Deno.readTextFile("services/database/sql/025_search_letter_equivalences.sql"))
      .replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n");
    const original = (await Deno.readTextFile("services/database/sql/023_search_collation.sql"))
      .replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n");
    const output = await psql(`BEGIN;
      CREATE SCHEMA letter_search_probe;
      SET LOCAL search_path = letter_search_probe, public;
      CREATE TABLE championship (name portable_string, region_name portable_string, begins date, ends date);
      CREATE TABLE team (name portable_string);
      CREATE TABLE stadium (name portable_string);
      CREATE TABLE referee (name portable_string);
      CREATE TABLE team_directory (name portable_string, country portable_string);
      ${original}
      CREATE VIEW previous_version AS SELECT search_name FROM team;
      ALTER TABLE team_directory ADD COLUMN search_name portable_string COLLATE golaberto_search GENERATED ALWAYS AS (name) STORED;
      ALTER TABLE team_directory ADD COLUMN search_country portable_string COLLATE golaberto_search GENERATED ALWAYS AS (coalesce(country, '')) STORED;
      ${baseline ? `ALTER TABLE championship ADD COLUMN search_key portable_string GENERATED ALWAYS AS
        (replace(replace(replace(region_name || ' - ' || name || ' ' || extract(year from begins)::int::text ||
        CASE WHEN extract(year from begins) = extract(year from ends) THEN '' ELSE '/' || extract(year from ends)::int::text END, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
        ALTER TABLE team ADD COLUMN search_key portable_string GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
        ALTER TABLE stadium ADD COLUMN search_key portable_string GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
        ALTER TABLE referee ADD COLUMN search_key portable_string GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
        ALTER TABLE team_directory ADD COLUMN search_key portable_string GENERATED ALWAYS AS (replace(replace(replace(name, 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;
        ALTER TABLE team_directory ADD COLUMN country_key portable_string GENERATED ALWAYS AS (replace(replace(replace(coalesce(country, ''), 'ı', 'i'), 'þ', 'th'), 'Þ', 'th')) STORED;` : ""}
      INSERT INTO championship (name,region_name,begins,ends) VALUES
        ('Atlético ı Þ æ','Brasil','2026-01-01','2027-12-31'),('Atletico i th ae','Brasil','2026-01-01','2027-12-31'),('Atlântico j t oe','Brasil','2026-01-01','2027-12-31');
      INSERT INTO team (name) SELECT name FROM championship;
      INSERT INTO stadium (name) SELECT name FROM team;
      INSERT INTO referee (name) SELECT name FROM team;
      INSERT INTO team_directory (name,country) VALUES ('Atletico ı Þ æ','Þorland'),('Atletico i th ae','Thorland');
      ${migration}
      CREATE VIEW current_version AS SELECT search_key FROM team;
      ${migration}
      ${["championship", "team", "stadium", "referee"].flatMap(table => searchVariants.map(q =>
        `SELECT count(*) FROM ${table} WHERE search_key LIKE replace(replace(replace('%${q}%', 'ı', 'i'), 'þ', 'th'), 'Þ', 'th');`)).join("\n")}
      SELECT replace(replace(replace('ı', 'ı', 'i'), 'þ', 'th'), 'Þ', 'th') COLLATE golaberto_search LIKE 'i';
      SELECT replace(replace(replace('Þ', 'ı', 'i'), 'þ', 'th'), 'Þ', 'th') COLLATE golaberto_search LIKE 'th';
      SELECT 'æ' COLLATE golaberto_search LIKE 'ae';
      SELECT replace(replace(replace('Þ', 'ı', 'i'), 'þ', 'th'), 'Þ', 'th') COLLATE golaberto_search LIKE 't';
      SELECT replace(replace(replace('ı', 'ı', 'i'), 'þ', 'th'), 'Þ', 'th') COLLATE golaberto_search LIKE 'j';
      SELECT count(*) FROM previous_version;
      SELECT count(*) FROM current_version WHERE search_key LIKE '%atletico i th ae%';
      SELECT count(*) FROM team_directory WHERE search_key LIKE '%atletico i th ae%' AND country_key LIKE '%THORLAND%';
      SELECT count(*) FROM team WHERE name='Atlético ı Þ æ';
      UPDATE team SET name='Changed ı Þ æ' WHERE name='Atlético ı Þ æ';
      SELECT count(*) FROM team WHERE search_key LIKE '%changed i th ae%';
      ROLLBACK;`);
    assertEquals(output.split("\n"), [...Array(4 * searchVariants.length).fill("2"), "t", "t", "t", "f", "f", "3", "2", "2", "1", "1"]);
  });
}

const { chromium } = await import("npm:playwright@1.59.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(".");
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const prefix = `Accent${tag}`;
const names = [`${prefix} Atlético I Þ Æ`, `${prefix} Atletico ı th ae`];
const foldSearch = (value: string) => value.replaceAll("ı", "i").replaceAll("þ", "th").replaceAll("Þ", "th");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

for (const width of [390, 1366]) {
  Deno.test(`every search box ignores accents at ${width}px`, async () => {
    const browser = await chromium.launch();
    const userId = crypto.randomUUID();
    const ids: Record<string, string[]> = {};
    try {
      for (const table of ["championship", "team", "stadium", "referee"]) {
        const count = table === "team" ? 42 : 2;
        ids[table] = Array.from({ length: count }, () => crypto.randomUUID());
        const values = ids[table].map((id, i) => `(${quote(id)},${quote(names[i % 2] + (count > 2 ? ` ${String(i).padStart(2, "0")}` : ""))}${table === "championship" ? ",'Brasil','2026-01-01','2026-12-31'" : table === "team" ? ",'Brasil'" : ""})`);
        await psql(`INSERT INTO ${table} (id,name${table === "championship" ? ",region_name,begins,ends" : table === "team" ? ",country" : ""}) VALUES ${values.join(",")};`);
        if (table === "team") await psql("SELECT refresh_team_directory();");
      }
      await psql(`INSERT INTO app_user (id,handle) VALUES ('${userId}','search-${tag}-${width}'); INSERT INTO editor (app_user_id) VALUES ('${userId}');`);
      const token = await new SignJWT({ role: "app_user", handle: `search-${tag}-${width}`, guest: false })
        .setProtectedHeader({ alg: "HS256" }).setSubject(userId).setExpirationTime("1h")
        .sign(new TextEncoder().encode(Deno.env.get("PGRST_JWT_SECRET") ?? "mecha-dev-secret-please-override-32ch"));
      const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "pt-BR", viewport: { width, height: 900 } });
      await context.addInitScript((session) => sessionStorage.setItem("pronto-token", JSON.stringify(session)), { token, user: { id: userId, handle: `search-${tag}-${width}` } });
      const page = await context.newPage();
      const requests: URL[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/crud/")) requests.push(url);
      });
      const search = async (input: string, table: string, q: string) => {
        const response = page.waitForResponse((r) => {
          const url = new URL(r.url());
          return url.pathname === `/crud/${table}` && url.searchParams.get("search_key") === `like.*${foldSearch(q)}*`;
        });
        await page.fill(input, q);
        assert((await response).ok(), `${table} search must succeed`);
        assertEquals(await page.locator(input).inputValue(), q);
      };
      for (const [path, input, table, route] of [["campeonatos", "catalog", "championship", "campeonato"], ["equipes", "teams", "team_directory", "equipe"], ["estadios", "stadiums", "stadium", "estadio"], ["arbitros", "referees", "referee", "arbitro"]]) {
        await page.goto(`${base}/${path}?lang=pt-BR`);
        await page.waitForSelector(`#${input}-q`);
        let first: string[] = [];
        for (const [index, spelling] of searchVariants.entries()) {
          const q = `${prefix} ${spelling}`;
          await search(`#${input}-q`, table, q);
          const expected = table === "team_directory" ? 40 : 2;
          await page.waitForFunction(([route, count, prefix]) => {
            const links = [...document.querySelectorAll(`.catalog-table a[data-route="${route}"]`)];
            return links.length === Number(count) && links.every((link) => link.textContent?.includes(prefix));
          }, [route, String(expected), prefix]);
          const results = await page.locator(`.catalog-table a[data-route="${route}"]`).evaluateAll((links) => links.map((link) => link.getAttribute("data-param-id") ?? "").sort());
          if (index === 0) first = results;
          else assertEquals(results, first);
          if (table === "team_directory" && index === 0) {
            await page.click(`#${input}-next`);
            await page.waitForFunction(() => document.querySelectorAll('.catalog-table a[data-route="equipe"]').length === 2);
            const last = await page.locator('.catalog-table a[data-route="equipe"]').evaluateAll((links) => links.map((link) => link.getAttribute("data-param-id") ?? ""));
            assertEquals(new Set([...first, ...last]).size, 42);
            await page.locator(`#${input}-next`).waitFor({ state: "hidden" });
          }
        }
      }

      const gameId = await psql("SELECT id FROM game ORDER BY id LIMIT 1;");
      await page.goto(`${base}/editar/${gameId}?lang=pt-BR`);
      await page.waitForSelector('.edit[data-state="editing"]');
      for (const [table, field] of [["stadium", "stadium"], ["referee", "referee"]]) {
        for (const spelling of searchVariants) {
          await search(`#edit-${field}-q`, table, `${prefix} ${spelling}`);
          await page.waitForFunction(([field, expected]) => {
            const ids = [...document.querySelectorAll(`#edit-${field} optgroup:last-child option`)].map((e) => (e as HTMLOptionElement).value).sort();
            return JSON.stringify(ids) === JSON.stringify(expected);
          }, [field, ids[table].toSorted()]);
          await page.selectOption(`#edit-${field}`, ids[table][0]);
          assertEquals(await page.locator(`#edit-${field}`).inputValue(), ids[table][0]);
        }
      }
      for (const request of requests.filter((url) =>
        url.searchParams.has("search_key") && !["/crud/geography_country", "/crud/geography_region"].includes(url.pathname))) {
        assert(Number(request.searchParams.get("limit")) <= 40, "search and pagination probes stay bounded");
      }
    } finally {
      await browser.close();
      for (const [table, values] of Object.entries(ids)) {
        await psql(`DELETE FROM ${table} WHERE id IN (${values.map(quote).join(",")});`);
      }
      await psql(`DELETE FROM app_user WHERE id='${userId}';`);
    }
  });
}
