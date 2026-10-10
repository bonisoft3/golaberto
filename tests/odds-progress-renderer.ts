import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import render from "../shell/renderers/odds-progress.js";
import { buildNodes } from "../../../plugins/omnishell/interpreter/render.js";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

const SEP = "\u001f";
const championId = "11111111-1111-4111-8111-111111111111";
const qualifyId = "22222222-2222-4222-8222-222222222222";
const gameSlug = "home-x-away-2026-02-03";
const championColor = "#8a2be2";
const qualifyColor = "#90ee90";
const zone = (id: string, name: string, color: string, first: number, last: number) => ({
  id,
  name,
  color,
  first,
  last,
});
const chart = (count = 3) => {
  const snapshots = [
    {
      day: "2026-02-02",
      capturedAt: "2026-02-02T12:00:00Z",
      source: "imported",
      percentages: { "1": 15, "2": 25, "3": 60 },
      lastGame: null,
      zoneValues: { [championId]: 25, [qualifyId]: 40 },
    },
    {
      day: "2026-02-03",
      capturedAt: "2026-02-03T12:00:00Z",
      source: "imported",
      percentages: { "1": 20, "2": 30, "3": 50 },
      lastGame: {
        slug: gameSlug,
        homeName: "<script>home</script>",
        awayName: "Away",
        homeScore: 2,
        awayScore: 1,
      },
      zoneValues: { [championId]: 30, [qualifyId]: 50 },
    },
    {
      day: "2026-02-04",
      capturedAt: "2026-02-04T12:00:00Z",
      source: "imported",
      percentages: { "1": 25, "2": 25, "3": 50 },
      lastGame: null,
      zoneValues: { [championId]: 25, [qualifyId]: 50 },
    },
  ].slice(0, count);
  return {
    version: 1,
    kind: "odds-progress",
    positionCount: 3,
    sourceCount: count,
    retainedCount: count,
    omittedCount: 0,
    zones: [
      zone(championId, "Same name", championColor, 1, 2),
      zone(qualifyId, "Same name", qualifyColor, 2, 3),
    ],
    positions: [
      { position: 3, color: null, zoneIds: [] },
      { position: 2, color: championColor, zoneIds: [championId, qualifyId] },
      { position: 1, color: qualifyColor, zoneIds: [qualifyId] },
    ],
    snapshots,
  };
};
const input = (
  payload: unknown,
  options: { title?: string; locale?: string; zoneId?: string; index?: number; mode?: string; noGameLabel?: string; gamePrefix?: string } = {},
) => [
  JSON.stringify(payload),
  options.title ?? "Probability history",
  options.locale ?? "en-GB",
  "No observations",
  options.zoneId ?? "*",
  String(options.index ?? -1),
  options.gamePrefix ?? "/jogo/",
  "Probability history table",
  "Position",
  "Snapshots",
  "Omitted",
  options.mode ?? "graph",
  "Date",
  "Game",
  options.noGameLabel ?? "No game",
].join(SEP);

const walk = (node: any): any[] => [node, ...(node.children ?? []).flatMap(walk)];

Deno.test("stacked areas keep the fixed 0–100 scale and filter overlapping zones once", () => {
  const full = render(input(chart()))[0] as any;
  const svg = full.children.find((node: any) => node.tag === "svg");
  const paths = svg.children.filter((node: any) => node.tag === "path");
  assertEquals(paths.length, 3, "one filled area is rendered per final position");
  assertEquals(paths.map((path: any) => path.attrs.fill), [undefined, championColor, qualifyColor]);
  assertStringIncludes(paths[0].attrs.class, "team-odds-progress__area--unassigned", "unzoned positions follow the light/dark page surface through CSS");
  // A source hex once kept its full light colour in dark mode beside its dimmed swatch.
  assertEquals(paths[1].attrs.class, "team-odds-progress__area zone-paint--hex");
  assertStringIncludes(paths[2].attrs.d, ",18", "best position reaches the fixed 100% ceiling");
  assertEquals(
    svg.children.filter((node: any) => node.tag === "text")
      .filter((node: any) => node.children.some((child: any) => typeof child === "string" && child.endsWith("%")))
      .map((node: any) => node.children.at(-1)),
    ["100%", "75%", "50%", "25%", "0%"],
  );

  const filtered = render(input(chart(), { zoneId: championId }))[0] as any;
  const filteredSvg = filtered.children.find((node: any) => node.tag === "svg");
  const filteredPaths = filteredSvg.children.filter((node: any) => node.tag === "path");
  assertEquals(filteredPaths.length, 1, "overlapping memberships do not duplicate a position area");
  assertStringIncludes(filteredPaths[0].attrs.d, ",201", "the selected 25% remains on the unchanged 0–100 scale");
  assertEquals(
    (render(input(chart(), { zoneId: "unknown-zone" }))[0] as any).children
      .find((node: any) => node.tag === "svg").children.filter((node: any) => node.tag === "path").length,
    3,
    "unknown filters fall back to all positions",
  );
});

