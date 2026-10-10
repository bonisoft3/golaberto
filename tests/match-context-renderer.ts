import {
  assertEquals,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1.0.11";
import renderNodes from "../shell/renderers/match-context-map.js";
import { built } from "./terminal-nodes.ts";

const render = (value: string) => built(renderNodes(value));

const separator = "\u001f";
const labels = ["Distance", "Open map", "Location unavailable"];
const node = (parts: (string | number)[]) =>
  render([...parts, ...labels].join(separator))[0] as {
    attrs: Record<string, string>;
    children: Array<Record<string, unknown> | string>;
  };
const tags = (value: unknown): string[] => {
  if (value === null || typeof value !== "object") return [];
  const item = value as { tag?: string; children?: unknown[] };
  return [item.tag ?? "", ...(item.children ?? []).flatMap(tags)].filter(
    Boolean,
  );
};

Deno.test("match map keeps zero coordinates and links only validated numbers to OpenStreetMap", () => {
  const output = node([
    0,
    0,
    -22.9068,
    -43.1729,
    "Home <unsafe>",
    "Away & safe",
    5271.238,
  ]);
  assertEquals(output.attrs.class, "match-context-map");
  const distance = output.children[0] as {
    children: Array<string | { children: string[] }>;
  };
  assertEquals((distance.children[2] as { children: string[] }).children, [
    "5271.2 km",
  ]);
  const link = output.children[1] as {
    attrs: Record<string, string>;
    children: { attrs: Record<string, string> }[];
  };
  assertMatch(
    link.attrs.href,
    /^https:\/\/www\.openstreetmap\.org\/directions\?/,
  );
  assertEquals(link.attrs.target, "_blank");
  assertEquals(link.attrs.rel, "noopener noreferrer");
  assertEquals(link.attrs.href.includes("unsafe"), false);
  assertEquals(
    link.children[0].attrs["aria-label"],
    "Open map: Home <unsafe> – Away & safe",
  );
  assertEquals(tags(output).includes("iframe"), false);
});

Deno.test("match map states missing coordinates and rejects corrupt coordinates or distance", () => {
  const missing = node([
    "",
    "",
    -22.9068,
    -43.1729,
    "Home",
    "Away",
    "",
  ]);
  assertEquals(missing.attrs.class, "match-context-location-empty");
  assertEquals(missing.children, ["Location unavailable"]);

  assertThrows(
    () => node([91, 0, -22.9068, -43.1729, "Home", "Away", 1]),
    Error,
    "Invalid match context map",
  );
  assertThrows(
    () => node([0, 0, -22.9068, -43.1729, "Home", "Away", -1]),
    Error,
    "Invalid match context map",
  );
  assertThrows(
    () => render("short payload"),
    Error,
    "Match context map labels are missing",
  );
});
