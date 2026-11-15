/// <reference lib="dom" />
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched, evaluateRole, interpretScreen, parseFilter } from "./platform.ts";

// The assertions below state a leaf's world and its event side by side; the
// leaf itself takes them as XState's one argument.
// deno-lint-ignore no-explicit-any
const positional = (leaf: any) => (state: any, event?: any, ...rest: any[]) => leaf({ context: state, event }, ...rest);

const handler = async (name: string) =>
  positional(await evaluateRole(
    await Deno.readTextFile(
      new URL(`../shell/handlers/${name}.js`, import.meta.url),
    ),
    "handler",
  ));

const control = await handler("match-probability-event-control");
const edit = await handler("match-probability-event-edit");
const fold = await handler("match-probability-event-fold");
const seed = await handler("match-probability-seed");

Deno.test("event control derives stable identities and enforces the twenty-event bound", () => {
  const row = {
    id: "78869558-771e-4f5d-98bc-9065c7f8ff92",
    event_sequence: 7,
    event_count: 2,
  };
  const state = { items: [row] };
  assertEquals(control(state, {}, { operation: "can-add" }), true);
  assertEquals(control(state, {}, { operation: "next-sequence" }), 8);
  assertEquals(control(state, {}, { operation: "next-count" }), 3);
  assertEquals(
    control(state, {}, { operation: "next-id" }),
    "78869558-771e-4f5d-98bc-9065c7f8ff92:hyp:8",
  );
  assertEquals(
    control(
      { items: [{ ...row, event_count: 20 }] },
      {},
      { operation: "can-add" },
    ),
    false,
  );
  const exhausted = { items: [{ ...row, event_sequence: 2147483647 }] };
  assertEquals(control(exhausted, {}, { operation: "can-add" }), false);
  assertEquals(control(exhausted, {}, { operation: "next-sequence" }), 2147483647);
  assertEquals(control(exhausted, {}, { operation: "next-id" }), `${row.id}:hyp:2147483647`);
  const last = { items: [{ ...row, event_sequence: 2147483646 }] };
  assertEquals(control(last, {}, { operation: "can-add" }), true);
  assertEquals(control(last, {}, { operation: "next-sequence" }), 2147483647);
  assertEquals(control(last, {}, { operation: "next-id" }), `${row.id}:hyp:2147483647`);
  assertEquals(control({ items: [{ ...row, event_count: 20 }] }, {}, { operation: "next-count" }), 20);
  assertThrows(() => control({ items: [{ ...row, event_sequence: 2147483648 }] }, {}, { operation: "can-add" }), RangeError);
  assertThrows(
    () => control(state, {}, { operation: "unknown" }),
    RangeError,
  );
});

