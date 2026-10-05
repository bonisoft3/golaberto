import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { bindAddress, createRouteAddresses } from "../interpreter/route-addresses.js"
import { routeAt } from "../interpreter/shell.js"

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
const mapping = (kind = "team") => ({ table: "public_address", id: "record_id", field: "slug", filter: `kind=eq.${kind}`, type: "uuid" })
const CFG = {
  prefix: "/archive",
  i18n: { default: "pt-BR", locales: { "pt-BR": { path: "pt-br" }, en: { path: "en" } } },
  routes: [
    { screen: "home", path: "/" },
    { screen: "team", path: "/equipe/:id", paths: { "pt-BR": "/equipe/:id", en: "/team/:id" }, routeParams: { id: mapping() } },
    { screen: "team-edit", path: "/editar/:id", routeParams: { id: mapping() } },
    { screen: "campaign", path: "/equipe-campeonato/:id/:championship", routeParams: { id: mapping(), championship: mapping("championship") } },
  ],
}
type Row = { kind: string; record_id: string; slug: string }
type Read = { table: string; filter: string; select: string }
const records: Row[] = [
  { kind: "team", record_id: id(1), slug: "sao-paulo" },
  { kind: "team", record_id: id(2), slug: "santos" },
  { kind: "championship", record_id: id(3), slug: "brasileirao-2026" },
]

function store(rows = records) {
  const reads: Read[] = []
  let failure: Error | undefined
  let beforeRead: (() => Promise<void>) | undefined
  return {
    reads,
    fail(error?: Error) { failure = error },
    delay(fn?: () => Promise<void>) { beforeRead = fn },
    async query(table: string, _order: unknown, opts: { filter: string; select: string }) {
      reads.push({ table, ...opts })
      await beforeRead?.()
      if (failure) throw failure
      const query = new URLSearchParams(opts.filter)
      const column = query.has("record_id") ? "record_id" : "slug"
      const expression = query.get(column)!
      const values = JSON.parse(`[${expression.slice(4, -1)}]`)
      return rows.filter((r) => r.kind === query.get("kind")!.slice(3) && values.includes(r[column]))
        .slice(0, Number(query.get("limit")))
    },
  }
}