Deno.test("selected date gets a crosshair, exact zone inspector, and a local game link", () => {
  const figure = render(input(chart(), { index: 1, locale: "pt-BR" }))[0] as any;
  const svg = figure.children.find((node: any) => node.tag === "svg");
  const crosshair = svg.children.find((node: any) => node.attrs?.class === "team-odds-progress__crosshair");
  assertEquals(crosshair.attrs.x1, 339);
  assertEquals(figure.children.some((node: any) => node.attrs?.class === "team-odds-progress__inspector"), false);

  const inspector = render(input(chart(), { index: 1, locale: "pt-BR", mode: "inspector" }))[0] as any;
  assertEquals(inspector.attrs.class, "team-odds-progress__inspector");
  assertEquals(inspector.children.some((node: any) => node.tag === "svg" || node.tag === "figure"), false);
  assertEquals(inspector.children[0].children, ["03/02/2026"]);
  const link = inspector.children.flatMap((node: any) => walk(node)).find((node: any) => node.tag === "a");
  assertEquals(link.attrs.href, `/jogo/${gameSlug}`);
  const localized = walk(render(input(chart(), {index:1,mode:"inspector",gamePrefix:"/en/match/"}))[0]).find((node:any)=>node.tag === "a");
  assertEquals(localized.attrs.href,`/en/match/${gameSlug}`);
  assertEquals(localized.children,["<script>home</script> 2 × 1 Away"]);
  assertEquals(walk(render(input(chart(), {index:1,mode:"inspector",gamePrefix:"//outside/"}))[0]).some((node:any)=>node.tag === "a"),false);
  assertEquals(link.children.at(-1), "<script>home</script> 2 × 1 Away");
  assertEquals(inspector.children[2].children.length, 2, "all zone totals remain visible, including overlap");
  assertEquals(inspector.children[2].children[0].children.at(-1).children, ["30%"]);
  const noGame = render(input(chart(), { index: 0, mode: "inspector", noGameLabel: "Sin partido" }))[0] as any;
  assertEquals(noGame.children[1].children.at(-1), "Sin partido");
});

Deno.test("single observations stay visible and use localized civil-date labels", () => {
  const figure = render(input(chart(1), { locale: "en-US" }))[0] as any;
  const svg = figure.children.find((node: any) => node.tag === "svg");
  const path = svg.children.find((node: any) => node.tag === "path");
  assertStringIncludes(path.attrs.d, "M336,");
  assertStringIncludes(path.attrs.d, "L342,");
  const dateLabel = svg.children.find((node: any) => node.tag === "text" && node.children.includes("2/2"));
  assert(dateLabel);
  assertEquals(dateLabel.children[0].children, ["2/2/2026"]);
});

Deno.test("sampling summary separates invalid dates from retained eligible dates", () => {
  const sampled = { ...chart(), sourceCount: 404, omittedCount: 4 };
  const figure = render(input(sampled))[0] as any;
  const note = figure.children.find((node: any) => node.attrs?.class === "team-odds-progress__note");
  assertEquals(note.children.map((node: any) => node.children), [["Snapshots", " ", "3/400"], ["Omitted", " ", "4"]]);
});

Deno.test("table mode is accessible and preserves exact zone totals", () => {
  const figure = render(input(chart(), { mode: "table" }))[0] as any;
  const table = figure.children.find((node: any) => node.tag === "table");
  assertEquals(table.children[0].tag, "caption");
  const headers = table.children[1].children[0].children;
  assertEquals(headers.filter((node: any) => node.tag === "th").map((node: any) => node.attrs.scope), [
    "col",
    "col",
    "col",
    "col",
    "col",
    "col",
    "col",
  ]);
  assertEquals(table.children[2].children.length, 3);
  assertEquals(table.children[2].children[0].children[2].children, ["25%"]);
  assertEquals(table.children[2].children[0].children.slice(4).map((node: any) => node.children), [
    ["60%"],
    ["25%"],
    ["15%"],
  ]);

  const filtered = render(input(chart(), { mode: "table", zoneId: championId }))[0] as any;
  const filteredTable = filtered.children.find((node: any) => node.tag === "table");
  const filteredHeaders = filteredTable.children[1].children[0].children;
  assertEquals(filteredHeaders.length, 4, "a zone table contains only its aggregate and member positions");
  assertEquals(filteredTable.children[2].children[0].children.slice(2).map((node: any) => node.children), [["25%"], ["25%"]]);
});

