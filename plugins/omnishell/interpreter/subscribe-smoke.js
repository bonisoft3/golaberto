// Deno smoke: a region wakes on its own input changing, and not on every write
// to the table it happens to read.
//
// The engine already hands `subscribeChanges` a change set. Dropping it and
// re-reading the whole collection means a comment written on any article
// re-queries the comment region of every article on screen — the cost the
// filter exists to avoid. These assertions guard the direction of that gate:
// a matching row must always wake the region, and anything the filter cannot
// decide must wake it too, because being unsure costs a re-read while being
// wrong costs a stale screen.
import {
  createStore,
  embedDeps,
  embedTables,
  isMaintainable,
  parseFilter,
  parseFilterSpec,
  parseLimit,
  parseOffset,
  parseSelect,
  touches,
} from "./data-sync.js";
import * as fragment from "./fragment.js";
import { FIXTURE_CARRIERS } from "./fixture-types.js";

const { parseReadSpec } = fragment;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

const waitWake = async (wakes) => {
  for (let i = 0; i < 20 && wakes.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

// The grammar has one reader: the store adapter re-exports fragment.js's
// parsers unchanged, so both import paths hold the same function objects.
Deno.test("the fragment parsers have one definition", () => {
  assert(fragment.parseFilter === parseFilter, "parseFilter");
  assert(fragment.parseFilterSpec === parseFilterSpec, "parseFilterSpec");
  assert(fragment.parseLimit === parseLimit, "parseLimit");
  assert(fragment.parseSelect === parseSelect, "parseSelect");
});

const insert = (value) => ({ type: "insert", key: String(value.id), value });
const remove = (previousValue) => ({ type: "delete", key: String(previousValue.id), previousValue });
const change = (previousValue, value) => ({ type: "update", key: String(value.id), previousValue, value });

Deno.test("a row matching the filter wakes the region", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(touches(preds, [insert({ id: "c1", article_id: "a1" })]), "insert into the region");
  assert(touches(preds, [remove({ id: "c1", article_id: "a1" })]), "delete from the region");
});

Deno.test("a row the region could never show does not wake it", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(!touches(preds, [insert({ id: "c2", article_id: "a2" })]), "another article's comment");
  assert(
    !touches(preds, [insert({ id: "c2", article_id: "a2" }), remove({ id: "c3", article_id: "a3" })]),
    "a whole batch from elsewhere",
  );
});

// A row moving across the filter boundary changes the region in both
// directions, and only the pre-image says so for a row on its way out.
Deno.test("both sides of an update count", () => {
  const preds = parseFilter("pinned=is.true");
  assert(
    touches(preds, [change({ id: "n1", pinned: true }, { id: "n1", pinned: false })]),
    "unpinning leaves the region",
  );
  assert(
    touches(preds, [change({ id: "n1", pinned: false }, { id: "n1", pinned: true })]),
    "pinning enters the region",
  );
  assert(
    !touches(preds, [change({ id: "n1", pinned: false }, { id: "n1", pinned: false })]),
    "a row that was and stays outside",
  );
});

// parseFilter returns null for anything it cannot translate (embed-path
// filters, fts). Those regions read through PostgREST, so the client cannot
// decide relevance and must never skip.
Deno.test("an undecidable filter always wakes the region", () => {
  assert(touches(parseFilter("author.handle=eq.davi"), [insert({ id: "x" })]), "embed-path filter");
  assert(touches(parseFilter("search=plfts(simple).dragons"), [insert({ id: "x" })]), "full-text");
  assert(touches(parseFilter(undefined), [insert({ id: "x" })]), "unfiltered region reads everything");
});

// The engine is not the only caller: an own write that settles notifies with
// no change set at all, because the optimistic overlay already matched and the
// collection shows no further diff.
Deno.test("a wake carrying no change set is always relevant", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(touches(preds, undefined), "settled own write");
  assert(touches(preds, null), "no batch");
});

// Which reads may become a maintained view. The dangerous direction is a
// false yes: the view is built without what the region binds, and the region
// renders blank instead of failing. `*,author:app_user(handle)` is the case
// that actually shipped broken — parseSelect rejects the alias syntax and
// returns null, which read as "no embeds" instead of "server-computed".
const can = (filter, select, access, embedAccess = {}) =>
  isMaintainable(parseFilterSpec(filter), parseSelect(select), access, (t) => embedAccess[t]);

Deno.test("a plain read on a public table is maintainable", () => {
  assert(can("article_id=eq.a1", undefined, { scope: "public" }), "eq on public");
  assert(can(undefined, undefined, undefined), "unfiltered, no access rule");
  assert(can("deleted_at=is.null", undefined, undefined), "is.null");
});

Deno.test("an embed everyone may read becomes a join", () => {
  const pub = { app_user: { scope: "public" }, label: { scope: "public" } };
  assert(can("slug=eq.x", "*,author:app_user(handle,image_url)", { scope: "public" }, pub), "aliased embed");
  assert(can("slug=eq.x", "*,label(name)", { scope: "public" }, pub), "unaliased embed");
  assert(can("slug=eq.x", "*,label(name)", { scope: "public" }, {}), "no policy at all means anyone may read");
});

// A left join has nowhere to put a per-row visibility test. The snapshot path
// binds the whole embed null for a row this reader cannot see; a join would
// hand over its columns instead.
Deno.test("an embed of a restricted table is not joined here", () => {
  assert(!can("id=eq.x", "*,owner:me(handle)", { scope: "public" }, { me: { scope: "private", owner: "id" } }), "private embed");
  assert(!can("id=eq.x", "*,f:follow(follower_id)", { scope: "public" }, { follow: { scope: "private", owner: "follower_id" } }), "another private embed");
  assert(!can("id=eq.x", "*,s:secret(v)", { scope: "public" }, { secret: { scope: "internal" } }), "internal embed");
});

