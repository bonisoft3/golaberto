import { assertEquals } from "jsr:@std/assert@1";
import render from "../shell/renderers/weekday.js";
import { evaluateRole } from "./platform.ts";

Deno.test("home civil dates retain weekdays across calendar boundaries in the renderer cage", async () => {
  const source = await Deno.readTextFile(new URL("../shell/renderers/weekday.js", import.meta.url));
  const caged = await evaluateRole(source, "renderer");
  const names = "Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday";
  for (const [day, expected] of [
    ["2026-10-03", "Saturday, "], ["2026-10-04", "Sunday, "],
    ["2026-10-05", "Monday, "], ["2026-10-06", "Tuesday, "],
    ["2026-10-07", "Wednesday, "], ["2026-10-08", "Thursday, "],
    ["2026-10-09", "Friday, "], ["2024-02-29", "Thursday, "],
    ["2000-02-29", "Tuesday, "], ["1900-03-01", "Thursday, "],
    ["2026-12-31", "Thursday, "], ["2027-01-01", "Friday, "],
  ]) {
    assertEquals(render(day+"|"+names), [expected]);
    assertEquals(caged(day+"|"+names), [expected]);
  }
  assertEquals(caged(null), []);
});

Deno.test("home weekday names follow every supported language", async () => {
  for (const [locale, weekday] of [["en-US","Saturday"],["pt-BR","sábado"],["es-AR","sábado"],
    ["it-IT","sabato"],["de-DE","Samstag"],["fr-FR","samedi"]]) {
    const messages = JSON.parse(await Deno.readTextFile(new URL(`../messages/${locale}.json`,import.meta.url)));
    assertEquals(render("2026-10-03|"+messages.home_weekdays), [weekday+", "]);
  }
});
