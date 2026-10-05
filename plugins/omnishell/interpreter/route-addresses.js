import { ProgramError, routeHref } from "./fragment.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_SIZE = 50;
const CACHE_SIZE = 1024;
const descriptorKey = (d) => JSON.stringify([d.table, d.id, d.field, d.filter ?? "", d.type]);
const entryKey = (descriptor, value) => JSON.stringify([descriptor, value]);
const normalizeId = (d, value) => d.type === "uuid" ? String(value).toLowerCase() : String(value);

/** Public identifiers are immutable. This cache belongs to one store/session;
 * bounded lookups use the store's ordinary read leases, not a second transport. */
export function createRouteAddresses(cfg, store, routeAtUrl) {
  const cache = new Map();
  const aliases = new Map();
  const pending = new Map();
  let scheduled = false;

  const routeOf = (screen) => {
    const route = cfg.routes?.find((r) => r.screen === screen);
    if (!route) throw new ProgramError(`data-route names "${screen}", which is no route of this app`);
    return route;
  };
  const get = (d, column, value) => {
    const descriptor = descriptorKey(d);
    const key = column === d.id
      ? entryKey(descriptor, normalizeId(d, value))
      : aliases.get(entryKey(descriptor, String(value)));
    const record = cache.get(key);
    if (record) {
      cache.delete(key);
      cache.set(key, record);
    }
    return record;
  };
  const remember = (d, row) => {
    if (row[d.id] == null || row[d.field] == null || row[d.field] === "") return undefined;
    const descriptor = descriptorKey(d);
    const record = { id: normalizeId(d, row[d.id]), slug: String(row[d.field]), descriptor };
    const key = entryKey(descriptor, record.id);
    const previous = cache.get(key);
    if (previous) aliases.delete(entryKey(descriptor, previous.slug));
    cache.delete(key);
    cache.set(key, record);
    aliases.set(entryKey(descriptor, record.slug), key);
    while (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      aliases.delete(entryKey(evicted.descriptor, evicted.slug));
    }
    return record;
  };

  const flush = async () => {
    scheduled = false;
    const groups = new Map();
    for (const [key, request] of pending) {
      if (request.started) continue;
      request.started = true;
      const groupKey = entryKey(descriptorKey(request.d), request.column);
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ ...request, key });
    }
    const reads = [];
    for (const group of groups.values()) {
      for (let at = 0; at < group.length; at += BATCH_SIZE) {
        const chunk = group.slice(at, at + BATCH_SIZE);
        reads.push((async () => {
          const { d, column } = chunk[0];
          // Quote before URI encoding: commas, parentheses, quotes and slashes
          // in a value must stay one PostgREST literal after URL decoding.
          const values = chunk.map(({ value }) => encodeURIComponent(JSON.stringify(value))).join(",");
          const filter = [d.filter, `${column}=in.(${values})`, `limit=${chunk.length}`].filter(Boolean).join("&");
          try {
            const rows = await store.query(d.table, undefined, { filter, select: `${d.id},${d.field}` });
            const found = new Map();
            for (const row of rows) {
              const record = remember(d, row);
              if (record) found.set(column === d.id ? record.id : record.slug, record);
            }
            for (const request of chunk) request.resolve(found.get(request.value));
          } catch (error) {
            for (const request of chunk) request.reject(error);
          } finally {
            for (const request of chunk) pending.delete(request.key);
          }
        })());
      }
    }
    await Promise.all(reads);
  };

  const lookup = (d, column, raw) => {
    const value = column === d.id ? normalizeId(d, raw) : String(raw);
    if (column === d.id && d.type === "uuid" && !UUID.test(value)) return Promise.resolve(undefined);
    const hit = get(d, column, value);
    if (hit) return Promise.resolve(hit);
    const key = JSON.stringify([descriptorKey(d), column, value]);
    if (pending.has(key)) return pending.get(key).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(key, { d, column, value, promise, resolve, reject, started: false });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    return promise;
  };

  const cachedHref = (screen, params, locale, options) => {
    const route = routeOf(screen);
    // Keep routeHref's missing-param and locale validation even on a cache miss.
    if (routeHref(cfg, screen, params, locale, options) === undefined) return undefined;
    const publicParams = { ...params };
    for (const [name, d] of Object.entries(route.routeParams ?? {})) {
      const record = get(d, d.id, params[name]);
      if (!record) return undefined;
      publicParams[name] = record.slug;
    }
    return routeHref(cfg, screen, publicParams, locale, options);
  };

  const href = async (screen, params, locale, options) => {
    const route = routeOf(screen);
    if (routeHref(cfg, screen, params, locale, options) === undefined) return undefined;
    const publicParams = { ...params };
    const records = await Promise.all(Object.entries(route.routeParams ?? {}).map(async ([name, d]) => {
      const record = await lookup(d, d.id, params[name]);
      if (record) publicParams[name] = record.slug;
      return record;
    }));
    if (records.some((record) => !record)) return undefined;
    return routeHref(cfg, screen, publicParams, locale, options);
  };

  const resolve = async (route, rawParams) => {
    const params = { ...rawParams };
    const publicParams = { ...rawParams };
    const records = await Promise.all(Object.entries(route.routeParams ?? {}).map(async ([name, d]) => {
      const value = rawParams[name];
      if (value == null || value === "") return undefined;
      const column = d.type === "uuid" && UUID.test(String(value)) ? d.id : d.field;
      const record = await lookup(d, column, value);
      if (record) {
        params[name] = record.id;
        publicParams[name] = record.slug;
      }
      return record;
    }));
    return records.some((record) => !record) ? null : { params, publicParams };
  };

  // Renderers describe ordinary links, without access to the terminal's
  // binding vocabulary. Resolve local route links after the safe DOM builder.
  const rendered = new WeakMap();
  const bindRendered = (target) => {
    if (!routeAtUrl) return;
    for (const el of target.querySelectorAll("a")) {
      const previous = rendered.get(el);
      const current = el.getAttribute("href");
      const raw = previous && (current === null || current === previous.href) ? previous.raw : current;
      if (!raw || raw.startsWith("#")) continue;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) continue;
      const found = routeAtUrl(url);
      if (!found?.route.routeParams) continue;
      const generation = { raw, connected: el.isConnected, href: null };
      rendered.set(el, generation);
      el.removeAttribute("href");
      resolve(found.route, found.params).then(result => {
        if (rendered.get(el) !== generation || !target.contains(el) || (generation.connected && !el.isConnected)) return;
        if (!result) return;
        const publicUrl = new URL(routeHref(cfg, found.route.screen, result.publicParams, found.locale, {explicitLocale:true}), location.href);
        for (const [key,value] of url.searchParams) if (key !== "lang") publicUrl.searchParams.append(key,value);
        publicUrl.hash = url.hash;
        generation.href = publicUrl.pathname + publicUrl.search + publicUrl.hash;
        el.setAttribute("href", generation.href);
      }).catch(error => console.error(error));
    }
  };
  return { href, cachedHref, resolve, bindRendered };
}

const bindings = new WeakMap();

/** The caller retries on resume. A rebind supersedes an earlier lookup even
 * when rows reuse a detached element or change locale before a read returns. */
export async function bindAddress(el, cfg, params, locale, service, options = { explicitLocale: true }) {
  const screen = el.dataset.route;
  const generation = {};
  bindings.set(el, generation);
  const connected = el.isConnected;
  const apply = (href) => {
    if (bindings.get(el) !== generation || el.dataset.route !== screen || (connected && !el.isConnected)) return;
    if (href === undefined) el.removeAttribute("href");
    else el.setAttribute("href", href);
  };
  if (!service) {
    apply(routeHref(cfg, screen, params, locale, options));
    return;
  }
  const cached = service.cachedHref(screen, params, locale, options);
  apply(cached);
  if (cached === undefined) apply(await service.href(screen, { ...params }, locale, options));
}