Deno.test("a hinted embed is server-computed, not embed-free", () => {
  // null must read as "server-computed" rather than "no embeds" — collapsing
  // those built a view whose rows were missing the columns the region binds.
  assert(parseSelect("*,follow!followed_id!inner(follower_id)") === null, "hinted embed does not parse");
  assert(!can("slug=eq.x", "*,follow!followed_id!inner(follower_id)", { scope: "public" }), "and is not maintainable");
});

Deno.test("reads the query cannot state stay on the snapshot path", () => {
  assert(!can("search=plfts(simple).dragons", undefined, undefined), "full-text");
  assert(!can("author.handle=eq.davi", undefined, undefined), "embed-path filter");
  assert(!can("created_at=lt.2026-01-01", undefined, undefined), "an ordered cursor");
  // A defaulted boolean is absent on an unconfirmed optimistic row, which the
  // snapshot predicate admits deliberately.
  assert(!can("pinned=is.false", undefined, undefined), "is.false");
  assert(!can("pinned=is.true", undefined, undefined), "is.true");
});

// Only a table everyone may read. `private` looks like one more eq on the owner
// column, and measured against the running cluster it excluded exactly the row
// it must not: an optimistic insert carries no owner column — auth_uid() fills
// it server-side — and isNull matches a null, not a missing, property. So a
// favourite did not appear until its round trip landed. visible() admits that
// row through `$synced === false`, which is a fact about the client's own
// pending write rather than anything a query over the data can state.
Deno.test("only visibility the query can restate is maintainable", () => {
  assert(can("id=eq.x", undefined, { scope: "public" }), "public adds no clause");
  assert(can("id=eq.x", undefined, undefined), "no policy at all");
  assert(!can("id=eq.x", undefined, { scope: "private", owner: "user_id" }), "private cannot admit an unconfirmed row");
  assert(!can("id=eq.x", undefined, { scope: "private", owner: "user_id", shared: { via: "share", on: "note_id", user: "user_id" } }), "a share needs a subquery");
  assert(!can("id=eq.x", undefined, { scope: "folder", parent: "note", on: "note_id" }), "a parent chain needs a subquery");
  assert(!can("id=eq.x", undefined, { scope: "internal" }), "internal is never readable here");
});

// PostgREST names a flat embed two ways, and the aliased one is what an app
// writes whenever the relation is not named for its table — `author` on a row
// whose foreign key is author_id. Reading only the unaliased form sent every
// such region to the server on every wake.
Deno.test("an embed is parsed with its alias and its table", () => {
  const eq2 = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eq2(parseSelect("*,label(name)"), [{ alias: "label", table: "label", cols: ["name"] }], "unaliased");
  eq2(
    parseSelect("*,author:app_user(handle,image_url)"),
    [{ alias: "author", table: "app_user", cols: ["handle", "image_url"] }],
    "aliased",
  );
  eq2(
    parseSelect("*,author:app_user(handle),editor:app_user(handle)"),
    [
      { alias: "author", table: "app_user", cols: ["handle"] },
      { alias: "editor", table: "app_user", cols: ["handle"] },
    ],
    "two embeds of one table, which only the aliased form can express",
  );
  eq2(parseSelect("*"), [], "no embeds");
  eq2(parseSelect(undefined), [], "no select at all");
  // A hint or a nested embed is still the server's to compute.
  eq2(parseSelect("*,note_label!inner(label!inner(name))"), null, "hinted and nested");
  // The dependency set is tables, never aliases: a region deaf to app_user
  // would never see a byline change.
  eq2(embedTables("*,author:app_user(handle)"), ["app_user"], "dep set names the table");
  // An embed naming its foreign-key column wakes on the table the column refers
  // to, nested ones included.
  const schema = {
    game: { fields: [{ name: "home_id", ref: "team" }, { name: "phase_id", ref: "phase" }] },
    phase: { fields: [{ name: "championship_id", ref: "championship" }] },
  };
  eq2(embedDeps("*,home:home_id(name),phase(name,championship(full_name))", "game", schema),
    ["team", "phase", "championship"], "column-named and nested embeds");
  eq2(embedDeps("*,author:app_user!inner(handle,follow!followed_id!inner(follower_id))", "article", {}),
    ["app_user", "follow"], "hinted embeds wake on their tables");
});

// A cap is not a predicate. It used to make the whole filter untranslatable,
// which sent the busiest region on every screen — the feed's `limit=20` — to
// PostgREST on every wake.
Deno.test("a row cap is read apart from the predicates", () => {
  const eqj = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eqj(parseLimit("limit=20"), 20, "alone");
  eqj(parseLimit("author_id=eq.x&limit=5"), 5, "after a predicate");
  eqj(parseLimit("author_id=eq.x"), undefined, "absent");
  eqj(parseLimit(undefined), undefined, "no filter at all");
  // The cap leaves the predicate list, and what remains still translates.
  eqj(parseFilterSpec("limit=20"), [], "a cap on its own is no predicate");
  eqj(parseFilterSpec("author_id=eq.x&limit=5"), [{ col: "author_id", op: "eq", value: "x" }], "and does not disturb one");
  assert(can("limit=20", undefined, { scope: "public" }), "a capped read is maintainable");
  // A page waits for its query subset, then applies its explicit offset.
  assert(can("offset=20&limit=20", undefined, undefined), "offset is separate from predicates");
  eqj(parseOffset("offset=20&limit=20"), 20, "page offset");
  assert(parseFilterSpec("offset=-1&limit=20") === null, "negative offset is refused");
  assert(parseFilterSpec("offset=1&offset=2") === null, "duplicate offsets are refused");
  assert(parseFilterSpec("limit=9007199254740992") === null, "unsafe page bounds are refused");
  eqj(parseLimit("limit=abc"), undefined, "a non-numeric cap is not a cap");
  assert(!can("limit=abc", undefined, undefined), "and makes the filter untranslatable");
});

