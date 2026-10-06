import { assertEquals } from "jsr:@std/assert@1";
import render from "../shell/renderers/home-date.js";
import { evaluateRole } from "../../../plugins/omnishell/interpreter/jessie.js";

Deno.test("home civil dates retain weekdays across calendar boundaries in the renderer cage", async () => {
  const source = await Deno.readTextFile(new URL("../shell/renderers/home-date.js", import.meta.url));
  const caged = await evaluateRole(source, "renderer");
  const names = "Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday";
  for (const [day, expected] of [
    ["2026-10-03", "Saturday, 03/10/2026"], ["2026-10-04", "Sunday, 04/10/2026"],
    ["2026-10-05", "Monday, 05/10/2026"], ["2026-10-06", "Tuesday, 06/10/2026"],
    ["2026-10-07", "Wednesday, 07/10/2026"], ["2026-10-08", "Thursday, 08/10/2026"],
    ["2026-10-09", "Friday, 09/10/2026"], ["2024-02-29", "Thursday, 29/02/2024"],
    ["2000-02-29", "Tuesday, 29/02/2000"], ["1900-03-01", "Thursday, 01/03/1900"],
    ["2026-12-31", "Thursday, 31/12/2026"], ["2027-01-01", "Friday, 01/01/2027"],
  ]) {
    assertEquals(render(day+"|"+names), [expected]);
    assertEquals(caged(day+"|"+names), [expected]);
  }
  assertEquals(caged(null), []);
});

Deno.test("home weekday names follow every supported language", async () => {
  for (const [locale, weekday] of [["en-GB","Saturday"],["pt-BR","sábado"],["es-AR","sábado"],
    ["it-IT","sabato"],["de-DE","Samstag"],["fr-FR","samedi"]]) {
    const messages = JSON.parse(await Deno.readTextFile(new URL(`../messages/${locale}.json`,import.meta.url)));
    assertEquals(render("2026-10-03|"+messages.home_weekdays), [weekday+", 03/10/2026"]);
  }
});
