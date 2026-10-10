/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { parseHTML } from "npm:linkedom@0.18.4";
import { evaluateRole } from "omnishell/interpreter/jessie.js";
import { interpretScreen } from "omnishell/interpreter/screen.js";
import { batched } from "omnishell/interpreter/batched-store.js";
import { compileCatalog } from "omnishell/interpreter/vendor/messages.js";
import { built } from "./terminal-nodes.ts";
import { parseFilter, parseLimit } from "omnishell/interpreter/fragment.js";
const app = new URL(
  Deno.env.get("COMMUNITY_APP_URL") ?? "../",
  import.meta.url,
);
const stage = Deno.env.get("COMMUNITY_UI_URL");
const asset = (name: string) =>
  stage ? new URL(name, stage) : new URL(
    name.endsWith(".html")
      ? `shell/screens/${name}`
      : name.startsWith("messages-")
      ? `messages/${name.slice(9)}`
      : `shell/renderers/${name}`,
    app,
  );
const id = "00000000-0000-4000-8000-000000000001";
const biography = "00000000-0000-4000-8000-000000000002";
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

async function mount(rows: Record<string, Record<string, unknown>[]>) {
  const html = await Deno.readTextFile(asset("usuario.html"));
  const { document, Event } = parseHTML(
    '<html><head></head><body><div id="app"></div></body></html>',
  );
  const priorDocument = globalThis.document, priorFetch = globalThis.fetch;
  globalThis.document = document;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith(".html")) return new Response(html);
    if (path.endsWith(".css")) return new Response("");
    if (path.endsWith("community-history.js") || path.endsWith("media-image.js")) {
      return new Response(
        await Deno.readTextFile(asset(path.split("/").at(-1)!)),
      );
    }
    if (path.endsWith(".js")) {
      return new Response(await Deno.readTextFile(new URL(path.slice(1), app)));
    }
    throw new Error(`Unexpected community fixture request ${url}`);
  };
  const calls: unknown[] = [];
  const store = batched({
    query: async (
      table: string,
      _order: unknown,
      options: { filter?: string } = {},
    ) => {
      const filter = options.filter ?? "";
      const predicates = parseFilter(filter);
      const found = (rows[table] ?? []).filter((row) =>
        predicates === null ||
        predicates.every((p: (r: unknown) => boolean) => p(row))
      );
      return found.slice(0, parseLimit(filter));
    },
    subscribe: () => () => {},
    create: async (table: string, row: unknown) => {
      calls.push({ table, row });
    },
    update: async (table: string, key: string, row: unknown) => {
      calls.push({ table, key, row });
    },
    put: async () => {},
    remove: async () => {},
  });
  const messages = {
    ...JSON.parse(await Deno.readTextFile(new URL("messages/pt-BR.json", app))),
    ...JSON.parse(await Deno.readTextFile(asset("messages-pt-BR.json"))),
  };
  const mounted = document.getElementById("app")!;
  const runtime = await interpretScreen(
    mounted,
    "http://community.fixture/",
    {
      screen: "usuario",
      files: {
        html: "usuario.html",
        css: "community.css",
        adapters: ["shell/handlers/editing-text.js"],
        handlers: ["shell/handlers/page-value.js"],
        renderers: ["community-history.js", "media-image.js"],
      },
      states: [
        "loading",
        "populated",
        "gone",
        "validation-error",
        "form-submit",
        "success",
        "network-error",
      ],
    },
    store,
    { id },
    {
      routes: [
        { screen: "principal", path: "/" },
        { screen: "gerenciar", path: "/gerenciar" },
        { screen: "usuarios", path: "/usuarios" },
        { screen: "usuario", path: "/usuario/:id" },
        { screen: "jogo", path: "/jogo/:slug" },
      ],
      messages,
      locale: "pt-BR",
      timeZone: "UTC",
    },
  );
  await tick();
  for (const f of mounted.querySelectorAll("form")) {
    f.checkValidity = () => true;
    f.reset = () => {};
  }
  return {
    mounted,
    Event,
    calls,
    close() {
      runtime.stop();
      globalThis.document = priorDocument;
      globalThis.fetch = priorFetch;
    },
  };
}
const profile = {
  id,
  handle: "Original",
  display_name: "Public",
  location: null,
  about_me: "<img src=x>",
  joined_at: "2020-01-01T00:00:00Z",
  joined_on: "01/01/2020",
  biography_id: null,
  user_avatar: null,
  comment_count: 0,
  edit_count: 0,
  last_edit_at: null,
  search_key: "Public",
};
Deno.test("community profile forms require server eligibility and use biography keys", async () => {
  for (const exists of [false, true]) {
    const f = await mount({
      user_directory: [profile],
      community_access: [{
        id: `profile:${id}`,
        record_id: id,
        kind: "profile",
        biography_id: exists ? biography : null,
        avatar_id: null,
      }],
      user_biography: exists
        ? [{
          id: biography,
          app_user_id: id,
          display_name: "Before",
          location: null,
          about_me: null,
          updated_at: "2020-01-01T00:00:00Z",
        }]
        : [],
    });
    try {
      const form = f.mounted.querySelector<HTMLFormElement>("form")!;
      assert(form);
      assertEquals(form.dataset.action, exists ? "update" : "create");
      const name = form.querySelector<HTMLInputElement>(
        '[name="display_name"]',
      )!;
      name.value = "After";
      form.dispatchEvent(
        new f.Event("submit", { bubbles: true, cancelable: true }),
      );
      await tick();
      assertEquals(f.calls.length, 1);
      const call = f.calls[0] as {
        table: string;
        key?: string;
        row: Record<string, unknown>;
      };
      assertEquals(call.table, "user_biography");
      assertEquals(call.key, exists ? biography : undefined);
      assertEquals(call.row.display_name, "After");
      assert(!Object.hasOwn(call.row, "app_user_id"));
      assertEquals(
        f.mounted.querySelectorAll(".community-about img").length,
        0,
      );
    } finally {
      f.close();
    }
  }
  const denied = await mount({
    user_directory: [profile],
    community_access: [],
  });
  try {
    assertEquals(denied.mounted.querySelectorAll("form").length, 0);
  } finally {
    denied.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
});
Deno.test("community history renders zero and unknown values as text and rejects unapproved fields", async () => {
  const renderNodes = await evaluateRole(
    await Deno.readTextFile(asset("community-history.js")),
    "renderer",
  );
  const render = (value: string) => built(renderNodes(value));
  const fields = [
    "phase_id", "round", "day", "kickoff", "home_id", "away_id", "home_field",
    "played", "home_score", "away_score", "home_aet", "away_aet", "home_pen",
    "away_pen", "stadium_id", "referee_id", "attendance",
  ];
  // Compiled as render and the shell compile them: a label catalog the reader
  // accepted as JSON once crashed the render service at boot.
  const catalogs = await Promise.all(
    ["de-DE", "en-GB", "es-AR", "fr-FR", "it-IT", "pt-BR"].map(async (locale) =>
      compileCatalog(
        JSON.parse(await Deno.readTextFile(asset(`messages-${locale}.json`))),
      ) as Record<string, unknown>
    ),
  );
  for (const catalog of catalogs) {
    for (const field of fields) {
      assertEquals(typeof catalog[`community_field_${field}`], "string");
    }
  }
  const labels = [
    ...fields.map((field) => catalogs[5][`community_field_${field}`]),
    ...["manage_home_advantage", "manage_neutral", "manage_away_advantage", "community_yes", "community_no"]
      .map((key) => catalogs[5][key]),
  ];
  const input = (value: unknown) =>
    [JSON.stringify(value), "Unknown", "Before", "After", ...labels].join(
      "\u001f",
    );
  const nodes = render(
    input({
      attendance: { before: null, after: 0 },
      day: { before: "<img onerror=alert(1)>", after: "2026-06-01" },
    }),
  );
  const text = JSON.stringify(nodes);
  assert(text.includes("After: 0"));
  assert(text.includes("Before: Unknown"));
  assert(text.includes("<img onerror=alert(1)>"));
  assert(!text.includes('"tag":"img"'));
  assertThrows(() =>
    render(input({ password: { before: "secret", after: "other" } }))
  );
  // Codes once reached readers as stored: "left", "true".
  const coded = JSON.stringify(render(input({
    home_field: { before: "left", after: "neutral" },
    played: { before: false, after: true },
  })));
  for (const word of ["Before: Mando da casa", "After: Campo neutro", "Before: Não", "After: Sim"]) {
    assert(coded.includes(word), `${word} missing from ${coded}`);
  }
  assert(!coded.includes(": left") && !coded.includes(": true"));
  assertThrows(() => render(input({ home_field: { before: "left", after: "sideways" } })));
  assertThrows(() =>
    render(input({ day: { before: { malicious: true }, after: "today" } }))
  );
  assertThrows(() =>
    render(input({ day: { before: "a", after: "b" } }).split("\u001f").slice(0, -1).join("\u001f"))
  );
});
