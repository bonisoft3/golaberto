/// <reference lib="dom" />
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { parseHTML } from "npm:linkedom@0.18.4";
import { evaluateRole } from "omnishell/interpreter/jessie.js";
import { batched } from "omnishell/interpreter/batched-store.js";
import { interpretScreen } from "omnishell/interpreter/screen.js";
import {
  parseFilter,
  parseLimit,
} from "omnishell/interpreter/fragment.js";
import { compileCatalog } from "omnishell/src/messages.ts";

const app = new URL("../", import.meta.url);
const playerId = "00000000-0000-4000-8000-000000000001";
const archiveId = `player-career-${playerId}`;
const archiveFilter = `id=eq.${archiveId}`;
const role = async (name: string, kind: "handler" | "renderer") =>
  evaluateRole(
    await Deno.readTextFile(
      new URL(
        `../shell/${kind === "handler" ? "handlers" : "renderers"}/${name}.js`,
        import.meta.url,
      ),
    ),
    kind,
  );
const row = (name: string, goals: number) => ({
  player_name: name,
  championship: { season: "2026" },
  championship_name: "Brasil",
  team_name: "Athletico",
  position: "fw",
  played: 30,
  started: 25,
  came_on: 5,
  bench: 0,
  minutes: 2300,
  goals,
  goals_per90: 0,
  contribution: -2,
  contribution_per90: null,
  off_rating: null,
  def_rating: 0,
  penalties: 0,
  own_goals: 0,
  yellow: 2,
  red: 0,
});

function playerCsvScreen(html: string) {
  const parsed = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
    .document;
  const player = parsed.querySelector<HTMLTemplateElement>(
    '[data-live="player_directory"] > template[data-item]',
  );
  assert(player, "Missing generated player template");
  const page = player.content.querySelector<HTMLElement>(
    '.seasons > .paged-read[data-on-mutation="player-csv-seed"]',
  );
  assert(page, "Missing generated player career page");
  const source = page.querySelector<HTMLElement>(
    '[data-on-mutation="player-csv-fold"]',
  );
  assert(source, "Missing generated player CSV fold");

  const focusedPage = page.cloneNode(false) as HTMLElement;
  const focusedSource = parsed.createElement("div");
  for (const attribute of source.attributes) {
    focusedSource.setAttribute(attribute.name, attribute.value);
  }
  focusedSource.innerHTML = "<template data-item><i></i></template>";
  focusedPage.append(focusedSource);
  return `<section class="screen" data-screen="jogador"><div data-live="player_directory" data-filter="id=eq.${playerId}"><template data-item><article>${focusedPage.outerHTML}</article></template></div></section>`;
}

