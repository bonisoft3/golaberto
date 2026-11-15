import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { executeFunction } from "./platform.ts";

// Inputs and normalize.py's answers, written by tools/sofascore/normalize_fixtures.py.
type Case = { name: string; input: Record<string, unknown>; expect?: unknown; raises?: string };
const cases: Case[] = JSON.parse(await Deno.readTextFile(new URL("./sofascore-normalize.json", import.meta.url)));
// The function as pronto emitted it, run in the executor PLV8 runs.
const { source, fuel: FUEL } = JSON.parse(await Deno.readTextFile(new URL("../.pronto/functions.json", import.meta.url))).sofascore_normalize as { source: string; fuel: number };
const normalize = async (input: unknown) => (await executeFunction(source, FUEL, input)).answer;
const measure = async (input: unknown) => (await executeFunction(source, FUEL, input)).spent;

// The day is SQL's (sofa.event_day): the function answers start_at instead.
const withoutDay = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutDay);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "day" && k !== "start_at").map(([k, v]) => [k, withoutDay(v)]));
  }
  return value;
};

Deno.test("the database function answers what normalize.py answers, the day aside", async () => {
  for (const c of cases.filter((c) => "expect" in c)) {
    assertEquals(withoutDay(await normalize(c.input)), withoutDay(c.expect), c.name);
  }
});

Deno.test("the database function refuses every payload normalize.py raises on", async () => {
  for (const c of cases.filter((c) => c.raises)) await assertRejects(() => normalize(c.input), Error, undefined, c.name);
});

Deno.test("an event's start is its UTC instant, and its kickoff is withheld while unconfirmed", async () => {
  for (const c of cases.filter((c) => c.input.kind === "events" && "expect" in c)) {
    const events = await normalize(c.input) as { start_at: string; kickoff: string | null }[];
    for (const [i, e] of events.entries()) {
      const expected = (c.expect as { kickoff: string | null }[])[i];
      assertEquals(e.kickoff, expected.kickoff, c.name);
      if (e.kickoff !== null) assertEquals(e.start_at, e.kickoff, c.name);
    }
  }
});

// Measured 5 November 2026: the fixtures at most 2,331 steps, a 20-event round
// 4,430, two 23-player lineups with 40 incidents 3,244. Fuel is the only bound
// plv8 enforces, so it is declared at tenfold or more over the largest.
Deno.test("fuel: the declared budget covers a full round with room to spare", async () => {
  const fixture = Math.max(...await Promise.all(cases.filter((c) => "expect" in c).map((c) => measure(c.input))));
  const roundCase = cases.find((c) => c.name === "extra time and penalties")!;
  const detailCase = cases.find((c) => c.name === "complete final")!;
  const raw = (roundCase.input.payload as { events: unknown[] }).events[0];
  const round = { kind: "events", payload: { events: Array.from({ length: 20 }, (_, i) => ({ ...(raw as object), id: i + 1 })) } };
  const player = (side: number, i: number, sub: boolean) => ({ player: { id: side * 100 + i, name: `P${i}` }, substitute: sub });
  const lineup = (side: number) => ({ players: Array.from({ length: 23 }, (_, i) => player(side, i + 1, i >= 11)) });
  const incidents = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, incidentType: i % 2 ? "card" : "substitution", incidentClass: "yellow", isHome: i % 4 < 2, time: i + 1, player: { id: 101 }, playerIn: { id: 112 }, playerOut: { id: 101 } }));
  const details = { ...detailCase.input, lineups: { home: lineup(1), away: lineup(2) }, incidents: { incidents } };
  const [roundSpent, detailsSpent] = [await measure(round), await measure(details)];
  const largest = Math.max(fixture, roundSpent, detailsSpent);
  console.log(`fuel spent: fixtures ${fixture}, 20-event round ${roundSpent}, two 23-player lineups with 40 incidents ${detailsSpent}; declared ${FUEL}`);
  assert(largest * 10 <= FUEL, `declared fuel ${FUEL} leaves less than tenfold headroom over ${largest}`);
});