// A cursor is what pages a feed — `created_at=lt.{param.when}` — and used to
// make the whole filter untranslatable, so every page turn read through
// PostgREST. The value arrives as a string and the column's type is not
// knowable here, which is exactly what JS's relational operators handle:
// timestamps in the one format a cursor carries compare lexically, and a
// numeric string coerces against a number.
Deno.test("an ordered cursor is translatable", () => {
  const eq3 = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eq3(parseFilterSpec("created_at=lt.2026-08-02&limit=20"),
      [{ col: "created_at", op: "lt", value: "2026-08-02" }], "cursor beside a cap");
  const older = parseFilter("created_at=lt.2026-08-02");
  assert(older.every((f) => f({ created_at: "2026-08-01" })), "a row before the cursor is in");
  assert(!older.every((f) => f({ created_at: "2026-08-03" })), "a row after it is out");
  const atLeast = parseFilter("rank=gte.3");
  assert(atLeast.every((f) => f({ rank: 3 })), "gte is inclusive, and coerces a numeric string");
  assert(!atLeast.every((f) => f({ rank: 2 })), "below the bound is out");
  // Relevance now works for a paging region too: it used to wake on every
  // write to the table because the filter said nothing.
  assert(touches(older, [insert({ id: "a", created_at: "2026-08-01" })]), "a row it would show wakes it");
  assert(!touches(older, [insert({ id: "b", created_at: "2026-08-03" })]), "a row it never would does not");
  // Still not maintained: the engine has its own comparison semantics and a
  // string against a numeric column is not the same question.
  assert(!can("created_at=lt.2026-08-02", undefined, undefined), "reads client-side, not as a view");
});

// A named read's value — `table?fragment` — splits into exactly the shape a
// region's own read hands the store, or the two could never share a view key.
Deno.test("a read spec splits into the query's own shape", () => {
  const eqr = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eqr(
    parseReadSpec("round?current=eq.yes&order=created_at.desc"),
    { table: "round", filter: "current=eq.yes", order: "created_at.desc" },
    "filter and order ride apart",
  );
  eqr(
    parseReadSpec("play?round_id=eq.{id}&order=seq.asc"),
    { table: "play", filter: "round_id=eq.{id}", order: "seq.asc" },
    "a placeholder is the filter's business, not this split's",
  );
  eqr(
    parseReadSpec("play?a=eq.1&order=seq.asc&b=eq.2"),
    { table: "play", filter: "a=eq.1&b=eq.2", order: "seq.asc" },
    "filter parts recombine in authored order around the order key",
  );
  eqr(parseReadSpec("round"), { table: "round" }, "a bare table reads whole");
  eqr(parseReadSpec("round?"), { table: "round" }, "an empty fragment is a whole read too");
  let threw = false;
  try {
    parseReadSpec("?current=eq.yes");
  } catch {
    threw = true;
  }
  assert(threw, "a spec naming no table is a program error");
});

// The reuse the named-read grammar exists for: a read some region already
// subscribes is served by that region's maintained view, not re-derived. The
// store's debug seam (__prontoViews) is the witness — the query neither opens
// a second view nor takes the snapshot path past the held one.
Deno.test({
  name: "a read a region already subscribes is served by its maintained view",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = await createStore("", { carriers: FIXTURE_CARRIERS, local: { round: "tab" } });
    await store.write("round", [{ key: "r1", row: { current: "yes", created_at: 2 } }]);
    await store.write("round", [{ key: "r2", row: { current: "no", created_at: 1 } }]);
    await store.write("round", [{ key: "r3", row: { current: "yes", created_at: 5 } }]);

    // A query alone never opens a view; only a subscription does.
    const spec = parseReadSpec("round?current=eq.yes&order=created_at.desc");
    const opts = { filter: spec.filter, order: spec.order };
    await store.query(spec.table, spec.order, opts);
    assert(globalThis.__prontoViews.size === 0, "a read alone opened no view");

    const stop = store.subscribe(spec.table, () => {}, opts);
    assert(globalThis.__prontoViews.size === 1, "the subscription opened the view");
    const entry = [...globalThis.__prontoViews.values()][0];

    // Spy through the seam: the same read must come back out of this view.
    const real = entry.view;
    let served = 0;
    entry.view = {
      isReady: () => real.isReady?.() ?? true,
      toArrayWhenReady: () => real.toArrayWhenReady?.(),
      get toArray() {
        served++;
        return real.toArray;
      },
    };
    const rows = await store.query(spec.table, spec.order, opts);
    entry.view = real;
    assert(served === 1, `the held view served the read, served ${served}`);
    assert(
      JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(["r3", "r1"]),
      `filtered and ordered by the engine, got ${JSON.stringify(rows.map((r) => r.id))}`,
    );
    assert(globalThis.__prontoViews.size === 1, "the read joined the view rather than opening one");
    assert(entry.refs === 1, "and holds no reference of its own");

    stop();
    assert(globalThis.__prontoViews.size === 0, "the subscription's release closed the view");
  },
});

// A read of the whole table opens no view: the collection is that set already,
// and a view over it would keep the order by moving array elements — which a
// bulk write paid per row. The region still hears which rows moved.
Deno.test({
  name: "a whole-table read is served by the collection, with its changes attributed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { ord: 2 } }, { key: "b", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), { order: "ord.asc" });
    assert(globalThis.__prontoViews.size === 0, "no view for a whole read");
    // A cap is not a whole read: the engine's ordered index is what stops a
    // capped read scanning the table.
    const capped = store.subscribe("row", () => {}, { order: "ord.asc", filter: "limit=1" });
    assert(globalThis.__prontoViews.size === 1, "a capped read keeps its view");
    capped();
    const rows = await store.query("row", "ord.asc", { order: "ord.asc" });
    assert(JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(["b", "a"]), "ordered at read");
    await store.patch("row", [{ key: "a", changes: { ord: 0 } }]);
    await waitWake(wakes);
    assert(wakes.length === 1, `one wake, got ${wakes.length}`);
    assert(Array.isArray(wakes[0]) && wakes[0].some((c) => String(c.value?.id) === "a"), "the wake names the row");
    stop();
  },
});

