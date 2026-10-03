import assert from "node:assert/strict";
import { BTreeIndex, createLiveQueryCollection, eq } from "@tanstack/db";
import { createMechaClient } from "./mecha-client.ts";
import { MemoryStorageAdapter } from "./storage.ts";

// Deno exposes Web Locks but no window or onLine flag. Each fixture is a
// separate lone-process boot, so avoid sharing a browser leadership lock.
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });

// Exercises the pinned Electric adapter rather than mocking its collection.
function transport() {
  const origin = `http://test-${crypto.randomUUID()}`;
  const requests: URL[] = [];
  let row = { id: "a", title: "before" };
  let sequence = 0;
  const queued: unknown[][] = [];
  let waiting: ((messages: unknown[]) => void) | undefined;
  let wrote: (() => void) | undefined;
  const written = new Promise<void>((resolve) => { wrote = resolve; });
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "electric-handle": "archive",
      "electric-offset": `${sequence}_0`,
      "electric-up-to-date": "true",
      "electric-cursor": String(sequence),
      "electric-schema": JSON.stringify({ id: { type: "text", pk_index: 0 }, title: { type: "text" } }),
    },
  });
  const current = () => ({ headers: { control: "up-to-date", global_last_seen_lsn: String(sequence) } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname === "/auth/shape") return response({ token: "signed", where: "scope_id = 'public:'", expires_in: 900 });
    if (url.pathname === "/crud/article") {
      row = { ...row, ...JSON.parse(String(init?.body)) };
      wrote?.();
      return response([{ ...row, txid: "42" }]);
    }
    assert.equal(url.pathname, "/electric/v1/shape");
    assert.equal(url.searchParams.get("where"), "scope_id = 'public:'");
    assert.equal(url.searchParams.get("replica"), "full");
    assert.equal(url.searchParams.get("log"), "changes_only");
    assert.notEqual(url.searchParams.get("offset"), "-1", "archive history must never be requested");
    if (url.searchParams.has("subset__where")) return response({
      metadata: { xmin: "1", xmax: "2", xip_list: [], database_lsn: String(sequence), snapshot_mark: 1 },
      data: [{ key: '"public"."article"/"a"', value: row, headers: { operation: "insert" } }],
    });
    if (queued.length) return response([...queued.shift()!, current()]);
    if (url.searchParams.get("live") !== "true") return response([current()]);
    return await new Promise<Response>((resolve, reject) => {
      const deliver = (messages: unknown[]) => {
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
  return {
    origin, requests, fetcher, written,
    publish(value: typeof row, operation = "update") {
      row = value;
      sequence += 1;
      const messages = [{ key: `"public"."article"/"${value.id}"`, value, headers: { operation, txids: [42], lsn: String(sequence), op_position: 0, last: true } }];
      if (waiting) waiting(messages);
      else queued.push(messages);
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("bounded read/write did not settle")), 4_000);
    })]);
  } finally { clearTimeout(timer!); }
}
function clientFor(mock: ReturnType<typeof transport>) {
  return createMechaClient({
    tables: [{ id: "articles", table: "article", access: { scope: "public" }, onDemand: true }],
    electricUrl: `${mock.origin}/electric`, crudUrl: `${mock.origin}/crud`, authUrl: `${mock.origin}/auth`,
    fetcher: mock.fetcher, shapeIdleMs: 1,
  });
}

Deno.test({
  name: "on-demand is opt-in for public CRUD collections and preserves their stable identity",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    for (const table of [
      { id: "a", table: "article", onDemand: true },
      { id: "a", table: "article", onDemand: true, durability: "tab", access: { scope: "public" } },
      { id: "a", table: "article", onDemand: true, access: { scope: "private", owner: "owner_id" } },
    ]) assert.throws(() => createMechaClient({ tables: [table as never], authUrl: "http://test/auth" }), /public and CRUD/);
    const mock = transport();
    const client = clientFor(mock);
    assert.equal(client.collections.articles.id, "mecha:articles");
    assert.equal(client.collections.articles.config.syncMode, "on-demand");
    assert.equal(mock.requests.length, 0);
    await client.ready;
  },
});

Deno.test({
  name: "raw on-demand watchers subscribe to future changes without requesting archive history",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const client = clientFor(mock);
    const c = client.collections.articles;
    const watch = c.subscribeChanges(() => {}, { includeInitialState: false });
    try {
      await within(new Promise<void>((resolve) => c.onFirstReady(resolve)));
      assert.equal(c.size, 0);
      assert.equal(mock.requests.some((url) => url.searchParams.has("subset__where")), false);
      mock.publish({ id: "a", title: "remote edit" });
      await delay(30);
      assert.equal(c.get("a")?.title, "remote edit");
    } finally { watch.unsubscribe(); await c.cleanup(); }
  },
});

