/// <reference lib="dom" />
// Durable route-load acceptance: a fresh browser context proves each path
// renders from its own bounded on-demand reads, not a previous route's cache.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error(
    "route-loads requires an explicit disposable COMPOSE_PROJECT_NAME containing check or test",
  );
}

const { chromium } = await import("npm:playwright@1.59.1");
const { SignJWT } = await import("npm:jose@6.0.11");
const base = await baseUrl(Deno.args[0] ?? ".");
const onDemandTables = new Set<string>(
  JSON.parse(await Deno.readTextFile("shell/shell.json")).onDemand,
);
const browser = await chromium.launch();
// deno-lint-ignore no-explicit-any
type Page = any;

const command = [
  "compose",
  "-p",
  project,
  "exec",
  "-T",
  "apps_golaberto-database",
  "psql",
  "-U",
  "postgres",
  "-d",
  "golaberto",
  "-v",
  "ON_ERROR_STOP=1",
];

const psql = async (sql: string): Promise<string> => {
  const result = await new Deno.Command("docker", {
    args: [...command, "-Atqc", sql],
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};

const context = async (session?: unknown) => {
  const browserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 900 },
    locale: "pt-BR",
  });
  if (session !== undefined) {
    await browserContext.addInitScript((value: unknown) => {
      sessionStorage.setItem("pronto-token", JSON.stringify(value));
    }, session);
  }
  return browserContext;
};

const visit = async (page: Page, path: string, visible: string) => {
  await page.goto(`${base}${path}`);
  await page.waitForSelector(
    '.shell-screen:not([hidden]) .screen[data-state="populated"]',
    { timeout: 30_000 },
  );
  await page.waitForSelector(visible, { timeout: 30_000 });
  await page.waitForFunction(
    (onDemand: string[]) => {
      const client = (globalThis as unknown as {
        __mechaClient?: {
          collections: Record<string, { isReady(): boolean }>;
        };
      }).__mechaClient;
      if (!client) return false;
      const active = [
        ...document.querySelectorAll(".shell-screen:not([hidden]) [data-live]"),
      ]
        .map((element) => element.getAttribute("data-live"))
        .filter((table): table is string => table !== null);
      const demand = new Set(onDemand);
      return active.every((table) => {
        const collection = client.collections[table];
        return collection !== undefined &&
          (demand.has(table) || collection.isReady());
      });
    },
    [...onDemandTables],
    { timeout: 30_000 },
  );
};

type Counts = { rows: Record<string, number>; total: number };
const counts = async (page: Page): Promise<Counts> =>
  await page.evaluate(() => {
    const client = (globalThis as unknown as {
      __mechaClient: {
        collections: Record<string, { toArray: unknown[] }>;
      };
    }).__mechaClient;
    const rows = Object.fromEntries(
      Object.entries(client.collections).map((
        [table, collection],
      ) => [table, collection.toArray.length]),
    );
    return {
      rows,
      total: Object.values(rows).reduce((sum, count) => sum + count, 0),
    };
  });

