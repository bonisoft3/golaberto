import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { executeMecha, type Machine, walk } from "./platform.ts";

// The schedule's machines as pronto emitted them, stepped in the executor
// PLV8 runs.
const APP = new URL("../", import.meta.url);
const emitted = async <T>(path: string) => JSON.parse(await Deno.readTextFile(new URL(path, APP))) as T;
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// ScheduleTest's instant.
const NOW = Date.parse("2026-10-27T12:00:00Z");

type Spec = Machine & { name: string };
type State = Record<string, unknown> & { phase: string; due: number };
type Answer = { kind: string; state?: State; reason?: string; actions?: { type: string; params: { delay?: number } }[] };
const reducers = (await emitted<{ reducers: Record<string, Spec> }>(".pronto/check-inputs.json")).reducers;
const compiled = await emitted<Record<string, { source: string }>>(".pronto/mecha-reducers.json");
const machine = (name: string) => {
  const spec = reducers[name];
  const source = compiled[name]?.source;
  if (!spec || !source) throw new Error(`unknown mecha machine ${name}`);
  const run = (input: unknown) => executeMecha(source, spec.fuel, input) as Promise<Answer>;
  const spawn = async (payload: unknown, now = NOW) =>
    (await run({ initialize: true, payload, viewers: [], context: { tier: "mecha", now } })).state!;
  const step = (state: State, kind: string, payload: unknown, now = NOW) =>
    run({ state, event: { kind, payload }, context: { tier: "mecha", now }, viewers: [] });
  const accepted = async (state: State, kind: string, payload: unknown, now = NOW) => {
    const answer = await step(state, kind, payload, now);
    assertEquals(answer.kind, "accepted", `${kind} from ${state.phase}: ${answer.reason}`);
    return answer.state!;
  };
  return { spec, source, spawn, step, accepted };
};
const resource = machine("sofa_resource");
const provider = machine("sofa_provider");

const answer = (owed: unknown[] = [], facts: Record<string, unknown> = {}) => ({
  owed, kept: false, terminal: false, unresolved: false, fixtures: false, complete: false, max_age: -1, ends: 0, ...facts,
});
const fixture = (status: string, kickoff: string | null, day = "2026-10-27") =>
  ({ status, kickoff: kickoff ? Date.parse(kickoff) : 0, day: Date.parse(`${day}T00:00:00Z`) });
const fresh = (family: string) => resource.spawn({ family, due: NOW, owed: [] });

// The cadence tools/sofascore/schedule.py set: the expected delays are ScheduleTest's.
Deno.test("a round is asked again by its soonest owed fixture's distance to kickoff", async () => {
  const delay = async (owed: unknown[]) => (await resource.accepted(await fresh("round"), "fetched", answer(owed))).due - NOW;
  assertEquals(await delay([fixture("in_progress", "2026-10-27T11:00:00Z")]), 20 * MINUTE);
  assertEquals(await delay([fixture("scheduled", "2026-10-27T14:00:00Z")]), 2 * HOUR);
  assertEquals(await delay([fixture("scheduled", "2026-11-16T12:00:00Z")]), 7 * DAY);
  assertEquals(await delay([fixture("postponed", null)]), DAY);
  assertEquals(await delay([fixture("finished", "2026-10-27T11:00:00Z")]), 7 * DAY);
  assertEquals(await delay([fixture("scheduled", null, "2026-10-27")]), 20 * MINUTE);
  assertEquals(await delay([fixture("scheduled", null, "2026-10-29")]), 4 * HOUR);
});

Deno.test("an incomplete detail retries at 20 minutes, 2 hours, a day and a week, then goes to review", async () => {
  let state = await fresh("lineups");
  const delays: (number | string)[] = [];
  for (let i = 0; i < 5; i++) {
    state = await resource.accepted(state, "fetched", answer());
    delays.push(state.phase === "review" ? "review" : state.due - NOW);
  }
  assertEquals(delays, [20 * MINUTE, 2 * HOUR, DAY, 7 * DAY, "review"]);
  assertEquals(state.due, 0);
});