// A fold's writes are one conclusion — a drop, then a put, each awaited — and
// they reach the region as one wake with both in it.
Deno.test({
  name: "a fold's several writes wake a region once, with every write in the wake",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await store.drop("row", ["a"]);
    await store.write("row", [{ key: "b", row: { ord: 2 } }, { key: "c", row: { ord: 3 } }]);
    assert(wakes.length === 0, "the wake is a task of its own, after every write of the fold");
    await waitWake(wakes);
    assert(wakes.length === 1, `one wake for the fold, got ${wakes.length}`);
    const ids = [...new Set(wakes[0].map((c) => String(c.value?.id ?? c.previousValue?.id)))].sort();
    assert(JSON.stringify(ids) === JSON.stringify(["a", "b", "c"]), `every write in it, got ${ids}`);
    stop();
  },
});

// A subscription is told only of keys it has seen. A row written before the
// region subscribed — a seed, a table a screen returns to — must still report
// its delete, or the region keeps drawing a row the store no longer holds.
Deno.test({
  name: "a row older than the subscription still reports its delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { row: "tab" } });
    await store.write("row", [{ key: "old", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 0, "subscribing alone wakes nothing: the standing rows are no burst");
    await store.drop("row", ["old"]);
    await waitWake(wakes);
    assert(wakes.length === 1, `the delete woke the region, got ${wakes.length}`);
    assert(wakes[0].every((c) => c.type !== "insert"), "nothing of the standing state rides in the wake");
    assert(wakes[0].some((c) => c.type === "delete" && String(c.key) === "old"), "and named the row");
    stop();
  },
});

// A view is shared by every region reading the same filter, and the second
// of them subscribes after the view has its rows. It must still hear one of
// those rows go, or it keeps drawing a row the store no longer holds.
Deno.test({
  name: "a region joining a shared view still hears a standing row's delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { kind: "x" } }, { key: "b", row: { kind: "x" } }]);
    const opts = { filter: "kind=eq.x" };
    const first = store.subscribe("row", () => {}, opts);
    await store.query("row", null, opts);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const second = store.subscribe("row", (changes) => wakes.push(changes), opts);
    assert(globalThis.__prontoViews.size === 1, "one view between them");
    await store.drop("row", ["a"]);
    await waitWake(wakes);
    assert(wakes.length === 1, `the late joiner woke, got ${wakes.length}`);
    assert(wakes[0].some((c) => c.type === "delete" && String(c.key) === "a"), "and heard the delete");
    second();
    first();
  },
});

// A wake comes due in a task of its own; a subscription stopped before then
// must not be delivered, or a region torn down in the same task is refreshed
// as if it stood.
Deno.test({
  name: "a wake pending when the subscription stops is not delivered",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { row: "tab" } });
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await store.write("row", [{ key: "a", row: { ord: 1 } }]);
    stop();
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 0, `no wake after stop, got ${wakes.length}`);
  },
});

// These use the real query engine against a controllable on-demand sync
// source. Collection readiness precedes subset delivery on purpose: reading
// the raw collection would report an authoritative empty result too early.
async function demandStore(schema, sourceRows = {}, extra = {}) {
  const { createCollection } = await import("./vendor/mecha-client.js");
  const tables = Object.keys(schema);
  const store = createStore("http://example.invalid", {
    carriers: { ...FIXTURE_CARRIERS, types: {
      ...Object.fromEntries(Object.entries(FIXTURE_CARRIERS.types).map(([k, { sql: _sql, ...v }]) => [k, v])),
      bool: { base: ["bool"], json: "boolean", order: "boolean", beyond: [] },
      uuid: { base: ["uuid"], json: "string", order: "text", beyond: [] },
    } },
    tables, onDemand: tables, schema, ...extra,
    access: Object.fromEntries(tables.map((t) => [t, { scope: "public" }])),
  });
  const client = globalThis.__mechaClient;
  // The controllable source has no HTTP transport. Model that distinct
  // notification channel explicitly; the real-adapter case below proves it.
  const rawListeners = new Map();
  client.subscribeRawChanges = (table, fn) => {
    if (!rawListeners.has(table)) rawListeners.set(table, new Set());
    rawListeners.get(table).add(fn);
    const lease = client.collections[table].subscribeChanges(() => {}, { includeInitialState: false });
    return () => { rawListeners.get(table).delete(fn); lease.unsubscribe(); };
  };
  client.waitForRawReady = (table) => {
    const c = client.collections[table];
    return c.isReady() ? Promise.resolve() : new Promise((resolve) => c.onFirstReady(resolve));
  };
  const emitRaw = (table) => { for (const fn of rawListeners.get(table) ?? []) fn(); };
  const requests = [];
  const writes = {};
  const pending = [];
  for (const table of tables) {
    const collection = createCollection({
      id: `demand-smoke:${table}:${crypto.randomUUID()}`, getKey: (r) => r.id,
      syncMode: "on-demand", gcTime: 0,
      sync: { sync: (sink) => {
        writes[table] = (changes) => {
          sink.begin();
          for (const change of changes) sink.write(change);
          sink.commit();
        };
        sink.markReady();
        return { loadSubset: (opts) => {
          requests.push({ table, where: opts.where, orderBy: opts.orderBy, limit: opts.limit, cursor: opts.cursor });
          return new Promise((resolve) => pending.push(() => {
            writes[table]((sourceRows[table] ?? []).filter((r) => !collection.has(r.id)).map((value) => ({ type: "insert", value })));
            resolve();
          }));
        } };
      } },
    });
    client.collections[table] = collection;
  }
  return { store, client, requests, writes, pending, emitRaw, flush: async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      while (pending.length) pending.shift()();
    }
  }, cleanup: async () => {
    for (const c of Object.values(client.collections)) await c.cleanup();
  } };
}

