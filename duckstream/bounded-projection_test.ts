import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { projectionStep } from "./bounded-projection.ts";

Deno.test("SQL projection pages retain exact retry cursor across byte boundaries and sinks", async () => {
  const rows = Array.from(
    { length: 5 },
    (_, i) => ({
      sequence: i + 1,
      value: JSON.stringify({ id: String(i), name: "a".repeat(100000) }),
    }),
  );
  const host = {
    query: (sql: string) => {
      const after = Number(sql.match(/sequence>(\d+)/)![1]);
      return Promise.resolve(
        sql.includes("result_first")
          ? rows.filter((row) => row.sequence > after)
          : [],
      );
    },
  };
  let checkpoint: unknown = null;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const step = await projectionStep(host, ["first", "empty"], checkpoint);
    assertEquals(
      await projectionStep(
        host,
        ["first", "empty"],
        structuredClone(checkpoint),
      ),
      step,
    );
    const output = Object.values(step.writes).flat();
    assertEquals(
      new TextEncoder().encode(JSON.stringify(output)).length <= 256 * 1024,
      true,
    );
    ids.push(...output.map((row) => String(row.id)));
    checkpoint = structuredClone(step.checkpoint);
    if (step.done) break;
  }
  assertEquals(ids, ["0", "1", "2", "3", "4"]);
  assertEquals(checkpoint, { sink: 2, after: 0 });
});

Deno.test("SQL projection refuses unsafe cursors, malformed rows and oversized publications", async () => {
  const host = (rows: Record<string, unknown>[]) => ({
    query: () => Promise.resolve(rows),
  });
  for (
    const checkpoint of [{ sink: -1, after: 0 }, { sink: 0, after: NaN }, {
      sink: 3,
      after: 0,
    }, { sink: 0, after: 2 ** 53 }]
  ) {
    await assertRejects(
      () => projectionStep(host([]), ["rows"], checkpoint),
      Error,
      "invalid projection checkpoint",
    );
  }
  for (
    const rows of [[{ sequence: 1, value: "{}" }], [{
      sequence: 2 ** 53,
      value: "{}",
    }], [{ sequence: 1, value: '{"id":"a"}' }, {
      sequence: 1,
      value: '{"id":"b"}',
    }]]
  ) {
    await assertRejects(() => projectionStep(host(rows), ["rows"], null));
  }
  await assertRejects(
    () =>
      projectionStep(
        host([{
          sequence: 1,
          value: JSON.stringify({ id: "a", text: "é".repeat(150000) }),
        }]),
        ["rows"],
        null,
      ),
    Error,
    "exceeds publication page",
  );
});
