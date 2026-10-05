/// <reference lib="dom" />
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Page } from "npm:playwright@1.59.1";
import { baseUrl } from "../../../plugins/omnishell/base-url.ts";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("slug-routes requires an explicit disposable check/test COMPOSE_PROJECT_NAME");
}
const base = await baseUrl(Deno.args[0] ?? ".");
const ready = '.shell-screen:not([hidden]) .screen[data-state="populated"]';
const active = '.shell-screen:not([hidden])';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ids = {
  team: "07000000-0000-4000-8000-000000000003",
  championship: "02000000-0000-4000-8000-000000000001",
  game: "09000000-0000-4000-8000-000000000280",
  group: "04000000-0000-4000-8000-000000000001",
  player: "0c000000-0000-4000-8000-000000000126",
  stadium: "06000000-0000-4000-8000-000000000050",
  referee: "0b000000-0000-4000-8000-000000000003",
};
type Kind = keyof typeof ids;
const cases: { screen: string; pt: string; en: string; kinds: Kind[]; visible: string }[] = [
  { screen: "equipe", pt: "equipe", en: "team", kinds: ["team"], visible: ".team-current-championships a[href]" },
  { screen: "equipe-campeonato", pt: "equipe-campeonato", en: "team-championship", kinds: ["team", "championship"], visible: ".team-roster tbody tr" },
  { screen: "campeonato", pt: "campeonato", en: "championship", kinds: ["championship"], visible: ".standings tbody tr" },
  { screen: "jogo", pt: "jogo", en: "match", kinds: ["game"], visible: ".scoreboard" },
  { screen: "chances", pt: "chances", en: "chances", kinds: ["group"], visible: ".zone-odds .pct" },
  { screen: "editar", pt: "editar", en: "edit", kinds: ["game"], visible: '.edit[data-state="editing"]' },
  { screen: "jogador", pt: "jogador", en: "player", kinds: ["player"], visible: ".player-games .game-row" },
  { screen: "estadio", pt: "estadio", en: "stadium", kinds: ["stadium"], visible: ".venue-games .game-row" },
  { screen: "arbitro", pt: "arbitro", en: "referee", kinds: ["referee"], visible: ".venue-games .game-row" },
];
const psql = async (sql: string) => {
  const result = await new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const waitReady = async (page: Page, visible?: string) => {
  await page.locator(ready).waitFor({ timeout: 30_000 });
  if (visible) await page.locator(`${active} ${visible}`).first().waitFor({ timeout: 30_000 });
};
const readable = (path: string) => {
  for (const part of path.split("/").filter(Boolean)) {
    assert(!UUID.test(part), `public address still contains UUID ${part}`);
  }
};

Deno.test({
  name: "public detail routes preserve UUID bookmarks, readable links, navigation and lookup recovery",
  timeout: 8 * 60_000,
  async fn() {
    const { chromium } = await import("npm:playwright@1.59.1");
    const { SignJWT } = await import("npm:jose@6.0.11");
    const slugs: Record<Kind, string> = JSON.parse(await psql(
      `SELECT json_object_agg(kind,slug) FROM public_address WHERE ${Object.entries(ids).map(([kind, id]) => `(kind='${kind}' AND record_id='${id}')`).join(" OR ")}`,
    ));
    for (const kind of Object.keys(ids) as Kind[]) assert(slugs[kind], `seed ${kind} has a public address`);
    const cfg = JSON.parse(await Deno.readTextFile("shell/shell.json"));
    assertEquals(cases.map(c => c.screen).sort(), cfg.routes.filter((r: { routeParams?: unknown }) => r.routeParams).map((r: { screen: string }) => r.screen).sort(), "every declared public detail route is covered");
    const editor = crypto.randomUUID();
    const handle = `slug-routes-${Date.now()}`;
    await psql(`INSERT INTO app_user(id,handle) VALUES ('${editor}','${handle}'); INSERT INTO editor(app_user_id) VALUES ('${editor}')`);
    const browser = await chromium.launch();
    try {
      const token = await new SignJWT({ role: "app_user", handle, guest: false }).setProtectedHeader({ alg: "HS256" }).setSubject(editor).setExpirationTime("1h")
        .sign(new TextEncoder().encode(Deno.env.get("PGRST_JWT_SECRET") ?? "mecha-dev-secret-please-override-32ch"));
      const newContext = async (editorSession = false) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "pt-BR", viewport: { width: 1366, height: 900 } });
        if (editorSession) await context.addInitScript(session => sessionStorage.setItem("pronto-token", JSON.stringify(session)), { token, user: { id: editor, handle } });
        return context;
      };
      for (const route of cases) {
        const suffix = route.kinds.map(kind => slugs[kind]).join("/");
        const pt = `/${route.pt}/${suffix}`;
        const en = `/en/${route.en}/${suffix}`;
        readable(pt);
        const context = await newContext(route.screen === "editar");
        try {
          const page = await context.newPage();
          const registryReads: URL[] = [];
          page.on("request", request => {
            const url = new URL(request.url());
            if (url.pathname === "/crud/public_address") registryReads.push(url);
          });
          const legacy = `/${route.pt}/${route.kinds.map(kind => ids[kind]).join("/")}`;
          await page.goto(`${base}${legacy}?lang=pt-BR&source=shared&source=friend#bookmark`);
          await waitReady(page, route.visible);
          await page.waitForURL(url => url.pathname === pt);
          const arrived = new URL(page.url());
          assertEquals(arrived.searchParams.getAll("source"), ["shared", "friend"], "UUID canonicalization preserves duplicate query values");
          assertEquals(arrived.searchParams.get("lang"), "pt-BR");
          assertEquals(arrived.hash, "#bookmark");
          assertEquals(await page.locator('head link[rel="canonical"]').getAttribute("href"), `${base}${pt}`);
          assertEquals(await page.locator('head link[rel="alternate"][hreflang="en-GB"]').getAttribute("href"), `${base}${en}`);
          await page.reload();
          await waitReady(page, route.visible);
          assertEquals(new URL(page.url()).pathname, pt);
          for (const read of registryReads) {
            assert(read.searchParams.has("kind"));
            assert(read.searchParams.has("record_id") || read.searchParams.has("slug"));
            const limit = Number(read.searchParams.get("limit"));
            assert(limit > 0 && limit <= 50, `public address lookup is bounded: ${read}`);
          }
          assert(registryReads.length > 0, "fresh routes resolve their identifiers through the declared store");
        } finally { await context.close(); }
        // A fresh tab has neither the UUID bookmark nor its resolver cache.
        const direct = await newContext(route.screen === "editar");
        try {
          const page = await direct.newPage();
          await page.goto(`${base}${en}`);
          await waitReady(page, route.visible);
          assertEquals(new URL(page.url()).pathname, en);
          assertEquals(await page.locator('head link[rel="canonical"]').getAttribute("href"), `${base}${en}`);
          assertEquals(await page.locator("html").getAttribute("lang"), "en-GB");
        } finally { await direct.close(); }
      }

      const navigation = await newContext();
      try {
        const page = await navigation.newPage();
        const teamPath = `/equipe/${slugs.team}`;
        const campaignPath = `/equipe-campeonato/${slugs.team}/${slugs.championship}`;
        await page.goto(`${base}${teamPath}?lang=pt-BR`);
        await waitReady(page);
        const link = page.locator(`${active} .team-current-championships a[data-param-championship="${ids.championship}"][href]`);
        await link.waitFor();
        const href = await link.getAttribute("href");
        assert(href);
        assertEquals(new URL(href, base).pathname, campaignPath);
        readable(new URL(href, base).pathname);
        assertEquals(await link.getAttribute("data-param-id"), ids.team, "bindings keep their internal UUID");
        const tabOpened = navigation.waitForEvent("page");
        await link.click({ button: "middle" });
        const copied = await tabOpened;
        await copied.waitForLoadState();
        await waitReady(copied, ".team-switch select");
        assertEquals(new URL(copied.url()).pathname, campaignPath, "native new-tab navigation follows the public href");
        await copied.close();
        await link.click();
        await page.waitForURL(url => url.pathname === campaignPath);
        await waitReady(page, ".team-switch select");
        await page.waitForFunction(() => document.querySelectorAll('.shell-screen:not([hidden]) .team-switch option').length > 1);
        const opponent = await page.locator(`${active} .team-switch option`).evaluateAll((options, mine) => options.map(option => (option as HTMLOptionElement).value).find(value => value !== mine), ids.team);
        assert(opponent && UUID.test(opponent), "selector values remain UUIDs");
        const opponentSlug = await psql(`SELECT slug FROM public_address WHERE kind='team' AND record_id='${opponent}'`);
        assert(opponentSlug);
        const opponentPath = `/equipe-campeonato/${opponentSlug}/${slugs.championship}`;
        await page.locator(`${active} .team-switch select`).selectOption(opponent);
        await page.waitForURL(url => url.pathname === opponentPath);
        await waitReady(page);
        await page.goBack();
        await page.waitForURL(url => url.pathname === campaignPath);
        await waitReady(page);
        assertEquals(await page.locator(`${active} .team-switch select`).inputValue(), ids.team);
        await page.goForward();
        await page.waitForURL(url => url.pathname === opponentPath);
        await waitReady(page);
        assertEquals(await page.locator(`${active} .team-switch select`).inputValue(), opponent);
        await page.locator(`${active} .langs a[data-locale="en-GB"][href]`).click();
        await page.waitForURL(url => url.pathname === `/en/team-championship/${opponentSlug}/${slugs.championship}`);
        await waitReady(page);
      } finally { await navigation.close(); }

      const delayed = await newContext();
      try {
        const page = await delayed.newPage();
        const campaignPath = `/equipe-campeonato/${slugs.team}/${slugs.championship}`;
        const coldTeam = await psql(`SELECT t.id FROM team t JOIN public_address a ON a.kind='team' AND a.record_id=t.id WHERE NOT EXISTS (SELECT 1 FROM team_championship tc WHERE tc.team_id=t.id AND tc.championship_id='${ids.championship}') ORDER BY t.id LIMIT 1`);
        assert(UUID.test(coldTeam));
        await page.goto(`${base}${campaignPath}?lang=pt-BR`);
        await waitReady(page, ".team-switch select");
        // A late selector option isolates the unresolved-address race from
        // mappings already warmed by every visible standings link.
        await page.locator(`${active} .team-switch select`).evaluate((select, id) => {
          const option = document.createElement("option");
          option.value = id;
          option.textContent = "Delayed route fixture";
          select.append(option);
        }, coldTeam);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const intercepted = new Promise<void>(resolve => { started = resolve; });
        let finished!: () => void;
        const delivered = new Promise<void>(resolve => { finished = resolve; });
        await page.route("**/crud/public_address?**", async route => {
          if (!(new URL(route.request().url()).searchParams.get("record_id") ?? "").includes(coldTeam)) return route.continue();
          started();
          await held;
          await route.continue();
          finished();
        });
        await page.locator(`${active} .team-switch select`).selectOption(coldTeam);
        await intercepted;
        await page.locator('body > nav a[data-route="campeonatos"]').click();
        await page.waitForURL(url => url.pathname === "/campeonatos");
        await waitReady(page);
        await page.goBack();
        await page.waitForURL(url => url.pathname === campaignPath);
        await waitReady(page, ".team-switch select");
        // Preserve the submitted values: the navigation epoch, not changed
        // values or a detached form, must prevent this obsolete submission.
        await page.locator(`${active} .team-switch select`).evaluate((select, id) => { (select as HTMLSelectElement).value = id; }, coldTeam);
        assertEquals(await page.locator(`${active} .team-switch select`).inputValue(), coldTeam);
        const response = page.waitForResponse(r => new URL(r.url()).pathname === "/crud/public_address" && (new URL(r.url()).searchParams.get("record_id") ?? "").includes(coldTeam));
        release();
        await delivered;
        await (await response).finished();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assertEquals(new URL(page.url()).pathname, campaignPath, "a selector lookup cannot navigate after leaving and returning to its held screen");
      } finally { await delayed.close(); }

      for (const source of [
        { screen: "editar", path: `/en/edit/${slugs.game}`, editor: true, visible: '.edit[data-state="editing"]' },
        { screen: "campeonatos", path: "/en/championships", editor: false, visible: ".catalog-table tbody tr" },
      ]) {
        assertEquals(cfg.routes.find((r: {screen: string}) => r.screen === source.screen).keep, 0);
        for (const failure of ["gone", "network-error"]) {
          const context = await newContext(source.editor);
          try {
            const page = await context.newPage();
            await page.goto(`${base}${source.path}`);
            await waitReady(page, source.visible);
            await page.locator(`${active} .screen`).evaluate(el => el.setAttribute("data-discard-probe", "original"));
            if (failure === "network-error") {
              await page.route("**/crud/public_address?**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"discard acceptance outage"}' }));
            }
            const missing = `missing-discard-${crypto.randomUUID()}`;
            // Native in-document navigation keeps the previous screen alive
            // long enough to exercise the shell's failed-lookup discard path.
            await page.locator(`${active} .screen`).evaluate((screen, href) => {
              const link = document.createElement("a");
              link.id = "discard-navigation";
              link.href = href;
              link.textContent = "Missing destination fixture";
              screen.prepend(link);
            }, `/en/team/${missing}`);
            await page.locator("#discard-navigation").click();
            await page.locator(`${active} .screen[data-state="${failure}"]`).waitFor({ timeout: 30_000 });
            assertEquals(await page.locator('[data-discard-probe="original"]').count(), 0, `${source.screen} keep:0 DOM is discarded on ${failure}`);
            if (failure === "network-error") await page.unroute("**/crud/public_address?**");
            await page.goBack();
            await page.waitForURL(url => url.pathname === source.path);
            await waitReady(page, source.visible);
            assertEquals(await page.locator('[data-discard-probe="original"]').count(), 0, "Back mounts a fresh screen");
            assertEquals(await page.locator(`${active} .screen[data-screen="${source.screen}"]`).count(), 1);
          } finally { await context.close(); }
        }
      }

      const recovery = await newContext();
      try {
        const page = await recovery.newPage();
        for (const unknown of ["no-such-team-" + crypto.randomUUID(), crypto.randomUUID()]) {
          await page.goto(`${base}/equipe/${unknown}?lang=pt-BR`);
          await page.locator(`${active} .screen[data-state="gone"]`).waitFor();
          assertEquals(await page.locator(`${active} h1`).textContent(), "Esta página não existe ou foi removida.");
          assertEquals(await page.locator('head link[rel="canonical"]').count(), 0);
          assertEquals(await page.locator(`${active} button`).count(), 0, "a missing record is not an outage");
          await page.locator(`${active} a[href]`).click();
          await page.waitForURL(url => url.pathname === "/");
          await waitReady(page);
        }
      } finally { await recovery.close(); }

      const outage = await newContext();
      try {
        const page = await outage.newPage();
        await page.route("**/crud/public_address?**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"acceptance lookup outage"}' }));
        await page.goto(`${base}/en/team/${slugs.team}`);
        await page.locator(`${active} .screen[data-state="network-error"] button`).waitFor({ timeout: 30_000 });
        assertEquals(await page.locator('head link[rel="canonical"]').count(), 0);
        await page.unroute("**/crud/public_address?**");
        await page.locator(`${active} .screen[data-state="network-error"] button`).click();
        await waitReady(page, ".team-current-championships a[href]");
        assertEquals(new URL(page.url()).pathname, `/en/team/${slugs.team}`);
      } finally { await outage.close(); }
    } finally {
      await browser.close();
      await psql(`DELETE FROM app_user WHERE id='${editor}'`);
    }
  },
});