Deno.test({
  name: "an on-demand page waits for its own subset and releases standalone and navigation leases",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({ item: { fields: [{ name: "id", type: "string" }, { name: "rank", type: "int32" }] } }, {
      item: [{ id: "a", rank: 1 }, { id: "b", rank: 1 }, { id: "c", rank: 1 }],
    });
    const opts = { filter: "limit=1&offset=1", order: "rank.asc" };
    let done = false;
    const read = h.store.query("item", opts.order, opts).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    assert(h.client.collections.item.isReady(), "the raw collection is already ready");
    assert(!done, "the incomplete page did not render empty");
    assert(h.requests.length > 0 && h.requests.every((r) => r.limit !== undefined), "every initial page request is capped");
    assert(JSON.stringify(h.requests).includes('"id"'), "the query carries a primary-key tie breaker");
    await h.flush();
    assert((await read).map((r) => r.id).join() === "b", "offset picks the second deterministic row");
    assert(globalThis.__prontoViews.size === 0, "standalone read released its view");
    const stop = h.store.subscribe("item", () => {}, { filter: "id=eq.c" });
    const again = h.store.query("item", undefined, { filter: "id=eq.c" });
    await h.flush();
    assert((await again)[0].id === "c", "the next query reads its own subset");
    assert(globalThis.__prontoViews.size === 1, "query released its temporary reference");
    stop();
    assert(globalThis.__prontoViews.size === 0, "navigation released its view");
    await h.cleanup();
  },
});

Deno.test({
  name: "on-demand typed predicates and flat foreign-key joins load only requested relations",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({
      item: { fields: [{ name: "id", type: "string" }, { name: "rank", type: "int32" }, { name: "active", type: "bool" }, { name: "team_id", type: "string", ref: "team" }, { name: "name", type: "string" }] },
      team: { fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }] },
    }, {
      item: [{ id: "a", rank: 10, active: true, team_id: "t", name: "Alpha" }, { id: "b", rank: 2, active: false, team_id: "u", name: "Beta" }],
      team: [{ id: "t", name: "Target" }, { id: "u", name: "Other" }],
    });
    const opts = { filter: "active=is.true&rank=gte.3&name=ilike.*alp*&limit=2", order: "rank.desc", select: "*,team:team_id(name)" };
    const stop = h.store.subscribe("item", () => {}, opts);
    const read = h.store.query("item", opts.order, opts);
    await h.flush();
    const rows = await read;
    assert(rows.length === 1 && rows[0].team.name === "Target", "boolean, numeric range, pattern and FK alias resolve");
    const related = h.requests.filter((r) => r.table === "team");
    assert(related.length > 0 && related.every((r) => r.where), "joined collection never requests all historical rows");
    assert(JSON.stringify(related).includes('"t"') && !JSON.stringify(related).includes('"u"'), "join requests only the qualifying row's FK");
    stop();
    await h.cleanup();
  },
});

Deno.test({
  name: "an on-demand server-computed watch and zero cap request no historical table",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({ item: { fields: [{ name: "id", type: "string" }] } });
    const stop = h.store.subscribe("item", () => {}, { filter: "name=fts.words&limit=5" });
    await h.flush();
    assert(h.requests.length === 0, "fallback watch did not request a historical subset");
    assert((await h.store.query("item", undefined, { filter: "limit=0" })).length === 0, "zero cap is empty");
    assert(h.requests.length === 0, "zero cap did not turn into an uncapped adapter request");
    let refused = false;
    try { await h.store.query("item"); } catch { refused = true; }
    assert(refused, "a whole on-demand table needs an explicit cap");
    stop();
    await h.cleanup();
  },
});

Deno.test({
  name: "on-demand mutations resolve unloaded targets, natural keys and complete delete filters",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({ item: { fields: [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "group", type: "string" }] } }, {
      item: [{ id: "a", slug: "first", group: "x" }, { id: "b", slug: "second", group: "x" }, { id: "c", slug: "third", group: "y" }],
    }, { uniques: { item: [["slug"]] } });
    const updated = [], removed = [];
    h.client.update = async (table, edits) => {
      assert(edits.every((e) => h.client.collections[table].has(e.key)), "update targets were loaded");
      assert(globalThis.__prontoViews.size > 0, "the mutation still holds its query lease");
      updated.push(...edits);
    };
    h.client.insert = () => { throw new Error("an unloaded existing row must not be inserted"); };
    h.client.remove = async (_table, keys) => { removed.push(...keys); };
    const patch = h.store.patch("item", [{ key: "a", changes: { slug: "first-edited" } }]);
    await new Promise((r) => setTimeout(r, 10));
    assert(updated.length === 0, "patch waits for its target subset");
    await h.flush();
    await patch;
    const upsert = h.store.upsertBy("item", { slug: "second", group: "new" });
    await h.flush();
    await upsert;
    assert(updated.length === 2 && updated[1].key === "b", "natural-key lookup updates the preexisting row");
    const drop = h.store.dropWhere("item", "group=eq.x");
    await h.flush();
    await drop;
    assert(removed.sort().join() === "a,b", "delete includes every row matching the loaded filter");
    assert(h.requests.every((r) => r.where), "no mutation requested a whole table");
    assert(JSON.stringify(h.requests).includes('"slug"') && JSON.stringify(h.requests).includes('"group"'), "natural key and full delete predicate were loaded explicitly");
    assert(globalThis.__prontoViews.size === 0, "mutation leases were released");
    await h.cleanup();
  },
});

