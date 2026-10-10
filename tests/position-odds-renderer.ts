import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import render from "../shell/renderers/position-odds.js";
import { buildNodes } from "../../../plugins/omnishell/interpreter/render.js";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

const chart = () => ({
  positions: [
    { position: 1, percent: 0, current: false, reach: "reachable" },
    { position: 2, percent: 0.000123, current: true, reach: "" },
    { position: 3, percent: 32.5, current: false, reach: "" },
    { position: 4, percent: 67.499877, current: false, reach: "" },
  ],
  // In the fold's first, last, id order; the first zone holding a position paints it.
  zones: [
    { id: "a", name: "Source winner", color: "#aabbcc", first: 1, last: 3, positions: "1,3" },
    { id: "b", name: "Tie loser", color: "#112233", first: 1, last: 3, positions: "1,3" },
    { id: "z", name: "Later", color: "#112233", first: 1, last: 3, positions: "" },
  ],
});
const history = () => ({
  positions: [{ position: 4 }, { position: 3 }, { position: 2 }, { position: 1 }],
  snapshots: [
    { day: "2026-02-02", percentages: { "1": 10, "2": 20, "3": 30, "4": 40 } },
    { day: "2026-02-03", percentages: { "1": 40, "2": 30, "3": 20, "4": 10 } },
  ],
});
const input = (current: unknown = chart(), opts: Record<string, any> = {}) => [
  typeof current === "string" ? current : JSON.stringify(current),
  JSON.stringify(opts.history ?? history()), opts.title ?? "Finishing odds", opts.locale ?? "en-GB", "Unavailable",
  opts.position ?? "", opts.snapshot ?? "", opts.tableMode ?? "current", opts.mode ?? "graph",
  "Position", "Probability", "Current position", "Date", "Current odds", "Historical snapshot", "Impossible", "Still reachable", "Undecided", "No historical observations",
  opts.from ?? "", opts.to ?? "", "Selected probability", "Invalid range",
].join("\u001f");
const walk = (node: any): any[] => typeof node === "string" ? [] : [node, ...(node.children ?? []).flatMap(walk)];
const all = (value: string) => render(value).flatMap(walk);
const byClass = (nodes: any[], name: string) => nodes.filter(node => node.attrs?.class?.split(" ").includes(name));
const text = (node: any): string => typeof node === "string" ? node : (node.children ?? []).map(text).join("");

Deno.test("current histogram has centered equal bins, honest zero/tiny heights and a fixed probability scale", () => {
  const nodes = all(input());
  const bars = byClass(nodes, "position-odds__bar");
  assertEquals(bars.length, 4);
  assertEquals(bars.map(bar => bar.attrs.height), [0, 0.00019680000000000002, 52, 107.9998032]);
  assert(bars[1].attrs.height > 0 && bars[1].attrs.height < 1);
  assertEquals(bars[0].attrs.width, 574 / 4 * 0.62);
  assertEquals(bars[0].attrs.x + bars[0].attrs.width / 2, 52 + 574 / 8);
  assertEquals(byClass(nodes, "position-odds__grid").map(node => node.attrs.y1), [16, 56, 96, 136, 176]);
  assertEquals(byClass(nodes, "position-odds__tick").map(text), ["1", "2", "3", "4"]);
  assertEquals(nodes.filter(node => node.tag === "figcaption").length, 1);
  assertStringIncludes(text(bars[0]), "Still reachable");
  assertEquals(bars[1].attrs.title, "Position 2 · 1.230e-4% · Later · Current position");
  const changedHistory = history();
  changedHistory.snapshots[0].percentages["1"] = 99;
  assertEquals(render(input(chart(), { history: changedHistory, snapshot: 0, tableMode: "history" })), render(input()));
});