Deno.test("a complete detail is corrected once the next day, then is done", async () => {
  let state = await resource.accepted(await fresh("incidents"), "fetched", answer([], { complete: true }));
  assertEquals([state.phase, state.due - NOW], ["idle", DAY]);
  state = await resource.accepted(state, "fetched", answer([], { complete: true }));
  assertEquals([state.phase, state.due], ["done", 0]);
});

Deno.test("a pair completed by its other half owes only its next-day check", async () => {
  const state = await resource.accepted(await fresh("lineups"), "paired", {});
  assertEquals([state.phase, state.due - NOW, state.complete_checks], ["idle", DAY, 1]);
  assertEquals((await resource.accepted(state, "fetched", answer([], { complete: true }))).phase, "done");
});

Deno.test("a failure waits for Retry-After, or backs off from a minute doubling to 4 hours 16 minutes", async () => {
  const after = async (retry_at: number, failures = 0) => {
    const state = { ...(await fresh("round")), failures };
    return (await resource.accepted(state, "failed", { status: 503, retry_at })).due - NOW;
  };
  assertEquals(await after(NOW + 120000), 120000);
  assertEquals(await after(Date.parse("2026-10-27T12:05:00Z")), 5 * MINUTE);
  assertEquals(await after(NOW), 30000);
  assert(await after(0, 4) > await after(0, 1));
  assertEquals(await after(0, 20), 4 * HOUR + 16 * MINUTE);
});

Deno.test("five failed fetches send a detail to review, while a round keeps backing off", async () => {
  let detail = await fresh("incidents");
  let round = await fresh("round");
  for (let i = 0; i < 5; i++) {
    detail = await resource.accepted(detail, "failed", { status: 500, retry_at: 0 });
    round = await resource.accepted(round, "failed", { status: 500, retry_at: 0 });
  }
  assertEquals([detail.phase, detail.due, detail.failures], ["review", 0, 5]);
  assertEquals([round.phase, round.failures], ["backoff", 5]);
  assertEquals((await resource.accepted(round, "fetched", answer([fixture("scheduled", "2026-11-16T12:00:00Z")]))).failures, 0);
});

Deno.test("a terminal event is checked once the next day, then stops", async () => {
  const done = answer([fixture("finished", "2026-10-27T11:00:00Z")], { kept: true, terminal: true });
  let state = await resource.accepted(await fresh("event"), "fetched", done);
  assertEquals([state.phase, state.due - NOW, state.settled], ["idle", DAY, true]);
  state = await resource.accepted(state, "fetched", done);
  assertEquals([state.phase, state.due], ["done", 0]);
});

Deno.test("a cache's max-age holds a resource back, and a season past its end is audited weekly", async () => {
  const cached = await resource.accepted(await fresh("round"), "fetched", answer([fixture("in_progress", "2026-10-27T11:00:00Z")], { max_age: 7200 }));
  assertEquals(cached.due - NOW, 2 * HOUR);
  const ends = Date.parse("2026-08-01T00:00:00Z");
  const closing = await resource.accepted(await fresh("rounds"), "fetched", answer([], { ends: Date.parse("2026-10-20T00:00:00Z") }));
  assertEquals(closing.due, Date.parse("2026-11-19T00:00:00Z"));
  const audited = await resource.accepted(await fresh("rounds"), "fetched", answer([], { ends, unresolved: true }));
  assertEquals(audited.due - NOW, 7 * DAY);
  assertEquals((await resource.accepted(await fresh("rounds"), "fetched", answer([], { ends }))).phase, "done");
});

Deno.test("an admitted request owns its resource until it answers, fails, or is given up as stuck", async () => {
  const due = await resource.accepted(await fresh("round"), "xstate.after.ripe.idle", {});
  assertEquals(due.phase, "due");
  const acquiring = await resource.accepted(due, "admitted", { request: crypto.randomUUID() });
  // Its timer waits the time left until it is due, from the step that admitted it.
  assertEquals([acquiring.phase, acquiring.due - NOW, acquiring.wait], ["acquiring", 30 * MINUTE, 30 * MINUTE]);
  assertEquals((await resource.accepted(acquiring, "xstate.after.ripe.acquiring", {}, NOW + 30 * MINUTE)).phase, "due");
  assert((await resource.accepted(acquiring, "fetched", answer())).phase !== "acquiring");
  assert((await resource.accepted(acquiring, "failed", { status: 502, retry_at: 0 })).phase !== "acquiring");
  assertEquals((await resource.step(await fresh("round"), "admitted", { request: "x" })).kind, "rejected");
});