describe("declared route addresses", () => {
  it("batches and deduplicates UUID lookups across screens with the same descriptor", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    expect(addresses.cachedHref("team", { id: id(1) }, "pt-BR")).toBeUndefined()
    const links = await Promise.all([
      addresses.href("team", { id: id(1) }, "pt-BR"),
      addresses.href("team-edit", { id: id(1) }, "pt-BR"),
      addresses.href("team", { id: id(2) }, "en"),
    ])
    expect(links).toEqual(["/archive/equipe/sao-paulo", "/archive/editar/sao-paulo", "/archive/en/team/santos"])
    expect(data.reads.length).toBe(1)
    expect(new URLSearchParams(data.reads[0].filter).get("limit")).toBe("2")
    expect(data.reads[0].select).toBe("record_id,slug")
    expect(addresses.cachedHref("team", { id: id(1) }, "pt-BR", { explicitLocale: true })).toBe("/archive/equipe/sao-paulo?lang=pt-BR")
    expect(await addresses.href("team", { id: id(1) }, "en")).toBe("/archive/en/team/sao-paulo")
    expect(data.reads.length).toBe(1)
  })

  it("resolves slugs and legacy UUIDs to internal UUID parameters", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    const route = CFG.routes[1]
    const expected = { params: { id: id(1), locale: "en", tab: "history" }, publicParams: { id: "sao-paulo", locale: "en", tab: "history" } }
    expect(await addresses.resolve(route, { id: "sao-paulo", locale: "en", tab: "history" })).toEqual(expected)
    expect(await addresses.resolve(route, { id: id(1), locale: "en", tab: "history" })).toEqual(expected)
    expect(data.reads.length).toBe(1)
    expect(data.reads[0].filter).toContain("slug=in.")
    expect(data.reads[0].filter).not.toContain("record_id=in.")
  })

  it("normalizes uppercase legacy UUIDs and caches both directions", async () => {
    const uuid = "AABBCCDD-0000-0000-0000-000000000001"
    const data = store([{ kind: "team", record_id: uuid.toLowerCase(), slug: "team-a" }])
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.resolve(CFG.routes[1], { id: uuid })).toEqual({ params: { id: uuid.toLowerCase() }, publicParams: { id: "team-a" } })
    expect(await addresses.resolve(CFG.routes[1], { id: "team-a" })).toEqual({ params: { id: uuid.toLowerCase() }, publicParams: { id: "team-a" } })
    expect(data.reads.length).toBe(1)
  })

  it("resolves two parameters independently without changing their UUID model", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.resolve(CFG.routes[3], { id: "sao-paulo", championship: id(3) })).toEqual({
      params: { id: id(1), championship: id(3) }, publicParams: { id: "sao-paulo", championship: "brasileirao-2026" },
    })
    expect(await addresses.href("campaign", { id: id(1), championship: id(3) }, "en")).toBe("/archive/en/equipe-campeonato/sao-paulo/brasileirao-2026")
    expect(data.reads.length).toBe(2)
    expect(data.reads.map((r) => new URLSearchParams(r.filter).get("kind")).sort()).toEqual(["eq.championship", "eq.team"])
  })

  it("keeps identical UUIDs in different declared scopes distinct", async () => {
    const data = store([
      { kind: "team", record_id: id(1), slug: "team-one" },
      { kind: "championship", record_id: id(1), slug: "cup-one" },
    ])
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.href("campaign", { id: id(1), championship: id(1) }, "en")).toBe("/archive/en/equipe-campeonato/team-one/cup-one")
    expect(await addresses.resolve(CFG.routes[3], { id: "team-one", championship: "cup-one" })).toEqual({
      params: { id: id(1), championship: id(1) }, publicParams: { id: "team-one", championship: "cup-one" },
    })
    expect(data.reads.length).toBe(2)
  })

  it("quotes PostgREST literals before encoding hostile slugs", async () => {
    const slug = 'a,b).or=(record_id.not.is.null)&limit=999+"\\/á'
    const data = store([{ kind: "team", record_id: id(1), slug }])
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.resolve(CFG.routes[1], { id: slug })).toEqual({ params: { id: id(1) }, publicParams: { id: slug } })
    const query = new URLSearchParams(data.reads[0].filter)
    expect([...query.keys()]).toEqual(["kind", "slug", "limit"])
    expect(query.get("limit")).toBe("1")
    expect(await addresses.href("team", { id: id(1) }, "en")).toBe(`/archive/en/team/${encodeURIComponent(slug)}`)
  })

  it("returns missing without caching misses or sending invalid UUID filters", async () => {
    const rows: Row[] = []
    const data = store(rows)
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.resolve(CFG.routes[1], { id: "new-team" })).toBeNull()
    expect(await addresses.href("team", { id: id(1) }, "en")).toBeUndefined()
    expect(await addresses.href("team", { id: "invalid-uuid" }, "en")).toBeUndefined()
    expect(data.reads.length).toBe(2)
    rows.push({ kind: "team", record_id: id(1), slug: "new-team" })
    expect(await addresses.resolve(CFG.routes[1], { id: "new-team" })).toEqual({ params: { id: id(1) }, publicParams: { id: "new-team" } })
    expect(data.reads.length).toBe(3)
  })

  it("keeps failed reads distinguishable from missing and permits retry", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    data.fail(new Error("offline"))
    await expect(addresses.resolve(CFG.routes[1], { id: "sao-paulo" })).rejects.toThrow("offline")
    await expect(addresses.href("team", { id: id(1) }, "en")).rejects.toThrow("offline")
    data.fail()
    expect(await addresses.href("team", { id: id(1) }, "en")).toBe("/archive/en/team/sao-paulo")
    expect(data.reads.length).toBe(3)
  })

  it("uses bounded batches rather than keys on the registry's different primary key", async () => {
    const rows = Array.from({ length: 121 }, (_, n) => ({ kind: "team", record_id: id(n), slug: `team-${n}` }))
    const data = store(rows)
    const addresses = createRouteAddresses(CFG, data)
    const links = await Promise.all(rows.map((row) => addresses.href("team", { id: row.record_id }, "en")))
    expect(links.every((link) => typeof link === "string")).toBe(true)
    expect(data.reads.map((r) => Number(new URLSearchParams(r.filter).get("limit")))).toEqual([50, 50, 21])
  })

  it("bounds positive mappings and their reverse aliases with LRU eviction", async () => {
    const rows = Array.from({ length: 1025 }, (_, n) => ({ kind: "team", record_id: id(n), slug: `team-${n}` }))
    const data = store(rows)
    const addresses = createRouteAddresses(CFG, data)
    await Promise.all(rows.slice(0, 1024).map((row) => addresses.href("team", { id: row.record_id }, "en")))
    expect(addresses.cachedHref("team", { id: id(0) }, "en")).toBe("/archive/en/team/team-0")
    await addresses.href("team", { id: id(1024) }, "en")
    expect(addresses.cachedHref("team", { id: id(1) }, "en")).toBeUndefined()
    const before = data.reads.length
    await addresses.resolve(CFG.routes[1], { id: "team-1" })
    expect(data.reads.length).toBe(before + 1)
    expect(addresses.cachedHref("team", { id: id(0) }, "en")).toBe("/archive/en/team/team-0")
  })

  it("preserves routeHref validation and does no I/O for ordinary or empty routes", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    expect(await addresses.href("home", {}, "en")).toBe("/archive/en")
    expect(await addresses.href("team", { id: "" }, "en")).toBeUndefined()
    expect(await addresses.resolve(CFG.routes[0], { tab: "all" })).toEqual({ params: { tab: "all" }, publicParams: { tab: "all" } })
    expect(() => addresses.cachedHref("team", {}, "en")).toThrow("no data-param-id")
    await expect(addresses.href("absent", {}, "en")).rejects.toThrow("no route of this app")
    expect(data.reads.length).toBe(0)
  })
})