type Read = { table: string; url: string; rows: number };
const observeReads = (page: Page) => {
  const reads: Read[] = [];
  const pending = new Set<Promise<void>>();
  const pendingRequests = new Set<object>();
  let lastActivity = performance.now();
  const isCrud = (url: string) =>
    /\/crud\/[^/]+(?:\?|$)/.test(new URL(url).pathname + new URL(url).search);
  page.on("request", (request: { url(): string }) => {
    if (!isCrud(request.url())) return;
    pendingRequests.add(request);
    lastActivity = performance.now();
  });
  const finished = (request: object) => {
    if (!pendingRequests.delete(request)) return;
    lastActivity = performance.now();
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  page.on(
    "response",
    (response: { url(): string; ok(): boolean; json(): Promise<unknown> }) => {
      const url = response.url();
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/crud\/([^/]+)$/);
      if (match === null || !response.ok()) return;
      lastActivity = performance.now();
      const table = decodeURIComponent(match[1]);
      const receipt = response.json().then((payload) => {
        reads.push({
          table,
          url,
          rows: Array.isArray(payload) ? payload.length : 1,
        });
      });
      pending.add(receipt);
      void receipt.finally(() => pending.delete(receipt));
    },
  );
  return {
    mark: () => reads.length,
    async since(mark: number): Promise<Read[]> {
      const until = performance.now() + 5_000;
      while (performance.now() < until) {
        await Promise.all([...pending]);
        if (
          pendingRequests.size === 0 && pending.size === 0 &&
          performance.now() - lastActivity >= 250
        ) {
          return reads.slice(mark);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(pending.size, 0, "PostgREST route responses must settle");
      return reads.slice(mark);
    },
  };
};

const assertBounded = (label: string, reads: Read[]) => {
  const rowsByTable = new Map<string, number>();
  for (const read of reads) {
    assert(
      read.rows < 1000,
      `${label}: ${read.table} returned ${read.rows} rows`,
    );
    const url = new URL(read.url);
    const limit = Number(url.searchParams.get("limit"));
    const filters = [...url.searchParams.keys()].filter((key) =>
      !["select", "order", "limit", "offset"].includes(key)
    );
    assert(
      filters.length > 0,
      `${label}: ${read.table} request has no row filter`,
    );
    if (url.searchParams.has("limit")) {
      assert(
        limit > 0 && limit < 1000,
        `${label}: ${read.table} request has unbounded limit=${limit}`,
      );
    }
    rowsByTable.set(read.table, (rowsByTable.get(read.table) ?? 0) + read.rows);
  }
  for (const [table, count] of rowsByTable) {
    assert(
      count < 1000,
      `${label}: PostgREST returned ${count} ${table} rows across route reads`,
    );
  }
};

const BRASILEIRO_2026 = "02000000-0000-4000-8000-000000000001";
const WIN = "09000000-0000-4000-8000-000000000280";
const ATHLETICO = "07000000-0000-4000-8000-000000000003";
const VIVEROS = "0c000000-0000-4000-8000-000000000126";
const PACAEMBU = "06000000-0000-4000-8000-000000000050";
const ABADE = "0b000000-0000-4000-8000-000000000003";
const SERIE_A_2026 = "04000000-0000-4000-8000-000000000001";

const routePatterns: Array<{
  pattern: string;
  path: string;
  visible: string;
}> = [
  {
    pattern: "/",
    path: "/",
    visible: ".feature .standings tbody tr",
  },
  {
    pattern: "/campeonatos",
    path: "/en/championships",
    visible: ".catalog-table tbody tr",
  },
  {
    pattern: "/jogos",
    path: "/en/matches",
    visible: ".games.upcoming .game-row",
  },
  {
    pattern: "/jogo/:id",
    path: `/en/match/${WIN}`,
    visible: ".scoreboard",
  },
  {
    pattern: "/chances/:id",
    path: `/chances/${SERIE_A_2026}`,
    visible: ".zone-odds .rows .row .pct",
  },
  {
    pattern: "/editar/:id",
    path: `/en/edit/${WIN}`,
    visible: '.edit[data-state="editing"]',
  },
  {
    pattern: "/equipes",
    path: "/en/teams",
    visible: ".catalog-table tbody tr",
  },
  {
    pattern: "/estadios",
    path: "/en/stadiums",
    visible: ".catalog-table tbody tr",
  },
  {
    pattern: "/estadio/:id",
    path: `/en/stadium/${PACAEMBU}`,
    visible: ".venue-games .game-row",
  },
  {
    pattern: "/arbitros",
    path: "/en/referees",
    visible: ".catalog-table tbody tr",
  },
  {
    pattern: "/arbitro/:id",
    path: `/en/referee/${ABADE}`,
    visible: ".venue-games .game-row",
  },
  {
    pattern: "/equipe/:id",
    path: `/en/team/${ATHLETICO}`,
    visible: ".team-results .game-row",
  },
  {
    pattern: "/jogador/:id",
    path: `/en/player/${VIVEROS}`,
    visible: ".player-games .game-row",
  },
  {
    pattern: "/campeonato/:id",
    path: `/en/championship/${BRASILEIRO_2026}`,
    visible: ".standings tbody tr",
  },
];

assertEquals(
  routePatterns.map((route) => route.pattern).sort(),
  JSON.parse(await Deno.readTextFile("shell/shell.json")).routes.map(
    (route: { path: string }) => route.path,
  ).sort(),
  "every declared route pattern is covered once",
);

const editorSession = async () => {
  const id = crypto.randomUUID();
  const handle = `route-load-${Date.now()}`;
  await psql(
    `INSERT INTO app_user (id,handle) VALUES ('${id}','${handle}'); INSERT INTO editor (app_user_id) VALUES ('${id}')`,
  );
  const secret = new TextEncoder().encode(
    Deno.env.get("PGRST_JWT_SECRET") ?? "mecha-dev-secret-please-override-32ch",
  );
  const token = await new SignJWT({ role: "app_user", handle, guest: false })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setExpirationTime("1h")
    .sign(secret);
  return { id, session: { token, user: { id, handle } } };
};

Deno.test({
  name:
    "all 14 routes render with bounded on-demand collections and catalog paging stays stable",
  timeout: 8 * 60_000,
  async fn() {
    const prefix = `route-load-${Deno.pid}-${Date.now()}`;
    const regionName = `RouteLoad${Deno.pid}${Date.now()}`;
    const editor = await editorSession();
    let fixtureCreated = false;
    try {
      await psql(`
        INSERT INTO championship (name,region,region_name,begins,ends)
        SELECT '${prefix}-' || lpad(n::text,3,'0'),'national','${regionName}','2026-01-01','2026-12-31'
        FROM generate_series(1,85) n;
      `);
      fixtureCreated = true;

      for (const route of routePatterns) {
        const browserContext = await context(
          route.pattern === "/editar/:id" ? editor.session : undefined,
        );
        try {
          const page = await browserContext.newPage();
          const reads = observeReads(page);
          await visit(page, route.path, route.visible);
          assertBounded(route.pattern, await reads.since(0));
          assert(
            await page.locator(route.visible).count() > 0,
            `${route.pattern} renders populated content`,
          );
          if (
            ["/campeonatos", "/equipes", "/estadios", "/arbitros"].includes(
              route.pattern,
            )
          ) {
            assert(
              await page.locator(".catalog-table tbody tr").count() <= 40,
              `${route.pattern}: first page exceeds forty visible rows`,
            );
          }
          const loaded = await counts(page);
          assert(
            loaded.total < 3000,
            `${route.pattern}: excessive resident rows`,
          );
          for (const [table, rows] of Object.entries(loaded.rows)) {
            assert(
              rows < 1000,
              `${route.pattern}: ${table} loaded ${rows} rows`,
            );
          }
          console.log(
            `${route.pattern}: ${loaded.total} resident rows and ${
              (await reads.since(0)).length
            } bounded REST reads`,
          );
        } finally {
          await browserContext.close();
        }
      }

      const browserContext = await context();
      try {
        const page = await browserContext.newPage();
        const reads = observeReads(page);
        await visit(page, "/campeonatos", ".catalog-table tbody tr");
        await reads.since(0);
        let mark = reads.mark();
        await page.fill("#catalog-q", prefix);
        await page.waitForFunction(
          (value: string) => {
            const rows = [
              ...document.querySelectorAll(".catalog-table tbody tr"),
            ];
            return rows.length === 40 &&
              rows.every((row) => row.textContent?.includes(value));
          },
          prefix,
          { timeout: 30_000 },
        );
        let batch = await reads.since(mark);
        assertBounded("catalog first page", batch);
        const firstPage = batch.filter((read) => read.table === "championship");
        assert(
          firstPage.length > 0,
          "catalog first page performs a bounded championship read",
        );
        assertEquals(
          firstPage.reduce((sum, read) => sum + read.rows, 0),
          41,
          "page and next-row probe return forty-one matching rows",
        );
        assert(
          firstPage.every((read) => {
            const limit = new URL(read.url).searchParams.get("limit");
            return limit !== null && Number(limit) > 0 && Number(limit) <= 40;
          }),
          "catalog page and probe reads are capped at forty rows",
        );
        await page.locator("#catalog-next").waitFor({
          state: "visible",
          timeout: 30_000,
        });

        mark = reads.mark();
        await page.click("#catalog-next");
        await page.waitForFunction(
          (value: string) =>
            document.querySelector(".page-status b")?.textContent?.trim() ===
              "2" &&
            [...document.querySelectorAll(".catalog-table tbody tr")].length ===
              40 &&
            [...document.querySelectorAll(".catalog-table tbody tr")].some((
              row,
            ) => row.textContent?.includes(`${value}-041`)) &&
            [...document.querySelectorAll(".catalog-table tbody tr")].every((
              row,
            ) => row.textContent?.includes(value)),
          prefix,
          { timeout: 30_000 },
        );
        batch = await reads.since(mark);
        assertBounded("catalog second page", batch);
        assertEquals(
          batch.filter((read) => read.table === "championship").reduce(
            (sum, read) => sum + read.rows,
            0,
          ),
          41,
          "second page and its probe return only forty-one matching rows",
        );

        mark = reads.mark();
        await page.click("#catalog-next");
        await page.waitForFunction(
          (value: string) =>
            document.querySelector(".page-status b")?.textContent?.trim() ===
              "3" &&
            [...document.querySelectorAll(".catalog-table tbody tr")].length ===
              5 &&
            [...document.querySelectorAll(".catalog-table tbody tr")].some((
              row,
            ) => row.textContent?.includes(`${value}-081`)) &&
            [...document.querySelectorAll(".catalog-table tbody tr")].every((
              row,
            ) => row.textContent?.includes(value)),
          prefix,
          { timeout: 30_000 },
        );
        await page.locator("#catalog-next").waitFor({
          state: "hidden",
          timeout: 30_000,
        });
        batch = await reads.since(mark);
        assertBounded("catalog final page", batch);
        assertEquals(
          batch.filter((read) => read.table === "championship").reduce(
            (sum, read) => sum + read.rows,
            0,
          ),
          5,
          "last page returns the five remaining matching rows",
        );

        await page.click("#catalog-previous");
        await page.waitForFunction(() =>
          document.querySelector(".page-status b")?.textContent?.trim() === "2"
        );
        await reads.since(0);
        mark = reads.mark();
        const broader = `${prefix}-0`;
        await page.fill("#catalog-q", broader);
        await page.waitForFunction(
          (value: string) =>
            document.querySelector(".page-status b")?.textContent?.trim() ===
              "1" &&
            [...document.querySelectorAll(".catalog-table tbody tr")].length ===
              40 &&
            [...document.querySelectorAll(".catalog-table tbody tr")].every((
              row,
            ) => row.textContent?.includes(value)),
          broader,
          { timeout: 30_000 },
        );
        batch = await reads.since(mark);
        assertBounded("catalog search reset", batch);
        assertEquals(
          batch.filter((read) => read.table === "championship").reduce(
            (sum, read) => sum + read.rows,
            0,
          ),
          41,
          "changed search returns a fresh first page and probe",
        );

        await page.click("#catalog-next");
        await page.waitForFunction(() =>
          document.querySelector(".page-status b")?.textContent?.trim() === "2"
        );
        await reads.since(0);
        const exact = `${prefix}-085`;
        mark = reads.mark();
        await page.fill("#catalog-q", exact);
        await page.waitForFunction(
          (value: string) =>
            document.querySelector(".page-status b")?.textContent?.trim() ===
              "1" &&
            document.querySelectorAll(".catalog-table tbody tr").length === 1 &&
            document.querySelector(".catalog-table tbody tr")?.textContent
                ?.includes(value) === true,
          exact,
          { timeout: 30_000 },
        );
        await page.locator("#catalog-next").waitFor({
          state: "hidden",
          timeout: 30_000,
        });
        batch = await reads.since(mark);
        assertBounded("catalog exact search", batch);
        assertEquals(
          batch.filter((read) => read.table === "championship").reduce(
            (sum, read) => sum + read.rows,
            0,
          ),
          1,
          "exact search reads one matching championship and no next row",
        );
        await page.click(".catalog-table tbody tr:first-child a");
        await page.waitForSelector(".championship h1.band", {
          timeout: 30_000,
        });
        await page.goBack();
        await page.waitForURL("**/campeonatos", { timeout: 30_000 });
        await page.waitForFunction(
          (value: string) => {
            const active = document.querySelector(
              ".shell-screen:not([hidden])",
            );
            return (
              (active?.querySelector("#catalog-q") as HTMLInputElement | null)
                  ?.value === value &&
              active?.querySelector(".page-status b")?.textContent?.trim() ===
                "1" &&
              active?.querySelectorAll(".catalog-table tbody tr").length === 1
            );
          },
          exact,
          { timeout: 30_000 },
        );
        assertBounded("catalog back", await reads.since(0));
      } finally {
        await browserContext.close();
      }
    } finally {
      if (fixtureCreated) {
        await psql(
          `DELETE FROM championship WHERE region_name='${regionName}' AND name LIKE '${prefix}-%'`,
        );
      }
      await psql(`DELETE FROM app_user WHERE id='${editor.id}'`);
      await browser.close();
    }
  },
});
