import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { executeFunction } from "./platform.ts";

// Inputs and the answers of runtime.reconcile_events and reconcile.event_patch,
// written by tools/sofascore/reconcile_fixtures.py.
type Case = { name: string; input: Record<string, unknown>; expect?: unknown; error?: string };
const cases: Case[] = JSON.parse(await Deno.readTextFile(new URL("./sofascore-reconcile.json", import.meta.url)));
// The function as pronto emitted it, run in the executor PLV8 runs.
const { source, fuel: FUEL } = JSON.parse(await Deno.readTextFile(new URL("../.pronto/functions.json", import.meta.url))).sofascore_reconcile as { source: string; fuel: number };
const reconcile = async (input: unknown) => (await executeFunction(source, FUEL, input)).answer;

// Python names a new fixture by uuid5; the function leaves it unnamed, since
// the database creates the game and binds it to the provider event. Every id
// Python generated, a game id the input's context does not hold, reads as null.
const generatedAsNull = (input: Record<string, unknown>, expect: unknown): unknown => {
  const known = new Set(((input.ctx as { games?: { id: string }[] })?.games ?? []).map((g) => String(g.id)));
  const generated = new Set<string>();
  const find = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(find);
    else if (v !== null && typeof v === "object") {
      const row = v as { table?: unknown; id?: unknown };
      if (row.table === "game" && typeof row.id === "string" && !known.has(row.id)) generated.add(row.id);
      Object.values(v).forEach(find);
    }
  };
  find(expect);
  const walk = (v: unknown): unknown =>
    typeof v === "string" && generated.has(v) ? null
    : Array.isArray(v) ? v.map(walk)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v;
  return walk(expect);
};

Deno.test("the database function answers what the Python checks and event_patch answer", async () => {
  for (const c of cases.filter((c) => "expect" in c)) assertEquals(await reconcile(c.input), generatedAsNull(c.input, c.expect), c.name);
});

Deno.test("the database function refuses every response the Python checks refuse", async () => {
  for (const c of cases.filter((c) => c.error)) await assertRejects(() => reconcile(c.input), Error, undefined, c.name);
});

// Measured 5 November 2026; the declared fuel keeps tenfold headroom over a
// 40-event round against 400 championship games.
Deno.test("fuel: the declared budget covers a large round with room to spare", async () => {
  const base = cases.find((c) => c.name === "new fixture with a final")!.input as {
    raw_events: Record<string, unknown>[]; events: Record<string, unknown>[]; ctx: { games: unknown[] };
  };
  const raw_events = Array.from({ length: 40 }, (_, i) => ({ ...base.raw_events[0], id: i + 1 }));
  const events = Array.from({ length: 40 }, (_, i) => ({ ...base.events[0], external_id: String(i + 1) }));
  const games = Array.from({ length: 400 }, (_, i) => ({ id: `g${i}`, external_id: String(i + 1000), phase_id: "phase", home_id: "x", away_id: "y", played: false, sync_status: null }));
  const { spent } = await executeFunction(source, FUEL, { ...base, raw_events, events, ctx: { ...base.ctx, games } });
  console.log(`fuel spent: 40-event round over 400 games ${spent}; declared ${FUEL}`);
  assert(spent * 10 <= FUEL, `declared fuel ${FUEL} leaves less than tenfold headroom over ${spent}`);
});