describe("asynchronous link binding", () => {
  const anchor = () => parseHTML('<html><body><a data-route="team" href="/stale"></a></body></html>').document.querySelector("a")!

  it("removes stale href while pending and does not let an old row or locale win", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    const releases: (() => void)[] = []
    data.delay(() => new Promise<void>((done) => { releases.push(done) }))
    const el = anchor()
    const first = bindAddress(el, CFG, { id: id(1) }, "pt-BR", addresses)
    await Promise.resolve()
    const second = bindAddress(el, CFG, { id: id(2) }, "en", addresses)
    expect(el.hasAttribute("href")).toBe(false)
    await Promise.resolve()
    releases[1]()
    await second
    expect(el.getAttribute("href")).toBe("/archive/en/team/santos")
    releases[0]()
    await first
    expect(el.getAttribute("href")).toBe("/archive/en/team/santos")
  })

  it("does not update a removed connected node and immediately uses cached mappings", async () => {
    const data = store()
    const addresses = createRouteAddresses(CFG, data)
    let release!: () => void
    data.delay(() => new Promise<void>((done) => { release = done }))
    const el = anchor()
    const first = bindAddress(el, CFG, { id: id(1) }, "en", addresses)
    el.remove()
    await Promise.resolve()
    release()
    await first
    expect(el.hasAttribute("href")).toBe(false)
    const next = anchor()
    const bound = bindAddress(next, CFG, { id: id(1) }, "pt-BR", addresses)
    expect(next.getAttribute("href")).toBe("/archive/equipe/sao-paulo?lang=pt-BR")
    await bound
    expect(data.reads.length).toBe(1)
  })
})