Deno.test("table mode keeps every uncovered position when there are no zones or a stale filter", () => {
  const noZones = chart();
  noZones.zones = [];
  noZones.positions = noZones.positions.map((position: any) => ({ ...position, color: null, zoneIds: [] }));
  noZones.snapshots = noZones.snapshots.map((snapshot: any) => ({ ...snapshot, zoneValues: {} }));
  const tableFor = (zoneId: string) => {
    const figure = render(input(noZones, { mode: "table", zoneId }))[0] as any;
    return figure.children.find((node: any) => node.tag === "table");
  };
  for (const table of [tableFor("*"), tableFor("deleted-zone")]) {
    const headers = table.children[1].children[0].children;
    assertEquals(headers.length, 5, "two metadata columns remain plus all three uncovered positions");
    assertEquals(headers.slice(2).map((node: any) => node.children), [
      ["Position 3"],
      ["Position 2"],
      ["Position 1"],
    ]);
    assertEquals(table.children[2].children[0].children.slice(2).map((node: any) => node.children), [
      ["60%"],
      ["25%"],
      ["15%"],
    ]);
  }
});

Deno.test("an absent history is a titled empty state; a malformed one fails loudly", async () => {
  const empty = render(`{}${SEP}Odds${SEP}en-GB${SEP}Unavailable`)[0] as any;
  assertEquals(empty.attrs.class, "team-odds-progress team-odds-progress--empty");
  assertEquals(empty.children[0].children, ["Odds"]);
  assertEquals(empty.children[1].children, ["Unavailable"]);
  assertThrows(() => render(`{${SEP}Odds${SEP}en-GB${SEP}Unavailable`));
  const invalid = { ...chart(), snapshots: [{ ...chart(1).snapshots[0], percentages: { "1": 100, "2": 0 } }] };
  assertThrows(() => render(input(invalid)), Error, "malformed");
  const injectedColor = { ...chart(), positions: chart().positions.map((position: any, index: number) => index === 1
    ? { ...position, color: '#8a2be2" onload="alert(1)' }
    : position) };
  assertThrows(() => render(input(injectedColor)), Error, "malformed");
  const shortHex = { ...chart(), zones: chart().zones.map((item: any, index: number) => index === 0 ? { ...item, color: "#82e" } : item) };
  assertThrows(() => render(input(shortHex)), Error, "malformed");
  const role = { ...chart(), zones: chart().zones.map((item: any, index: number) => index === 0 ? { ...item, color: "champion" } : item),
    positions: chart().positions.map((position: any) => position.position === 2 ? { ...position, color: "champion" } : position) };
  const area = walk(render(input(role))[0]).find((node: any) => node.attrs?.class?.includes("zone-paint--champion"));
  assertEquals(area.tag, "path");
  assertEquals(area.attrs.fill, undefined);

  const source = await Deno.readTextFile(new URL("../shell/renderers/odds-progress.js", import.meta.url));
  const caged = await evaluateRole(source, "renderer");
  assertEquals(caged(input(chart(), { index: 1 })), render(input(chart(), { index: 1 })));
});

Deno.test("renderer output obeys the interpreter schema and keeps reader text inert", () => {
  const nodes = render(input(chart(), { title: "<script>caption</script>" }));
  const svgNS = "http://www.w3.org/2000/svg";
  const htmlNS = "http://www.w3.org/1999/xhtml";
  const makeElement = (tag: string, namespaceURI: string) => {
    const attrs = new Map<string, string>();
    const children: any[] = [];
    return {
      localName: tag,
      namespaceURI,
      children,
      setAttribute(name: string, value: string) { attrs.set(name, value); },
      getAttribute(name: string) { return attrs.get(name) ?? null; },
      hasAttribute(name: string) { return attrs.has(name); },
      append(child: any) { children.push(child); },
      get textContent() { return children.map((child) => child.textContent).join(""); },
    };
  };
  const priorDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createTextNode(text: string) { return { textContent: text, nodeType: 3 }; },
    createElement(tag: string) { return makeElement(tag, htmlNS); },
    createElementNS(namespace: string, tag: string) { return makeElement(tag, namespace); },
  };
  try {
    const target: any = { children: [], replaceChildren(...children: any[]) { this.children = children; } };
    buildNodes(nodes, target);
    const tree = walk(target.children[0]);
    assertEquals(target.children[0].namespaceURI, htmlNS);
    assert(tree.filter((node) => node.namespaceURI !== undefined).filter((node) => node.localName === "svg" || node.namespaceURI === svgNS).every((node) => node.namespaceURI === svgNS));
    assertEquals(tree.some((node) => node.localName === "script"), false);
    assertStringIncludes(target.children[0].textContent, "<script>caption</script>");
    // A source-defined zone colour reaches the built SVG as its own paint.
    assertEquals(tree.filter((node) => node.localName === "path" && node.getAttribute("fill") === "#8a2be2").length, 1);
  } finally {
    if (priorDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = priorDocument;
  }
});