Deno.test("exhaustion is visible and the mounted chart never creates a duplicate event", async () => {
  const app = new URL("../", import.meta.url);
  const markup = await Deno.readTextFile(new URL("shell/screens/jogo.html", app));
  const emitted = parseHTML(markup.slice(markup.indexOf('<section class="match-probability-shell"'))).document;
  const source = emitted.querySelector('[data-live="match_probability_scenario"][data-machine]')!;
  const notice = source.querySelector('[data-live="match_probability_scenario"][data-filter*="event_sequence="]')!;
  assert(notice, "generated screen must carry the exhaustion notice");
  const machine = source.getAttribute("data-machine")!;
  const html = `<section data-screen="fixture"><div data-live="match_probability_scenario" data-filter="id=eq.game" data-machine='${machine}'><button id="match-probability-add-goal">Add</button>${notice.outerHTML}</div></section>`;
  const { document, window } = parseHTML('<html><head></head><body><div id="app"></div></body></html>');
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  globalThis.document = document;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("fixture.html")) return new Response(html);
    if (path.endsWith("fixture.css")) return new Response("");
    if (path.endsWith("match-probability-event-control.js")) return new Response(await Deno.readTextFile(new URL("shell/handlers/match-probability-event-control.js", app)));
    throw new Error(`Unexpected fixture request ${url}`);
  };
  const row = { id: "game", state: "ready", event_sequence: 2147483646, event_count: 0 };
  const created: unknown[] = [];
  const subscribers = new Map<string, Set<() => void>>();
  const store = batched({
    query: async (table: string, _order: unknown, options: {filter?: string} = {}) => {
      const predicates = parseFilter(options.filter ?? "");
      return table === "match_probability_scenario" && (!predicates || predicates.every((match: (row: unknown) => boolean) => match(row))) ? [row] : [];
    },
    subscribe: (table: string, wake: () => void) => {
      const group = subscribers.get(table) ?? new Set();
      group.add(wake);
      subscribers.set(table, group);
      return () => group.delete(wake);
    },
    put: async (table: string, value: object) => {
      Object.assign(row, value);
      for (const wake of subscribers.get(table) ?? []) wake();
    },
    create: async (_table: string, value: unknown) => { created.push(value); },
  });
  let runtime: Awaited<ReturnType<typeof interpretScreen>> | undefined;
  try {
    const messages = JSON.parse(await Deno.readTextFile(new URL("messages/en-US.json", app)));
    runtime = await interpretScreen(document.getElementById("app"), "http://fixture/", {
      screen: "fixture", files: {html: "fixture.html", css: "fixture.css", handlers: ["shell/handlers/match-probability-event-control.js"]},
    }, store, {}, {messages, locale: "en-US"});
    await runtime.settle();
    assertEquals(document.querySelector('[role="status"]'), null);
    document.getElementById("match-probability-add-goal")!.dispatchEvent(new window.Event("click", {bubbles: true}));
    await runtime.settle();
    assertEquals(created.length, 1);
    assertEquals((created[0] as {id: string}).id, "game:hyp:2147483647");
    assertEquals(row.event_sequence, 2147483647);
    assert(document.querySelector('[role="status"]')?.textContent?.includes("identifier limit"));
    document.getElementById("match-probability-add-goal")!.dispatchEvent(new window.Event("click", {bubbles: true}));
    await runtime.settle();
    assertEquals(created.length, 1);
    assertEquals(row.event_sequence, 2147483647);
  } finally {
    runtime?.stop();
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

Deno.test("event edits change only the native control's own field", () => {
  const row = { id: "game:hyp:1", side: "home", minute: 12 };
  const state = { items: [row] };
  const side = {
    from: "game:hyp:1-side",
    value: "away",
  };
  assertEquals(edit(state, side, { field: "side" }), "away");
  assertEquals(edit(state, { ...side, from: "other:hyp:1-side" }, { field: "side" }), "home");
  assertEquals(edit(state, side, { field: "minute" }), 12);
  const minute = {
    from: "game:hyp:1-minute",
    value: "44",
    valueAsNumber: 44,
  };
  assertEquals(edit(state, minute, { field: "minute" }), 44);
  assertEquals(edit(state, minute, { field: "side" }), "home");
  assertEquals(
    edit(
      state,
      { from: "game:hyp:1-minute", valueAsNumber: 131 },
      { field: "minute" },
    ),
    12,
  );
  assertEquals(
    edit(
      state,
      { from: "game:hyp:1-remove" },
      { field: "remove" },
    ),
    true,
  );
  assertEquals(
    edit(
      state,
      { from: "game:hyp:1-side" },
      { field: "remove" },
    ),
    false,
  );
});

Deno.test("event fold validates, orders and projects independently editable rows", () => {
  const view = {
    id: "78869558-771e-4f5d-98bc-9065c7f8ff92",
    events_json: "[]",
    event_count: 0,
  };
  const first = {
    id: "game:hyp:1",
    sequence: 1,
    kind: "goal",
    side: "away",
    minute: 17,
  };
  const second = {
    id: "game:hyp:2",
    sequence: 2,
    kind: "red_card",
    side: "home",
    minute: 66,
  };
  const result = fold({
    items: [second, first],
    rows: { view: [view] },
  });
  assertEquals(result, {
    updates: [{
      op: "patch",
      entity: "match_probability_scenario",
      id: view.id,
      row: {
        events_json: JSON.stringify([first, second]),
        event_count: 2,
      },
    }],
  });
  assertEquals(
    fold({
      items: [first, second],
      rows: {
        view: [{
          ...view,
          events_json: JSON.stringify([first, second]),
          event_count: 2,
        }],
      },
    }),
    { updates: [] },
  );
  assertThrows(
    () =>
      fold({
        items: Array.from({ length: 21 }, (_, index) => ({
          ...first,
          id: `game:hyp:${index + 1}`,
          sequence: index + 1,
        })),
        rows: { view: [view] },
      }),
    RangeError,
  );
  assertThrows(
    () =>
      fold({
        items: [{ ...first, side: "other" }],
        rows: { view: [view] },
      }),
    RangeError,
  );
});

// The chart reads the scenario row only: a nested row cannot bind its parent's
// fields, and a machine row exists only once stored, so the seed carries both.
Deno.test("scenario seed stores the fallback with the game's probabilities, then tracks them", () => {
  const fallback = { id: "g", state: "ready", minute: "0", payload_json: "", home_name: "", away_name: "" };
  const source = { id: "g", payload_json: '{"home_power":1}', home_name: "A", away_name: "B" };
  const carried = { payload_json: '{"home_power":1}', home_name: "A", away_name: "B" };
  assertEquals(seed({ items: [fallback], rows: { source: [source] } }), {
    updates: [{
      op: "put",
      entity: "match_probability_scenario",
      id: "g",
      row: { state: "ready", minute: "0", ...carried },
    }],
  });
  const stored = { ...fallback, ...carried, minute: "37" };
  assertEquals(seed({ items: [stored], rows: { stored: [stored], source: [source] } }), { updates: [] });
  assertEquals(
    seed({ items: [stored], rows: { stored: [stored], source: [] } }).updates,
    [{ op: "patch", entity: "match_probability_scenario", id: "g", row: { payload_json: "", home_name: "", away_name: "" } }],
  );
  assertEquals(seed({ items: [], rows: {} }), { updates: [] });
});
