import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

const handler = async (name: string) =>
  await evaluateRole(
    await Deno.readTextFile(
      new URL(`../shell/handlers/${name}.js`, import.meta.url),
    ),
    "handler",
  );

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
  assertThrows(
    () => control(state, {}, { operation: "unknown" }),
    RangeError,
  );
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