Deno.test("the first zone holding a position paints it, by role token or by source hex", () => {
  const bands = byClass(all(input()), "position-odds__band");
  assertEquals(bands.map(band => band.attrs.fill), ["#aabbcc", "#112233", "#aabbcc"]);
  // A source hex once kept its full light colour in dark mode beside its dimmed swatch.
  assertEquals(bands.map(band => band.attrs.class), Array(3).fill("position-odds__band zone-paint--hex"));
  assertEquals(bands.map(band => band.attrs.x), [52, 52 + 574 / 4, 52 + 574 / 2]);
  assertEquals(bands.map(text), ["Source winner", "Later", "Source winner"]);
  const value = chart();
  value.zones = value.zones.slice(1);
  assertEquals(byClass(all(input(value)), "position-odds__band").map(text), ["Tie loser", "Later", "Tie loser"]);
  value.zones[0].color = "relegation";
  const role = byClass(all(input(value)), "position-odds__band")[0];
  assertEquals(role.attrs.class, "position-odds__band zone-paint--relegation");
  assertEquals(role.attrs.fill, undefined);
  value.zones[0].color = "url(https://evil.example/)";
  assertThrows(() => render(input(value)), Error, "zone is malformed");
});

Deno.test("selection is bounded and independent from the source current-position marker", () => {
  const selected = all(input(chart(), { position: 999 }));
  assertStringIncludes(text(byClass(selected, "position-odds__bar--selected")[0]), "Position 4");
  assertEquals(byClass(selected, "position-odds__current")[0].attrs["aria-label"], "Current position: 2");
  const reference = byClass(selected, "position-odds__current")[0];
  assertEquals(reference.tag, "line");
  assertEquals(reference.attrs.x1, reference.attrs.x2);
  assert(reference.attrs.y1 < reference.attrs.y2, "current position spans the plot");
  assertEquals(selected.some(node => node.tag === "polygon"), false, "the current marker has no arrow");
  assertEquals(byClass(selected, "position-odds__current-label").map(text), ["Current position: 2"]);
  const inspector = render(input(chart(), { mode: "inspector", locale: "pt-BR" }))[0];
  assertStringIncludes(text(inspector), "Position 2");
  assertStringIncludes(text(inspector), "0,3..1%");
  assertEquals(inspector.children[1].children[0].children[0].attrs.title, "1,230e-4%");
  const noCurrent = chart();
  noCurrent.positions[1].current = false;
  assertStringIncludes(text(render(input(noCurrent, { mode: "inspector" }))[0]), "Position 4");
  noCurrent.positions[2].percent = noCurrent.positions[3].percent;
  assertStringIncludes(text(render(input(noCurrent, { mode: "inspector" }))[0]), "Position 3");
});

Deno.test("one semantic table shows only the current distribution or selected historical snapshot", () => {
  const value = input(chart(), { mode: "table", tableMode: "history", snapshot: 0, locale: "en-US" });
  const tables = all(value).filter(node => node.tag === "table");
  assertEquals(tables.length, 1);
  const table = tables[0];
  assertEquals(table.children[0].tag, "caption");
  assertEquals(text(table.children[0]), "Historical snapshot · Date: 2/2/2026");
  assertEquals(table.children[1].children[0].children.map((node: any) => node.attrs.scope), ["col", "col"]);
  assertEquals(table.children[2].children.length, 4);
  assertEquals(table.children[2].children.map((node: any) => node.children.map(text)), [["1", "10.00%"], ["2", "20.00%"], ["3", "30.00%"], ["4", "40.00%"]]);
  const latest = render(input(chart(), { mode: "table", tableMode: "history", locale: "pt-BR" }))[0];
  assertEquals(text(latest.children[0]), "Historical snapshot · Date: 03/02/2026");
  assertEquals(text(latest.children[2].children[0].children[1]), "40,00%");
  const current = render(input(chart(), { mode: "table", locale: "pt-BR" }))[0];
  assertEquals(text(current.children[0]), "Current odds");
  assertStringIncludes(text(current), "0,3..1%");
  assertStringIncludes(text(current), "32,50%");
  assertStringIncludes(text(current), "0,0% · Still reachable");
  const roundedUp = chart();
  roundedUp.positions[3].percent = 99.999;
  const nearHundred = render(input(roundedUp, { mode: "table", locale: "en-US" }))[0];
  const high = nearHundred.children[2].children[3].children[1].children[0];
  assertEquals(high.attrs.title, "99.[02]9%");
  assertEquals(high.children[0].attrs.title, "99.999%");
  assertEquals(text(high.children[0].children[1].children[0]), "2");
  const tinyPositive = nearHundred.children[2].children[1].children[1].children[0];
  assertEquals(tinyPositive.attrs.title, "0.[03]1%");
  assertEquals(tinyPositive.children[0].attrs.title, "1.230e-4%");
});

