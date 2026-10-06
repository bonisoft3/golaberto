import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import render from "../shell/renderers/team-chart.js";
import { buildNodes } from "../../../plugins/omnishell/interpreter/render.js";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

const SEP = "\u001f";
const input = (chart: unknown, title = "Rating history", locale = "en-GB") =>
  `${JSON.stringify(chart)}${SEP}${title}${SEP}${locale}`;

Deno.test("team chart handles empty, malformed, and invalid series as titled empty states", async () => {
  const source = await Deno.readTextFile(
    new URL("../shell/renderers/team-chart.js", import.meta.url),
  );
  const caged = await evaluateRole(source, "renderer");
  for (
    const value of [
      input({ kind: "line", series: [] }),
      input({
        kind: "line",
        series: [{ label: "A", points: [{ x: NaN, y: 2 }] }],
      }),
      `${"{"}${SEP}Rating history${SEP}en-GB`,
      input({ kind: "pie", series: [] }),
    ]
  ) {
    const nodes = render(value);
    assertEquals(caged(value), nodes);
    assertEquals(nodes[0].tag, "div");
    assertEquals((nodes[0] as any).attrs.class, "team-chart team-chart--empty");
    assertEquals((nodes[0] as any).children[0].children, ["Rating history"]);
  }
});

Deno.test("one point remains visible and gets localized accessible labels and a safe game link", async () => {
  const chart = {
    kind: "line",
    series: [{
      label: "Rating",
      points: [{ x: 2026, y: 7.25, label: "2026", href: "/jogo/123" }],
    }],
  };
  const nodes = render(input(chart, "Histórico de avaliação", "pt-BR"));
  const svg = nodes[0].children[1];
  assertEquals(nodes[0].tag, "figure");
  assertEquals(svg.tag, "svg");
  assertEquals(svg.attrs["aria-label"], "Histórico de avaliação");
  assertEquals(svg.children.filter((node: any) => node.tag === "text").slice(-2)
    .map((node: any) => node.children), [["2026"], ["2026"]],
    "one observation labels its actual date instead of padded numeric bounds");
  const group = svg.children.find((node: any) => node.tag === "g");
  assertEquals(
    group.children.length,
    1,
    "one point does not rely on a line segment",
  );
  const link = group.children[0];
  assertEquals(link.tag, "a");
  assertEquals(link.attrs.href, "/jogo/123");
  assertEquals(link.attrs.tabindex, 0);
  assertEquals(link.attrs["aria-label"], "Rating: 2026, 7,25");
  assertEquals(link.children[0].attrs.title, "Rating: 2026, 7,25");

  const caged = await evaluateRole(
    await Deno.readTextFile(
      new URL("../shell/renderers/team-chart.js", import.meta.url),
    ),
    "renderer",
  );
  assertEquals(caged(input(chart, "Histórico de avaliação", "pt-BR")), nodes);
});

Deno.test("multi-series lines and odds bars keep labels as text and reject non-local point links", () => {
  const rawLabel = `<script>alert(1)</script>`;
  const lines = render(input({
    kind: "line",
    series: [
      {
        label: rawLabel,
        points: [{ x: 1, y: 4, href: "https://outside.example" }, {
          x: 2,
          y: 8,
          href: "javascript:alert(1)",
        }],
      },
      { label: "Second", points: [{ x: 1, y: 3 }, { x: 2, y: 5 }] },
    ],
  }));
  const svg = lines[0].children[1];
  const groups = svg.children.filter((node: any) => node.tag === "g");
  assertEquals(groups.length, 2);
  assertStringIncludes(groups[0].attrs.class, "team-chart__series--1");
  assert(groups[0].children.some((node: any) => node.tag === "polyline"));
  assert(
    groups[0].children.every((node: any) => node.tag !== "a"),
    "external and executable links are omitted",
  );
  assertEquals(groups[0].attrs["aria-label"], rawLabel);
  assertEquals(groups[0].children[2].attrs.title, `${rawLabel}: 2, 8`);
  const bars = render(input({
    kind: "bars",
    yMin: 0,
    yMax: 10,
    series: [{ label: "Odds", points: [{ x: 1, y: 4 }, { x: 2, y: 9 }] }],
  }));
  const barGroup = bars[0].children[1].children.find((node: any) =>
    node.tag === "g"
  );
  assertEquals(barGroup.children.map((node: any) => node.tag), [
    "rect",
    "rect",
  ]);
  assertEquals(
    bars[0].children[1].children.filter((node: any) => node.tag === "text")
      .length,
    7,
    "y tick values and both x endpoints are visibly labeled",
  );
});