Deno.test("a seen fixture pulls an untroubled resource's next ask forward, never back", async () => {
  const later = await resource.spawn({ family: "event", due: 0, owed: [fixture("scheduled", "2026-11-16T12:00:00Z")] });
  assertEquals(later.due - NOW, 7 * DAY);
  const hastened = await resource.step(later, "hasten", { owed: [fixture("scheduled", "2026-10-27T14:00:00Z")] });
  const pulled = hastened.state!;
  assertEquals([pulled.due - NOW, pulled.wait], [2 * HOUR, 2 * HOUR]);
  // The idle resource is entered again, and its timer starts over at the time left.
  assertEquals(hastened.actions?.map((a) => [a.type, a.params.delay]), [["xstate.cancel", undefined], ["xstate.raise", 2 * HOUR]]);
  assertEquals((await resource.accepted(pulled, "hasten", { owed: [fixture("scheduled", "2026-11-16T12:00:00Z")] })).due - NOW, 2 * HOUR);
  const troubled = await resource.accepted(later, "failed", { status: 500, retry_at: 0 });
  assertEquals((await resource.accepted(troubled, "hasten", { owed: [fixture("in_progress", "2026-10-27T11:00:00Z")] })).due, troubled.due);
});

Deno.test("the provider pauses on 401 and 403 until resumed, and blocks on 429 until its instant", async () => {
  const open = await provider.spawn({});
  assertEquals((await provider.accepted(open, "refused", { status: 503, until: 0 })).phase, "open");
  const blocked = await provider.accepted(open, "refused", { status: 429, until: NOW + 10 * MINUTE });
  assertEquals([blocked.phase, blocked.until, blocked.wait], ["blocked", NOW + 10 * MINUTE, 10 * MINUTE]);
  // A lesser refusal meanwhile enters the block again, its timer waiting only the time left.
  assertEquals((await provider.accepted(blocked, "refused", { status: 503, until: 0 }, NOW + MINUTE)).wait, 9 * MINUTE);
  assertEquals((await provider.accepted(blocked, "xstate.after.block.blocked", {}, NOW + 10 * MINUTE)).phase, "open");
  const paused = await provider.accepted(blocked, "refused", { status: 403, until: 0 });
  assertEquals([paused.phase, paused.reason], ["paused", "HTTP 403"]);
  assertEquals((await provider.accepted(paused, "refused", { status: 429, until: NOW + DAY })).phase, "paused");
  assertEquals((await provider.accepted(paused, "resumed", {})).phase, "open");
});

// Random events from every phase never crash the rules or break their
// invariant; a resource reaches every phase from its first one.
Deno.test("the schedule's reducers hold their invariants under a random walk", async () => {
  const open = await provider.spawn({});
  const blocked = await provider.accepted(open, "refused", { status: 429, until: NOW + MINUTE });
  const paused = await provider.accepted(open, "refused", { status: 401, until: 0 });
  for (const [m, start, phases] of [
    [resource, await fresh("lineups"), ["acquiring", "backoff", "done", "due", "idle", "review"]],
    [resource, await fresh("round"), ["acquiring", "backoff", "due", "idle"]],
    [provider, open, []],
    [provider, blocked, []],
    [provider, paused, []],
  ] as const) {
    for (const seed of [1, 2, 3]) {
      const walked = await walk(m.spec, m.source, start, [], seed, 2000);
      assertEquals(walked.crashes, []);
      for (const phase of phases) assert(walked.visited.includes(phase), `${m.spec.name} never reached ${phase}: ${walked.visited}`);
    }
  }
});
