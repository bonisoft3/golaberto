import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { evaluateRole } from "omnishell/interpreter/jessie.js";

Deno.test("archive calendar weeks retain civil dates across leap years and ISO year boundaries", async () => {
  const handler = await evaluateRole(
    await Deno.readTextFile(
      new URL("../shell/handlers/archive-week.js", import.meta.url),
    ),
    "handler",
  );
  for (
    const [value, expected] of [
      ["2026-10-05", "2026-10-05"],
      ["2026-10-07", "2026-10-05"],
      ["2026-10-11", "2026-10-05"],
      ["2027-01-01", "2026-12-28"],
      ["2000-02-29", "2000-02-28"],
      ["1900-03-01", "1900-02-26"],
      ["2015-10-18", "2015-10-12"],
      ["0001-01-01", "0001-01-01"],
      ["2000-03-01", "2000-02-28"],
      ["2100-03-01", "2100-03-01"],
      ["9999-12-31", "9999-12-27"],
      ["", "*"],
    ]
  ) assertEquals(handler({}, { value }), expected);
  for (
    const value of [
      "2026-02-29",
      "1900-02-29",
      "2026-13-01",
      "0000-01-01",
      "2026-00-01",
      "2026-10-00",
      "2026-10-07T00:00:00Z",
    ]
  ) {
    assertThrows(() => handler({}, { value }), Error, "Invalid archive date");
  }
});

Deno.test("archive round filters preserve all rounds when cleared and reject invalid integer queries", async () => {
  const handler = await evaluateRole(
    await Deno.readTextFile(
      new URL("../shell/handlers/archive-round.js", import.meta.url),
    ),
    "handler",
  );
  assertEquals(handler({}, { value: "" }), "*");
  assertEquals(handler({}, { value: "003" }), "3");
  assertEquals(handler({}, { value: "2147483647" }), "2147483647");
  for (const value of ["0", "-1", "1.5", "2147483648", "NaN", "*"]) {
    assertThrows(() => handler({}, { value }), Error, "Invalid archive round");
  }
});