Deno.test({
  name: "on-demand validation loads its declared edge before accepting an insert",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    await import("./vendor/ses.umd.min.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert(String(url) === "http://example.invalid/check.js", "only the declared predicate module is fetched");
      return new Response('(state, event) => state.rows.parent.length === 1 && state.rows.parent[0].allowed;');
    };
    const h = await demandStore({
      item: { fields: [{ name: "id", type: "string" }, { name: "parent_id", type: "string" }] },
      parent: { fields: [{ name: "id", type: "string" }, { name: "allowed", type: "bool" }] },
    }, { parent: [{ id: "p", allowed: false }] }, {
      appBase: "http://example.invalid/",
      validations: { item: { "allowed-parent": { src: "check.js", edges: [{ table: "parent", key: "id", from: "parent_id" }] } } },
    });
    let inserted = false;
    h.client.insert = async () => { inserted = true; };
    try {
      const result = h.store.add("item", [{ id: "a", parent_id: "p" }]).then(() => null, (e) => e);
      await h.flush();
      const err = await result;
      assert(err?.validation === "allowed-parent", "the loaded edge refuses the invalid row");
      assert(!inserted, "validation runs before the durable write");
      const edges = h.requests.filter((r) => r.table === "parent");
      assert(edges.length > 0 && edges.every((r) => r.where), "validation edge loads only its referenced parent");
    } finally {
      globalThis.fetch = originalFetch;
      await h.cleanup();
    }
  },
});

Deno.test({
  name: "an absent nullable foreign key renders an empty detail without a subset request",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({ stadium: { fields: [{ name: "id", type: "uuid" }] } });
    const stop = h.store.subscribe("stadium", () => {}, { filter: "id=eq." });
    assert((await h.store.query("stadium", undefined, { filter: "id=eq." })).length === 0, "null FK expands to an empty key result");
    assert(h.requests.length === 0, "invalid UUID never reached the subset transport");
    stop();
    await h.cleanup();
  },
});

Deno.test({
  name: "an on-demand bounded view replaces removed rows and preserves authored key priority",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const h = await demandStore({ item: { fields: [{ name: "id", type: "string" }, { name: "rank", type: "int32" }] } }, {
      item: [{ id: "a", rank: 3 }, { id: "b", rank: 2 }, { id: "c", rank: 1 }],
    });
    const opts = { filter: "limit=1", order: "id.asc,rank.asc" };
    const wakes = [];
    const stop = h.store.subscribe("item", (changes) => wakes.push(changes), opts);
    const read = h.store.query("item", opts.order, opts);
    await h.flush();
    assert((await read)[0].id === "a", "the authored unique first key was not moved behind rank");
    h.writes.item([{ type: "delete", value: { id: "a", rank: 3 } }]);
    await h.flush();
    assert(wakes.length > 0, "the bounded view reports its replacement");
    assert((await h.store.query("item", opts.order, opts))[0].id === "b", "the next row fills the vacated page slot");
    stop();
    await h.cleanup();
  },
});

const DOMAIN_CARRIERS = { ...FIXTURE_CARRIERS, types: {
  ...FIXTURE_CARRIERS.types,
  uuid: { base: ["uuid"], json: "string", order: "text", beyond: [] },
  bool: { sql: "portable_bool", base: ["bool"], json: "boolean", order: "boolean", beyond: [] },
} };

Deno.test({
  name: "portable-domain predicates and ordered windows use bounded PostgREST without a historical subset",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const reads = [];
    globalThis.fetch = async (url) => {
      reads.push(new URL(String(url)));
      return Response.json([{ id: "a", name: "Alpha" }]);
    };
    const h = await demandStore({ item: { fields: [{ name: "id", type: "uuid" }, { name: "name", type: "text" }, { name: "rank", type: "int32" }, { name: "active", type: "bool" }] } }, {}, { carriers: DOMAIN_CARRIERS });
    try {
      const opts = { filter: "name=ilike.*alp*&rank=gte.1&active=is.true&limit=40&offset=80", order: "name.asc" };
      const wakes = [];
      const stop = h.store.subscribe("item", (c) => wakes.push(c), opts);
      assert((await h.store.query("item", opts.order, opts))[0].name === "Alpha", "the bounded server result is returned");
      assert(reads[0].pathname === "/crud/item", "PostgREST handles the domain expression");
      for (const [k, v] of new URLSearchParams(opts.filter)) assert(reads[0].searchParams.get(k) === v, `filter/page ${k} is preserved`);
      assert(reads[0].searchParams.get("order") === "name.asc,id.asc", "fallback keeps deterministic page ordering");
      // Even a predicate-free window will eventually compare its ordered
      // values to a refill cursor, so it uses the same supported fallback.
      await h.store.query("item", "name.asc", { filter: "limit=40" });
      assert(reads.length === 2 && h.requests.length === 0, "neither domain query requested Electric history");
      h.writes.item([{ type: "insert", value: { id: "new", name: "Alpha", rank: 2, active: true } }]);
      h.emitRaw("item");
      await h.flush();
      assert(wakes.length > 0, "future row changes still wake the fallback region");
      stop();
    } finally {
      globalThis.fetch = originalFetch;
      await h.cleanup();
    }
  },
});

Deno.test({
  name: "portable-domain mutation filters page every matching key then hydrate finite UUID targets",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const reads = [];
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      reads.push(u);
      const offset = Number(u.searchParams.get("offset"));
      // A gateway cap smaller than500 must not truncate the matching set.
      return Response.json(offset === 0 ? [{ id: "a" }] : offset === 1 ? [{ id: "b" }] : []);
    };
    const h = await demandStore({ item: { fields: [{ name: "id", type: "uuid" }, { name: "group", type: "string" }] } }, {
      item: [{ id: "a", group: "x" }, { id: "b", group: "x" }, { id: "c", group: "y" }],
    }, { carriers: DOMAIN_CARRIERS });
    const removed = [];
    h.client.remove = async (_table, keys) => { removed.push(...keys); };
    try {
      const deletion = h.store.dropWhere("item", "group=eq.x");
      await h.flush();
      await deletion;
      assert(removed.sort().join() === "a,b", "all matching hydrated targets are removed");
      assert(reads.length === 3 && reads.every((u) => u.searchParams.get("group") === "eq.x" && u.searchParams.get("select") === "id" && u.searchParams.get("limit") === "500"), "every key page retains the scoped predicate and finite cap");
      assert(h.requests.length > 0 && h.requests.every((r) => r.where), "hydration only opens finite-key subsets");
      assert(!JSON.stringify(h.requests).includes('"group"'), "unsupported domain expression never reaches Electric");
      assert(globalThis.__prontoViews.size === 0, "hydration leases are released after mutation");
    } finally {
      globalThis.fetch = originalFetch;
      await h.cleanup();
    }
  },
});