Deno.test("decimal percentages round without binary multiplication and compact both extremes accessibly", () => {
  const value = chart();
  value.positions = [
    { position: 1, percent: 0, current: false, reach: "impossible" },
    { position: 2, percent: 0.0000004, current: false, reach: "" },
    { position: 3, percent: 42.35453, current: false, reach: "" },
    { position: 4, percent: 99.9999, current: false, reach: "" },
  ];
  const table = render(input(value, { mode: "table", locale: "en-US" }))[0];
  const cells = table.children[2].children.map((row: any) => row.children[1]);
  assertEquals(text(cells[0]), "0.0% · Impossible");
  assertEquals(text(cells[1].children[0]), "0.6..4%");
  assertEquals(cells[1].children[0].attrs.title, "0.[06]4%");
  assertEquals(cells[1].children[0].children[0].attrs.title, "4.000e-7%");
  assertEquals(text(cells[2]), "42.35%");
  assertEquals(text(cells[3].children[0]), "99.3..9%");
  assertEquals(cells[3].children[0].attrs.title, "99.[03]9%");
  assertEquals(cells[3].children[0].children[0].attrs.title, "99.9999%");

  const boundaries = chart();
  boundaries.positions = [
    { position: 1, percent: 100, current: false, reach: "" },
    { position: 2, percent: 0.005, current: false, reach: "" },
    { position: 3, percent: 99.9955, current: false, reach: "" },
    { position: 4, percent: Number.MIN_VALUE, current: false, reach: "" },
  ];
  const edgeCells = render(input(boundaries, { mode: "table", locale: "en-US" }))[0].children[2].children.map((row: any) => row.children[1]);
  assertEquals(text(edgeCells[0]), "100.0%");
  assertEquals(text(edgeCells[1]), "0.01%");
  assertEquals(edgeCells[2].children[0].attrs.title, "99.[02]6%");
  assertEquals(edgeCells[2].children[0].children[0].attrs.title, "99.9955%");
  assertEquals(text(edgeCells[3]), "5e-324%");
  assertEquals(edgeCells[3].children[0].attrs.title, "4.941e-324%");
  assertEquals(edgeCells[3].children[0].attrs.class, undefined);
});

Deno.test("the chances-screen cell formatter uses the same accessible compact odds output", () => {
  const tiny: any = render(["0.0000004", "en-US", "compact-percent"].join("\u001f"))[0];
  assertEquals(text(tiny), "0.6..4%");
  assertEquals(tiny.attrs.title, "0.[06]4%");
  assertEquals(tiny.children[0].attrs.title, "4.000e-7%");
  const upper: any = render(["99.9999", "en-US", "compact-percent"].join("\u001f"))[0];
  assertEquals(text(upper), "99.3..9%");
  assertEquals(upper.attrs.title, "99.[03]9%");
  assertEquals(upper.children[0].attrs.title, "99.9999%");
  const twoDigits: any = render(["1e-14", "pt-BR", "compact-percent"].join("\u001f"))[0];
  assertEquals(text(twoDigits), "0,13..1%");
  assertEquals(twoDigits.attrs.title, "0,[13]1%");
  assertEquals(twoDigits.children[0].attrs.title, "1,000e-14%");
  assertEquals(twoDigits.children[0].children[1].children[0].attrs.class, "position-odds__count--two-digits");
  assertEquals(text(render(["42.35453", "en-US", "compact-percent"].join("\u001f"))[0]), "42.35%");
  assertThrows(() => render(["101", "en-US", "compact-percent"].join("\u001f")), Error, "out of range");
});

