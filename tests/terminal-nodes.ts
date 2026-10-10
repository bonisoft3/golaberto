import { parseHTML } from "npm:linkedom@0.18.4";
import { buildNodes } from "../../../plugins/omnishell/interpreter/render.js";

// Renderer output through the terminal's builder: its tag and attribute
// allowlist is what a page enforces, and a node shape alone does not.
export function built<T>(nodes: T): T {
  const { document } = parseHTML("<html><body><div></div></body></html>") as unknown as {
    document: { querySelector(selector: string): unknown };
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  const prior = scope.document;
  scope.document = document;
  try {
    buildNodes(nodes, document.querySelector("div"));
  } finally {
    scope.document = prior;
  }
  return nodes;
}
