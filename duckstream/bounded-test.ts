import { assert } from "jsr:@std/assert@1.0.8";
import { duckdb, readerOf } from "@mecha/compute/main.ts";
import { normalizeSelect, projectOutput } from "@mecha/compute/wasm-select.ts";
import { runWasm } from "@mecha/compute/wasi.ts";
import type { Host, Row, Step } from "./bounded-ratings.ts";

const wasm = await WebAssembly.compile(
  await Deno.readFile(
    new URL("../computations/golaberto-odds.wasm", import.meta.url),
  ),
);
export const wasmJob = (
  _name: string,
  input: unknown,
  select?: readonly string[],
): Promise<unknown> =>
  Promise.resolve(
    JSON.parse(
      projectOutput(
        new TextDecoder().decode(
          runWasm(
            wasm,
            new TextEncoder().encode(JSON.stringify(input)),
            "golaberto-odds",
          ),
        ),
        normalizeSelect(select),
      ),
    ),
  );

export async function legacy(
  program: { plan: CallableFunction; finish: CallableFunction },
  inputs: Record<string, Row[]>,
  seed = 17,
) {
  const outputs: unknown[] = [];
  for (;;) {
    const jobs = program.plan(inputs, seed, outputs);
    if (jobs.length === outputs.length) return program.finish(inputs, outputs);
    for (let i = outputs.length; i < jobs.length; i++) {
      outputs.push(await wasmJob(jobs[i].wasm, jobs[i].input, jobs[i].select));
    }
  }
}
export const sorted = (outputs: Record<string, Row[]>) =>
  Object.fromEntries(
    Object.entries(outputs).map((
      [name, rows],
    ) => [
      name,
      [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ]),
  );

export async function runBounded(
  driver: (db: Host, checkpoint: unknown) => Promise<Step>,
  inputs: Record<string, Row[]>,
  sinks: string[],
  seed = 17,
  concurrency = 1,
  maxJobs = concurrency === 1 ? 1 : 64,
) {
  const database = await duckdb();
  const con = await database.connect();
  const reader = readerOf(con);
  let jobs = 0;
  let dbQueue = Promise.resolve();
  const withDb = <T>(work: () => Promise<T>): Promise<T> => {
    const run = dbQueue.then(work, work);
    dbQueue = run.then(() => {}, () => {});
    return run;
  };
  const host: Host = {
    seed,
    concurrency,
    maxJobs,
    query: (sql) =>
      withDb(async () => {
        const rows = await reader.query(sql);
        assert(
          new TextEncoder().encode(JSON.stringify(rows)).length <=
            8 * 1024 * 1024,
        );
        return rows;
      }),
    wasm: async (name, input, select) => {
      jobs++;
      return await wasmJob(name, input, select);
    },
    wasmFromQuery: async (name, input, query, select) => {
      const body = structuredClone(input) as Record<string, unknown>;
      let target = body;
      for (const part of query.path.slice(0, -1)) {
        target = target[part] as Record<string, unknown>;
      }
      const rows = await withDb(() =>
        reader.query(
          `SELECT * FROM (${query.sql}) ORDER BY "${query.orderBy}"`,
        )
      );
      target[query.path.at(-1)!] = rows.map((row) => {
        const value = { ...row };
        delete value[query.orderBy];
        return value;
      });
      jobs++;
      return await wasmJob(name, body, select);
    },
  };
  try {
    await con.run("CREATE SCHEMA duckstream_private");
    for (const [name, rows] of Object.entries(inputs)) {
      await con.run(
        `CREATE TABLE duckstream_private.result_${name}(sequence BIGINT,value VARCHAR)`,
      );
      for (const [i, row] of rows.entries()) {
        await con.run(
          `INSERT INTO duckstream_private.result_${name} VALUES (?,?)`,
          [i, JSON.stringify(row)],
        );
      }
    }
    await con.run(
      "CREATE TABLE outputs(sink VARCHAR,id VARCHAR,value VARCHAR,PRIMARY KEY(sink,id))",
    );
    let checkpoint: unknown = null;
    for (let iteration = 0; iteration < 1000; iteration++) {
      const before = jobs;
      const result = await driver(host, checkpoint);
      assert(
        jobs - before <= maxJobs,
        `a bounded step runs at most ${maxJobs} WASM job(s)`,
      );
      await con.run("BEGIN");
      for (const sql of result.statements ?? []) await con.run(sql);
      for (const [sink, rows] of Object.entries(result.writes)) {
        assert(sinks.includes(sink));
        for (const row of rows) {
          await con.run("INSERT OR REPLACE INTO outputs VALUES (?,?,?)", [
            sink,
            String(row.id),
            JSON.stringify(row),
          ]);
        }
      }
      await con.run("COMMIT");
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
      if (result.done) {
        const out: Record<string, Row[]> = Object.fromEntries(
          sinks.map((sink) => [sink, []]),
        );
        for (
          const row of await reader.query(
            "SELECT sink,value FROM outputs ORDER BY id",
          )
        ) out[String(row.sink)].push(JSON.parse(String(row.value)));
        return { out: sorted(out), steps: iteration + 1, jobs };
      }
    }
    throw new Error("bounded computation did not complete");
  } finally {
    con.closeSync();
    database.closeSync();
  }
}