Deno.test({
  name: "a bounded live query receives its subset and a write confirms after the view closes",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const client = clientFor(mock);
    await client.ready;
    const c = client.collections.articles;
    c.createIndex((row: any) => row.id, { indexType: BTreeIndex });
    const view = createLiveQueryCollection({
      query: (q) => q.from({ row: c }).where(({ row }: any) => eq(row.id, "a")).orderBy(({ row }: any) => row.id).limit(1),
    });
    try {
      const rows = await within(view.toArrayWhenReady());
      assert.equal(rows[0]?.title, "before");
      const snapshot = mock.requests.find((url) => url.searchParams.has("subset__where"));
      assert.ok(snapshot);
      assert.equal(snapshot.searchParams.get("subset__limit"), "1");
      assert.match(snapshot.searchParams.get("subset__where")!, /"id"/);
      const write = client.update("articles", [{ key: "a", changes: { title: "after" } }]);
      await within(mock.written);
      await view.cleanup();
      await delay(30);
      assert.notEqual(c.status, "cleaned-up", "pending write owns its stream beyond route teardown");
      assert.equal(c.get("a")?.title, "after", "optimistic edit remains visible");
      mock.publish({ id: "a", title: "after" });
      await within(write);
      assert.equal(client.syncPhase("articles", "a"), undefined);
    } finally { await view.cleanup(); await c.cleanup(); }
  },
});

Deno.test({
  name: "a write without a reader establishes its changes-only stream before HTTP delivery",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const client = clientFor(mock);
    await client.ready;
    const c = client.collections.articles;
    try {
      const write = client.insert("articles", [{ id: "a", title: "created" }]);
      await within(mock.written);
      const base = mock.requests.findIndex((url) => url.pathname === "/electric/v1/shape");
      const crud = mock.requests.findIndex((url) => url.pathname === "/crud/article");
      assert.ok(base >= 0 && base < crud);
      assert.equal(mock.requests.some((url) => url.searchParams.has("subset__where")), false);
      assert.equal(c.get("a")?.title, "created");
      mock.publish({ id: "a", title: "created" }, "insert");
      await within(write);
      assert.equal(client.syncPhase("articles", "a"), undefined);
    } finally { await c.cleanup(); }
  },
});

Deno.test({
  name: "an outbox replay confirms on an on-demand table before any route subscribes",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    // Simulate durable storage from an earlier boot; the real executor still
    // deserializes, restores, sends and retires the transaction itself.
    const stored = new Map<string, string>([["tx:reload", JSON.stringify({
      id: "reload", mutationFnName: "update:articles", keys: ["mecha:articles:a"],
      idempotencyKey: "reload", createdAt: new Date().toISOString(), retryCount: 0, nextAttemptAt: 0, version: 1,
      mutations: [{
        globalKey: "mecha:articles:a", collectionId: "articles", type: "update",
        original: { id: "a", title: "before" }, modified: { id: "a", title: "replayed" }, changes: { title: "replayed" },
      }],
    })]]);
    const proto = MemoryStorageAdapter.prototype;
    const original = { get: proto.get, set: proto.set, delete: proto.delete, keys: proto.keys, clear: proto.clear };
    Object.assign(proto, {
      get: (key: string) => Promise.resolve(stored.get(key) ?? null),
      set: (key: string, value: string) => Promise.resolve(void stored.set(key, value)),
      delete: (key: string) => Promise.resolve(void stored.delete(key)),
      keys: () => Promise.resolve([...stored.keys()]),
      clear: () => Promise.resolve(stored.clear()),
    });
    const mock = transport();
    const client = clientFor(mock);
    const c = client.collections.articles;
    try {
      await client.ready;
      await within(mock.written);
      assert.equal(c.get("a")?.title, "replayed");
      assert.equal(mock.requests.some((url) => url.searchParams.has("subset__where")), false);
      mock.publish({ id: "a", title: "replayed" });
      await within((async () => { while (stored.has("tx:reload")) await delay(5); })());
      assert.equal(stored.size, 0, "confirmed replay is removed from the durable outbox");
    } finally {
      await c.cleanup();
      Object.assign(proto, original);
    }
  },
});