describe("renderer route addresses", () => {
  const turn = () => new Promise<void>(done => setTimeout(done, 0))
  const withLocation = async (run: () => Promise<void>) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/archive/en/team/current") })
    try { await run() }
    finally {
      if (previous) Object.defineProperty(globalThis, "location", previous)
      else Reflect.deleteProperty(globalThis, "location")
    }
  }
  const renderedService = (data: ReturnType<typeof store>) => createRouteAddresses(CFG, data,
    (url: URL) => routeAt(CFG, url.pathname, url.search, ["pt-BR"]))

  it("resolves local SVG links and preserves query values, hash, locale and mount", async () => withLocation(async () => {
    const data = store()
    const addresses = renderedService(data)
    const { document } = parseHTML(`<html><body><div><svg><a id="local" href="/archive/en/team/${id(1)}?ref=chart&amp;ref=history#point"><circle/></a></svg><a id="external" href="https://elsewhere.test/archive/en/team/${id(1)}">external</a><a id="hash" href="#point">section</a><a id="home" href="/archive">home</a></div></body></html>`)
    const target = document.querySelector("div")!
    addresses.bindRendered(target)
    expect(document.querySelector("#local")!.hasAttribute("href")).toBe(false)
    await turn()
    expect(document.querySelector("#local")!.getAttribute("href")).toBe("/archive/en/team/sao-paulo?ref=chart&ref=history#point")
    expect(document.querySelector("#external")!.getAttribute("href")).toBe(`https://elsewhere.test/archive/en/team/${id(1)}`)
    expect(document.querySelector("#hash")!.getAttribute("href")).toBe("#point")
    expect(document.querySelector("#home")!.getAttribute("href")).toBe("/archive")
    expect(data.reads.length).toBe(1)
    addresses.bindRendered(target)
    await turn()
    expect(document.querySelector("#local")!.getAttribute("href")).toBe("/archive/en/team/sao-paulo?ref=chart&ref=history#point")
    expect(data.reads.length).toBe(1)
  }))

  it("honors a renderer rebinding the same node before the first request returns", async () => withLocation(async () => {
    const data = store()
    const addresses = renderedService(data)
    const releases: (() => void)[] = []
    data.delay(() => new Promise<void>(done => { releases.push(done) }))
    const { document } = parseHTML(`<html><body><div><svg><a href="/archive/equipe/${id(1)}?lang=pt-BR#old"><circle/></a></svg></div></body></html>`)
    const target = document.querySelector("div")!
    const link = document.querySelector("a")!
    addresses.bindRendered(target)
    await turn()
    link.setAttribute("href", `/archive/en/team/${id(2)}#new`)
    addresses.bindRendered(target)
    await turn()
    // Release every request; the node's current target wins independent of
    // whether the two identities were batched or finished in reverse order.
    for (const release of releases.reverse()) release()
    await turn()
    expect(link.getAttribute("href")).toBe("/archive/en/team/santos#new")
  }))

  it("does not update a chart whose connected container was removed during lookup", async () => withLocation(async () => {
    const data = store()
    const addresses = renderedService(data)
    let release!: () => void
    data.delay(() => new Promise<void>(done => { release = done }))
    const { document } = parseHTML(`<html><body><div><svg><a href="/archive/en/team/${id(1)}"><circle/></a></svg></div></body></html>`)
    const target = document.querySelector("div")!
    const link = document.querySelector("a")!
    addresses.bindRendered(target)
    await turn()
    target.remove()
    release()
    await turn()
    expect(link.hasAttribute("href")).toBe(false)
  }))

  it("ignores a replaced chart node while resolving its replacement", async () => withLocation(async () => {
    const data = store()
    const addresses = renderedService(data)
    let release!: () => void
    data.delay(() => new Promise<void>(done => { release = done }))
    const { document } = parseHTML(`<html><body><div><svg><a href="/archive/en/team/${id(1)}"><circle/></a></svg></div></body></html>`)
    const target = document.querySelector("div")!
    const old = document.querySelector("a")!
    addresses.bindRendered(target)
    target.innerHTML = `<svg><a href="/archive/en/team/${id(2)}"><circle/></a></svg>`
    addresses.bindRendered(target)
    await turn()
    release()
    await turn()
    expect(old.hasAttribute("href")).toBe(false)
    expect(target.querySelector("a")!.getAttribute("href")).toBe("/archive/en/team/santos")
  }))
})