async function mountPlayerCsv(html: string) {
  const ambient = { document: globalThis.document, fetch: globalThis.fetch };
  const { document } = parseHTML(
    "<!doctype html><html><head></head><body><div id=app></div></body></html>",
  );
  globalThis.document = document;
  const generated = JSON.parse(
    await Deno.readTextFile(new URL("shell/shell.json", app)),
  );
  const jogador = generated.routes.find((route: { screen: string }) =>
    route.screen === "jogador"
  );
  assert(jogador, "Missing jogador route");
  const fixtureHtml = "player-csv-regression.html";
  const fixtureCss = "player-csv-regression.css";
  const route = {
    ...jogador,
    files: {
      html: fixtureHtml,
      css: fixtureCss,
      handlers: jogador.files.handlers,
    },
  };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(fixtureHtml)) return new Response(html);
    if (path.endsWith(fixtureCss)) return new Response("");
    if (path.startsWith("/shell/") && path.endsWith(".js")) {
      return new Response(await Deno.readTextFile(new URL(path.slice(1), app)));
    }
    throw new Error(`Unexpected player CSV fixture request: ${url}`);
  };

  const currentRows = [
    { id: "stat-2", player_id: playerId, search_key: "", ...row("Second", 0) },
    { id: "stat-1", player_id: playerId, search_key: "", ...row("First", 4) },
    {
      id: "stat-other",
      player_id: "00000000-0000-4000-8000-000000000002",
      search_key: "",
      ...row("Other", 99),
    },
  ];
  const rows = new Map<string, Record<string, unknown>[]>([
    ["player_directory", [{ id: playerId }]],
    ["archive_page", []],
    ["player_stat", currentRows],
  ]);
  const subscriptions = new Map<string, Set<() => void>>();
  const notifications = new Set<() => void>();
  const reads: { table: string; filter: string }[] = [];
  const writes: { action: "put" | "update"; table: string; id: string }[] = [];
  const notify = (table: string) => {
    for (const callback of subscriptions.get(table) ?? []) {
      notifications.add(callback);
    }
  };
  const store = batched({
    query: (
      table: string,
      _order: unknown,
      options: { filter?: string } = {},
    ) => {
      const filter = options.filter ?? "";
      reads.push({ table, filter });
      const predicates = parseFilter(filter);
      assert(predicates !== null, `Invalid fixture filter: ${filter}`);
      const offset = Number(/(?:^|&)offset=(\d+)/.exec(filter)?.[1] ?? 0);
      const limit = parseLimit(filter);
      const selected = (rows.get(table) ?? []).filter((value) =>
        predicates.every((predicate: (row: unknown) => boolean) =>
          predicate(value)
        )
      );
      return Promise.resolve(
        selected.slice(
          offset,
          limit === undefined ? undefined : offset + limit,
        ),
      );
    },
    subscribe: (table: string, callback: () => void) => {
      const listeners = subscriptions.get(table) ?? new Set();
      listeners.add(callback);
      subscriptions.set(table, listeners);
      return () => listeners.delete(callback);
    },
    put: (table: string, value: Record<string, unknown>) => {
      const saved = rows.get(table) ?? [];
      const index = saved.findIndex((prior) => prior.id === value.id);
      if (index === -1) saved.push({ ...value });
      else saved[index] = { ...saved[index], ...value };
      rows.set(table, saved);
      writes.push({ action: "put", table, id: String(value.id) });
      notify(table);
      return Promise.resolve();
    },
    update: (table: string, id: string, value: Record<string, unknown>) => {
      const saved = rows.get(table) ?? [];
      const index = saved.findIndex((prior) => prior.id === id);
      assert(index !== -1, `Missing ${table} row ${id}`);
      saved[index] = { ...saved[index], ...value };
      writes.push({ action: "update", table, id });
      notify(table);
      return Promise.resolve();
    },
    create: (table: string) =>
      Promise.reject(new Error(`Unexpected create in ${table}`)),
    remove: (table: string) =>
      Promise.reject(new Error(`Unexpected delete in ${table}`)),
    flushNotifications: () => {
      const queued = [...notifications];
      notifications.clear();
      for (const callback of queued) callback();
      return queued.length;
    },
  });
  const mounted = document.getElementById("app");
  assert(mounted);
  const runtime = await interpretScreen(
    mounted,
    "http://player-csv.fixture/",
    route,
    store,
    { slug: "fixture" },
    {
      routes: generated.routes,
      i18n: generated.i18n,
      locale: "pt-BR",
      timeZone: "UTC",
    },
  );
  return {
    runtime,
    rows,
    reads,
    writes,
    close: () => {
      runtime.stop();
      globalThis.document = ambient.document;
      globalThis.fetch = ambient.fetch;
    },
  };
}

Deno.test("CSV folding exports the current ordered page and persists only changed page data", async () => {
  const seed = await role("player-csv-seed", "handler");
  const fold = await role("player-csv-fold", "handler");
  const view = { id: "championship-players-fixture", csv_rows: "[]", q: "" };
  assertEquals(seed({ items: [view], rows: { stored: [] } }), {
    updates: [{
      op: "put",
      entity: "archive_page",
      id: view.id,
      row: { csv_rows: "[]", q: "" },
    }],
  });
  assertEquals(seed({ items: [view], rows: { stored: [view] } }), {
    updates: [],
  });
  const items = [row("Second", 0), row("First", 4)];
  const result = fold({
    items,
    rows: { view: [view], unrelated: [row("Other", 99)] },
  });
  assertEquals(result.updates.length, 1);
  const updated = result.updates[0];
  assertEquals(updated.id, view.id);
  const rows = JSON.parse(updated.row.csv_rows);
  assertEquals(rows.map((value: unknown[]) => value[0]), ["Second", "First"]);
  assertEquals(rows[0], [
    "Second",
    "2026",
    "Brasil",
    "Athletico",
    "fw",
    30,
    25,
    5,
    0,
    2300,
    0,
    0,
    -2,
    null,
    null,
    0,
    0,
    0,
    2,
    0,
  ]);
  assertEquals(fold({ items, rows: { view: [{ ...view, ...updated.row }] } }), {
    updates: [],
  });
  assertEquals(
    fold({ items: [], rows: { view: [{ ...view, ...updated.row }] } })
      .updates[0].row.csv_rows,
    "[]",
  );
  assertEquals(fold({ items, rows: { view: [] } }), { updates: [] });
  assertThrows(
    () =>
      fold({
        items: Array.from({ length: 41 }, () => row("Overflow", 0)),
        rows: { view: [view] },
      }),
    Error,
    "40 rows",
  );
});