Deno.test("team chart nodes build recursively in the SVG namespace", () => {
  const svgNS = "http://www.w3.org/2000/svg";
  const htmlNS = "http://www.w3.org/1999/xhtml";
  const makeElement = (tag: string, namespaceURI: string) => {
    const attrs = new Map<string, string>();
    const children: any[] = [];
    return {
      localName: tag,
      namespaceURI,
      children,
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      getAttribute(name: string) {
        return attrs.get(name) ?? null;
      },
      hasAttribute(name: string) {
        return attrs.has(name);
      },
      append(child: any) {
        children.push(child);
      },
      get textContent() {
        return children.map((child) => child.textContent).join("");
      },
    };
  };
  const priorDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createTextNode(text: string) {
      return { textContent: text, nodeType: 3 };
    },
    createElement(tag: string) {
      return makeElement(tag, htmlNS);
    },
    createElementNS(namespace: string, tag: string) {
      return makeElement(tag, namespace);
    },
  };
  try {
    const malicious = "<script>alert(1)</script>";
    const nodes = render(input({
      kind: "line",
      series: [{ label: malicious, points: [{ x: 1, y: 2, href: "/jogo/1" }] }],
    }, malicious));
    const target: any = {
      children: [],
      replaceChildren(...children: any[]) {
        this.children = children;
      },
    };
    buildNodes(nodes, target);
    const svg = target.children[0].children[1];
    const walk = (
      node: any,
    ): any[] => [node, ...(node.children ?? []).flatMap(walk)];
    const tree = walk(svg);
    assertEquals(
      tree.filter((node) => node.namespaceURI !== undefined).every((node) =>
        node.namespaceURI === svgNS
      ),
      true,
    );
    assertEquals(target.children[0].namespaceURI, htmlNS);
    assertEquals(tree.some((node) => node.localName === "script"), false);
    assertStringIncludes(svg.textContent, malicious);

    const refuses = (node: any) => {
      const badTarget: any = { replaceChildren() {} };
      try {
        buildNodes([node], badTarget);
        return false;
      } catch {
        return true;
      }
    };
    for (const tag of ["script", "foreignObject", "image", "use", "animate"]) {
      assertEquals(
        refuses({ tag: "svg", children: [{ tag }] }),
        true,
        `${tag} is excluded`,
      );
    }
    for (const name of ["onclick", "style", "fill", "data-live"]) {
      assertEquals(
        refuses({ tag: "svg", attrs: { [name]: "forged" } }),
        true,
        `${name} is excluded`,
      );
    }
    const hostile: any = {
      replaceChildren(...children: any[]) {
        this.children = children;
      },
    };
    buildNodes([{
      tag: "svg",
      children: [{
        tag: "a",
        attrs: { href: "javascript:alert(1)" },
        children: ["point"],
      }],
    }], hostile);
    assertEquals(hostile.children[0].children[0].getAttribute("href"), null);
    assertEquals(hostile.children[0].children[0].textContent, "point");
  } finally {
    if (priorDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = priorDocument;
  }
});

Deno.test("campaign metric changes project the same observations without a source mutation", () => {
  const chart = {kind:"line",series:[{label:"Team",points:[{x:1,y:3,position:1,label:"2026-01-01",href:"/jogo/1"}]}]};
  const value = input(chart,"Campaign","en-GB") + "\u001f\u001fposition";
  const svg = render(value)[0].children[1];
  const link = svg.children.find((node: any) => node.tag === "g").children[0];
  assertEquals(link.attrs["aria-label"], "Team: 2026-01-01, 1");
});
