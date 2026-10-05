import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import render from "../shell/renderers/zone-color.js";
import positions from "../shell/renderers/zone-positions.js";
import { buildNodes } from "../../../plugins/omnishell/interpreter/render.js";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

Deno.test("zone color renderer preserves a custom lowercase hex swatch", async () => {
  const nodes = render("#8a2be2") as any[];
  assertEquals(nodes.length, 1);
  assertEquals(nodes[0].tag, "svg");
  assertEquals(nodes[0].attrs["aria-hidden"], "true");
  assertEquals(nodes[0].children[0].tag, "rect");
  assertEquals(nodes[0].children[0].attrs.fill, "#8a2be2");

  const source = await Deno.readTextFile(new URL("../shell/renderers/zone-color.js", import.meta.url));
  const caged = await evaluateRole(source, "renderer");
  assertEquals(caged("#8a2be2"), nodes);
});

Deno.test("zone color renderer refuses malformed, uppercase, and injected colors", () => {
  for (const value of ["", "#8A2BE2", "red", "#8a2be", "#8a2be2 onload=alert(1)", "#8a2be2\u001f<script>"]) {
    assertEquals(render(value), []);
  }
});

Deno.test("zone color output builds through the safe SVG schema", () => {
  const svgNS = "http://www.w3.org/2000/svg";
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
    };
  };
  const priorDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createTextNode(text: string) { return { textContent: text, nodeType: 3 }; },
    createElement(tag: string) { return makeElement(tag, "http://www.w3.org/1999/xhtml"); },
    createElementNS(namespace: string, tag: string) { return makeElement(tag, namespace); },
  };
  try {
    const target: any = { children: [], replaceChildren(...children: any[]) { this.children = children; } };
    buildNodes(render("#8a2be2"), target);
    const svg = target.children[0];
    assertEquals(svg.namespaceURI, svgNS);
    assertEquals(svg.children[0].getAttribute("fill"), "#8a2be2");
    assertEquals(svg.getAttribute("aria-hidden"), "true");
    for (const fill of ["url(https://example.com/paint.svg)", "var(--external)", "red", "#123456;stroke:red"]) {
      assertThrows(()=>buildNodes([{tag:"svg",children:[{tag:"rect",attrs:{fill}}]}],target),Error,"six-digit hex");
    }
  } finally {
    (globalThis as any).document = priorDocument;
  }
});

Deno.test("zone membership labels retain gaps and compact consecutive positions",()=>{
 assertEquals(positions("[1,3,4,7]|1|7"),["1, 3–4, 7"]);
 assertEquals(positions("|1|4"),["1–4"]);
 assertEquals(positions("[1,\"<script>\"]|1|3"),[]);
});