Deno.test({
  name: "a large mutation hydrates finite UUID batches before invoking the write",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `key-${i}` }));
    const h = await demandStore({ item: { fields: [{ name: "id", type: "uuid" }] } }, { item: rows }, { carriers: DOMAIN_CARRIERS });
    let count = 0;
    h.client.update = async (_table, edits) => { count = edits.length; };
    try {
      const mutation = h.store.patch("item", rows.map((r) => ({ key: r.id, changes: {} })));
      await h.flush();
      await mutation;
      assert(count === 51, "the full mutation runs after all target batches load");
      assert(h.requests.length === 2 && h.requests.every((r) => r.where), "finite key batches bound each subset request");
      assert(globalThis.__prontoViews.size === 0, "all target leases were released");
    } finally {
      await h.cleanup();
    }
  },
});

Deno.test({
  name: "real Electric fallback invalidation sees an uncached rename-away and deletion without snapshot feedback",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const origin = `http://fallback-${crypto.randomUUID()}`;
    const rows = new Map([
      ["a", { id: "a", name: "Alpha first" }],
      ["b", { id: "b", name: "Alpha second" }],
      ["c", { id: "c", name: "Other" }],
    ]);
    const requests = [];
    const queued = [];
    let waiting;
    let sequence = 0;
    const current = () => ({ headers: { control: "up-to-date", global_last_seen_lsn: String(sequence) } });
    const response = (body) => Response.json(body, { headers: {
      "electric-handle": "fallback",
      "electric-offset": `${sequence}_0`,
      "electric-up-to-date": "true",
      "electric-cursor": String(sequence),
      "electric-schema": JSON.stringify({ id: { type: "uuid", pk_index: 0 }, name: { type: "portable_string" } }),
    } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/auth/shape") return response({ token: "signed", where: "scope_id = 'public:'", expires_in: 900 });
      if (url.pathname === "/crud/item") return response([...rows.values()].filter((r) => r.name.startsWith("Alpha")));
      assert(url.pathname === "/electric/v1/shape", "only the declared shape is fetched");
      assert(url.searchParams.get("log") === "changes_only" && url.searchParams.get("offset") !== "-1", "the fallback never opens archive history");
      if (url.searchParams.has("subset__where")) return response({
        metadata: { xmin: "1", xmax: "2", xip_list: [], database_lsn: String(sequence), snapshot_mark: 1 },
        data: [{ key: '"public"."item"/"c"', value: rows.get("c"), headers: { operation: "insert" } }],
      });
      if (queued.length) return response([...queued.shift(), current()]);
      if (url.searchParams.get("live") !== "true") return response([current()]);
      return await new Promise((resolve, reject) => {
        const deliver = (messages) => {
          init?.signal?.removeEventListener("abort", abort);
          waiting = undefined;
          resolve(response([...messages, current()]));
        };
        const abort = () => {
          if (waiting === deliver) waiting = undefined;
          reject(new DOMException("aborted", "AbortError"));
        };
        waiting = deliver;
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const publish = (id, name) => {
      const value = name === null ? { id } : { id, name };
      if (name === null) rows.delete(id);
      else rows.set(id, value);
      sequence++;
      const messages = [{ key: `"public"."item"/"${id}"`, value, headers: {
        operation: name === null ? "delete" : "update", txids: [sequence],
        lsn: String(sequence), op_position: 0, last: true,
      } }];
      if (waiting) waiting(messages);
      else queued.push(messages);
    };
    const until = async (test) => {
      for (let i = 0; i < 200; i++) {
        if (test()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("fallback live result did not refresh");
    };
    const store = createStore(origin, {
      tables: ["item"], onDemand: ["item"], carriers: DOMAIN_CARRIERS,
      access: { item: { scope: "public" } },
      schema: { item: { fields: [{ name: "id", type: "uuid" }, { name: "name", type: "string" }] } },
    });
    const client = globalThis.__mechaClient;
    const opts = { filter: "name=ilike.*Alpha*&limit=20", order: "name.asc" };
    let displayed = [];
    let refreshes = 0;
    let failure;
    const refresh = async () => {
      try { displayed = await store.query("item", opts.order, opts); refreshes++; }
      catch (e) { failure = e; }
    };
    let stop = store.subscribe("item", () => { void refresh(); }, opts);
    try {
      await refresh();
      await until(() => client.collections.item.isReady());
      assert(displayed.length === 2 && client.collections.item.size === 0, "HTTP results exist only on screen, not in Electric's cache");
      assert(!requests.some((u) => u.searchParams.has("subset__where")), "initial fallback requested no historical subset");
      publish("a", "Beta renamed");
      await until(() => displayed.length === 1);
      assert(displayed[0].id === "b", "a first update leaving the filter removes the HTTP-only row");
      assert(!client.collections.item.has("b"), "the next deleted HTTP result is still uncached");
      publish("b", null);
      await until(() => displayed.length === 0);
      assert(!failure, "live fallback reads succeeded");
      // A neighboring detail hydrates a finite subset. Its insert is not a
      // remote change and must not send the HTTP list into a read loop.
      await new Promise((r) => setTimeout(r, 30));
      const before = refreshes;
      const detail = await store.query("item", undefined, { filter: "id=eq.c" });
      assert(detail[0]?.name === "Other", "a real adapter subset loaded the neighboring detail");
      await new Promise((r) => setTimeout(r, 60));
      assert(refreshes === before, "subset snapshots do not invalidate the fallback list");
      stop();
      stop = () => {};
      publish("c", "Alpha after teardown");
      await new Promise((r) => setTimeout(r, 30));
      assert(refreshes === before, "stopped regions release transport invalidation listeners");
    } finally {
      stop();
      await client.collections.item.cleanup();
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "real Electric fallback waits for base and joined stream baselines before its HTTP snapshot",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const origin = `http://baseline-${crypto.randomUUID()}`;
    const baselines = new Map();
    let serverName = "Alpha";
    let labelName = "Before";
    let reads = 0;
    let refusedOnce = false;
    const response = (table, body) => Response.json(body, { headers: {
      "electric-handle": `baseline-${table}`, "electric-offset": "0_0",
      "electric-up-to-date": "true", "electric-cursor": "0",
      "electric-schema": JSON.stringify({ id: { type: "uuid", pk_index: 0 }, name: { type: "portable_string" } }),
    } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/shape") return Response.json({ token: "signed", where: "scope_id = 'public:'", expires_in: 900 });
      if (url.pathname === "/crud/item") {
        reads++;
        return Response.json([{ id: "a", name: serverName, label: { name: labelName } }]);
      }
      assert(url.pathname === "/electric/v1/shape", "only the baseline shapes are requested");
      assert(url.searchParams.get("log") === "changes_only" && !url.searchParams.has("subset__where"), "waiting for baseline never loads historical rows");
      const table = url.searchParams.get("table");
      if (table === "label" && !refusedOnce) {
        refusedOnce = true;
        return Response.json({ message: "expired shape token" }, { status: 401 });
      }
      return await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) return abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (url.searchParams.get("live") !== "true") baselines.set(table, () => {
          init?.signal?.removeEventListener("abort", abort);
          resolve(response(table, [{ headers: { control: "up-to-date", global_last_seen_lsn: "0" } }]));
        });
      });
    };
    const store = createStore(origin, {
      tables: ["item", "label"], onDemand: ["item", "label"], carriers: DOMAIN_CARRIERS,
      access: { item: { scope: "public" }, label: { scope: "public" } },
      schema: {
        item: { fields: [{ name: "id", type: "uuid" }, { name: "name", type: "string" }, { name: "label_id", type: "uuid", ref: "label" }] },
        label: { fields: [{ name: "id", type: "uuid" }, { name: "name", type: "string" }] },
      },
    });
    const client = globalThis.__mechaClient;
    const opts = { filter: "name=ilike.*&limit=20", order: "name.asc", select: "*,label(name)" };
    let stop = store.subscribe("item", () => {}, opts);
    try {
      const reading = store.query("item", opts.order, opts);
      for (let i = 0; i < 200 && baselines.size < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert(baselines.size === 2, "base and joined changes-only baselines both started");
      assert(client.collections.label.isReady(), "the adapter has marked the transient 401 collection ready");
      assert(reads === 0, "HTTP waits for the real baseline, even when an auth error marks the collection ready");
      // These commits are intentionally absent from the control-only initial
      // log. The later authoritative HTTP read must include both of them.
      serverName = "Beta";
      baselines.get("item")();
      await new Promise((r) => setTimeout(r, 20));
      assert(reads === 0, "the joined baseline also precedes the HTTP snapshot");
      labelName = "After";
      baselines.get("label")();
      const result = await reading;
      assert(result[0].name === "Beta" && result[0].label.name === "After", "the snapshot includes commits made before both baselines were established");
      assert(reads === 1, "baseline readiness does not create a refetch loop");
      stop();
      stop = () => {};
      for (let i = 0; i < 800 && Object.values(client.collections).some((c) => c.status !== "cleaned-up"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(Object.values(client.collections).every((c) => c.status === "cleaned-up"), "the real five-second idle GC cleaned both streams");
      baselines.clear();
      const restarted = store.query("item", opts.order, opts);
      for (let i = 0; i < 200 && baselines.size < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert(baselines.size === 2 && reads === 1, "a standalone read restarts and waits for both baselines after GC");
      baselines.get("item")();
      baselines.get("label")();
      assert((await restarted)[0].name === "Beta" && reads === 2, "the actual post-GC log boundary settles the fresh HTTP read despite a replayed cursor");
    } finally {
      stop();
      await Promise.all(Object.values(client.collections).map((c) => c.cleanup()));
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "real Electric fallback rejects a terminal baseline failure before reading HTTP",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const origin = `http://baseline-error-${crypto.randomUUID()}`;
    let reads = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/shape") return Response.json({ token: "signed", where: "scope_id = 'public:'", expires_in: 900 });
      if (url.pathname === "/crud/item") {
        reads++;
        return Response.json([]);
      }
      assert(url.pathname === "/electric/v1/shape" && url.searchParams.get("log") === "changes_only", "only a changes-only baseline is attempted");
      return Response.json({ message: "invalid shape" }, { status: 400 });
    };
    const store = createStore(origin, {
      tables: ["item"], onDemand: ["item"], carriers: DOMAIN_CARRIERS,
      access: { item: { scope: "public" } },
      schema: { item: { fields: [{ name: "id", type: "uuid" }, { name: "name", type: "string" }] } },
    });
    const client = globalThis.__mechaClient;
    let timeout;
    try {
      const error = await Promise.race([
        store.query("item", "name.asc", { filter: "name=ilike.*&limit=20" }).then(() => undefined, (e) => e),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("terminal baseline failure did not settle")), 2000); }),
      ]);
      assert(error instanceof Error, "a terminal stream failure rejects the read");
      assert(reads === 0, "an unestablished stream cannot authorize an HTTP snapshot");
    } finally {
      clearTimeout(timeout);
      await client.collections.item.cleanup();
      globalThis.fetch = originalFetch;
    }
  },
});