Deno.test({
  name: "raw live notifications include uncached deletes and rename-away updates but exclude subsets",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const client = clientFor(mock);
    const c = client.collections.articles;
    const batches: any[][] = [];
    const stop = client.subscribeRawChanges("articles", (messages) => batches.push([...messages]));
    let view: ReturnType<typeof createLiveQueryCollection> | undefined;
    try {
      await within(new Promise<void>((resolve) => c.onFirstReady(resolve)));
      assert.equal(c.size, 0);
      assert.equal(batches.length, 0, "control-only baseline never invalidates a reader");
      mock.publish({ id: "b", title: "never loaded" }, "delete");
      await within((async () => { while (batches.length < 1) await delay(1); })());
      assert.equal(c.size, 0, "an uncached delete need not change collection state");
      assert.equal(batches[0][0].headers.operation, "delete");
      mock.publish({ id: "a", title: "Alpha" });
      await within((async () => { while (batches.length < 2 || c.get("a")?.title !== "Alpha") await delay(1); })());
      mock.publish({ id: "a", title: "Beta" });
      await within((async () => { while (batches.length < 3 || c.get("a")?.title !== "Beta") await delay(1); })());
      assert.equal(batches[2][0].value.title, "Beta", "a rename-away is observable without its previous value");
      c.createIndex((row: any) => row.id, { indexType: BTreeIndex });
      view = createLiveQueryCollection({
        query: (q) => q.from({ row: c }).where(({ row }: any) => eq(row.id, "a")).orderBy(({ row }: any) => row.id).limit(1),
      });
      await within(view.toArrayWhenReady());
      assert.ok(mock.requests.some((url) => url.searchParams.has("subset__where")));
      await delay(20);
      assert.equal(batches.length, 3, "subset snapshots cannot create a read-refresh feedback loop");
      stop();
      stop();
      mock.publish({ id: "a", title: "after unsubscribe" });
      await within((async () => { while (c.get("a")?.title !== "after unsubscribe") await delay(1); })());
      assert.equal(batches.length, 3);
      await view.cleanup();
      await within((async () => { while (c.status !== "cleaned-up") await delay(5); })());
    } finally { stop(); await view?.cleanup(); await c.cleanup(); }
  },
});

Deno.test({
  name: "raw readiness and an exact-key subset recover after GC with a repeated stream cursor",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const client = clientFor(mock);
    const c = client.collections.articles;
    const first = client.subscribeRawChanges("articles", () => {});
    await within(client.waitForRawReady("articles"));
    await delay(20);
    first();
    await within((async () => { while (c.status !== "cleaned-up") await delay(5); })());
    await assert.rejects(client.waitForRawReady("articles"), /no active/);
    const second = client.subscribeRawChanges("articles", () => {});
    let view: ReturnType<typeof createLiveQueryCollection> | undefined;
    try {
      await within(client.waitForRawReady("articles"));
      c.createIndex((row: any) => row.id, { indexType: BTreeIndex });
      view = createLiveQueryCollection({
        query: (q) => q.from({ row: c }).where(({ row }: any) => eq(row.id, "a")).orderBy(({ row }: any) => row.id).limit(1),
      });
      assert.equal((await within(view.toArrayWhenReady()))[0]?.title, "before");
      assert.ok(mock.requests.filter((url) => url.searchParams.get("offset") === "now").length >= 2);
    } finally { second(); await view?.cleanup(); await c.cleanup(); }
  },
});

Deno.test({
  name: "raw readiness waits through a 401 until the retried stream receives its baseline",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const fetcher = mock.fetcher;
    let attempts = 0;
    let release!: () => void;
    const retried = new Promise<void>((resolve) => { release = resolve; });
    mock.fetcher = async (input, init) => {
      if (new URL(String(input)).pathname === "/electric/v1/shape") {
        if (++attempts === 1) return new Response("expired", { status: 401 });
        await retried;
      }
      return fetcher(input, init);
    };
    const client = clientFor(mock);
    const c = client.collections.articles;
    const stop = client.subscribeRawChanges("articles", () => {});
    let ready = false;
    const baseline = client.waitForRawReady("articles").then(() => { ready = true; });
    try {
      await within(new Promise<void>((resolve) => c.onFirstReady(resolve)));
      assert.equal(ready, false, "adapter error readiness is not a live baseline");
      release();
      await within(baseline);
      assert.ok(attempts >= 2);
    } finally { release(); stop(); await c.cleanup(); }
  },
});

Deno.test({
  name: "terminal stream errors reject raw readiness instead of releasing an HTTP read",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const mock = transport();
    const fetcher = mock.fetcher;
    mock.fetcher = (input, init) => new URL(String(input)).pathname === "/electric/v1/shape"
      ? Promise.resolve(new Response("invalid shape", { status: 400 })) : fetcher(input, init);
    const client = clientFor(mock);
    const stop = client.subscribeRawChanges("articles", () => {});
    try {
      await assert.rejects(within(client.waitForRawReady("articles")), /400|invalid shape/);
      await assert.rejects(client.waitForRawReady("articles"), /400|invalid shape/);
    } finally { stop(); await client.collections.articles.cleanup(); }
  },
});