Deno.test("generated player CSV seed and fold settle on their shared archive row", async () => {
  const generated = await Deno.readTextFile(
    new URL("../shell/screens/jogador.html", import.meta.url),
  );
  const mounted = await mountPlayerCsv(playerCsvScreen(generated));
  try {
    await mounted.runtime.settle();
    const archived = mounted.rows.get("archive_page") ?? [];
    assertEquals(archived.length, 1);
    assertEquals(archived[0].id, archiveId);
    assertEquals(
      (JSON.parse(String(archived[0].csv_rows)) as unknown[][]).map((value) =>
        value[0]
      ),
      ["Second", "First"],
    );
    assert(
      mounted.reads.filter(({ table }) => table === "archive_page").every((
        { filter },
      ) => filter === archiveFilter),
      "Every archive read must use the page row's complete identity",
    );
    const settledWrites = mounted.writes.length;
    await mounted.runtime.settle();
    assertEquals(mounted.writes.length, settledWrites);
  } finally {
    mounted.close();
  }
});

Deno.test("CSV uses native download links with faithful numbers and escaped text in every locale", async () => {
  const fold = await role("player-csv-fold", "handler");
  const csv = await role("player-csv", "renderer");
  const position = await role("player-position", "renderer");
  const items = [
    row('Álvaro, "A"\nNovo', 0),
    row(" =SUM(A1:A2)", -1),
    row("\uFEFF\u00a0+SUM(A1:A2)", 0),
  ];
  const encoded =
    fold({ items, rows: { view: [{ id: "page", csv_rows: "[]" }] } }).updates[0]
      .row.csv_rows;
  for (const locale of ["pt-BR", "en-GB", "es-AR", "fr-FR", "de-DE", "it-IT"]) {
    const messages = compileCatalog(
      JSON.parse(
        await Deno.readTextFile(
          new URL(`../messages/${locale}.json`, import.meta.url),
        ),
      ),
    ) as Record<string, string>;
    const value = [
      encoded,
      messages.player_csv_columns,
      messages.player_csv_export,
      messages.player_csv_filename,
    ].join("\u001f");
    const nodes = csv(value);
    assertEquals(nodes.length, 1);
    assertEquals(nodes[0].tag, "a");
    assertEquals(nodes[0].attrs.download, messages.player_csv_filename);
    assertEquals(nodes[0].children, [messages.player_csv_export]);
    const text = decodeURIComponent(
      nodes[0].attrs.href.slice("data:text/csv;charset=utf-8,".length),
    );
    assert(text.startsWith("\uFEFF"));
    assert(text.includes('"Álvaro, ""A""\nNovo"'));
    assert(text.includes('"\' =SUM(A1:A2)"'));
    assert(text.includes('"\'\uFEFF\u00a0+SUM(A1:A2)"'));
    assert(text.includes(",2300,-1,0,-2,,"));
    assertEquals(position(`fw|${messages.player_positions}`), [
      messages.player_position_fw,
    ]);
    assertEquals(position(`|${messages.player_positions}`), [""]);
    assertEquals(
      csv(
        [
          "[]",
          messages.player_csv_columns,
          messages.player_csv_export,
          messages.player_csv_filename,
        ].join("\u001f"),
      ),
      [],
    );
  }
  const headings = JSON.stringify(
    Array.from({ length: 20 }, (_, index) => `Column ${index}`),
  );
  assertThrows(
    () =>
      csv([
        JSON.stringify(Array.from({ length: 41 }, () => Array(20).fill(0))),
        headings,
        "Export",
        "page.csv",
      ].join("\u001f")),
    Error,
    "Invalid player CSV page",
  );
  assertThrows(
    () => csv(["[[1]]", headings, "Export", "page.csv"].join("\u001f")),
    Error,
    "Invalid player CSV columns",
  );
});