Deno.test("absent odds and history say so; malformed ones fail loudly", () => {
  for (const absent of [{}, { positions: [] }]) assertStringIncludes(text(render(input(absent))[0]), "Unavailable");
  for (const invalid of ["{", { positions: [{ position: 0, percent: 20 }] },
    { positions: [{ position: 1, percent: 20 }, { position: 1, percent: 80 }] },
    ...[-1, 100.51, null, "20"].map(percent => ({ positions: [{ position: 1, percent }] })),
  ]) assertThrows(() => render(input(invalid)));
  for (const absent of [{ snapshots: [] }, {}]) {
    const nodes = render(input(chart(), { mode: "table", tableMode: "history", history: absent }));
    assertEquals(nodes.flatMap(walk).some(node => node.tag === "table"), false);
    assertEquals(text(nodes[0]), "No historical observations");
  }
  for (const malformed of [{ ...history(), snapshots: [{ day: "2026-02-30", percentages: history().snapshots[0].percentages }] },
    { ...history(), snapshots: [{ day: "2026-02-02", percentages: { "1": 40 } }] },
  ]) assertThrows(() => render(input(chart(), { mode: "table", tableMode: "history", history: malformed })));
});

Deno.test("an inclusive final-position range totals its odds; a partial, reversed or outside range says so", () => {
  const selection = (from: string, to: string, locale = "en-GB") =>
    byClass(all(input(chart(), { from, to, locale })), "position-odds__selection");
  assertEquals(selection("", "").length, 0);
  assertEquals(selection("2", "3", "pt-BR").map(text), ["Selected probability: 32,5%"]);
  assertEquals(selection("1", "4").map(text), ["Selected probability: 100%"]);
  for (const [from, to] of [["2", ""], ["3", "2"], ["1", "5"], ["0", "2"], ["1e2", "3"]]) {
    const invalid = selection(from, to);
    assertEquals(invalid.map(node => node.attrs.class), ["position-odds__selection position-odds__selection--invalid"]);
    assertEquals(invalid.map(text), ["Invalid range"]);
  }
});

Deno.test("renderer evaluates in the sandbox and keeps untrusted source text inert through the safe builder", async () => {
  const caged = await evaluateRole(await Deno.readTextFile(new URL("../shell/renderers/position-odds.js", import.meta.url)), "renderer");
  for (const mode of ["graph", "table", "inspector"]) {
    const value = input(chart(), { mode });
    assertEquals(caged(value), render(value));
  }
  const priorDocument = (globalThis as any).document;
  const make = (tag: string, namespaceURI: string) => {
    const attributes = new Map();
    return {
      localName: tag, namespaceURI, children: [] as any[],
      setAttribute(key: string, value: string) { attributes.set(key, value); },
      getAttribute(key: string) { return attributes.get(key) ?? null; },
      hasAttribute(key: string) { return attributes.has(key); },
      append(child: any) { this.children.push(child); },
      get textContent(): string { return this.children.map(child => child.textContent).join(""); },
    };
  };
  (globalThis as any).document = {
    createElement: (tag: string) => make(tag, "html"),
    createElementNS: (ns: string, tag: string) => make(tag, ns),
    createTextNode: (value: string) => ({ textContent: value }),
  };
  try {
    const hostile = '<script>alert(1)</script>';
    const value = chart();
    value.zones[0].name = hostile;
    const target: any = { children: [], replaceChildren(...children: any[]) { this.children = children; } };
    for (const mode of ["graph", "inspector", "table"]) {
      buildNodes(render(input(value, { mode, title: hostile, position: 1 })), target);
      const nodes = walk(target.children[0]);
      assertEquals(nodes.some(node => node.localName === "script"), false);
      if (mode !== "table") assertStringIncludes(target.children[0].textContent, hostile);
      assert(nodes.filter(node => ["rect", "polygon", "text"].includes(node.localName)).every(node => node.namespaceURI === "http://www.w3.org/2000/svg"));
      if (mode === "graph") {
        // Source-defined zone colours reach the built SVG as their own paint.
        assertEquals(nodes.filter(node => node.localName === "rect" && node.getAttribute("fill") !== null).map(node => node.getAttribute("fill")), ["#aabbcc", "#112233", "#aabbcc"]);
      }
    }
  } finally {
    if (priorDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = priorDocument;
  }
});
