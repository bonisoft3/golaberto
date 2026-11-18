import { DuckDBInstance } from "npm:@duckdb/node-api@1.5.6-r.1";
import type { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { assertEquals } from "jsr:@std/assert@1.0.11";
import * as cards from "../computations/cards.js";
import * as players from "../computations/player_stats.js";
import { projectionStep } from "./bounded-projection.ts";

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: unknown) =>
  value === null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
const sorted = (rows: Record<string, unknown>[]) =>
  rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])),
    )
  ).sort();

export async function projectionParity(
  pg: PGlite,
  call: string,
  schema: Record<string, string>,
) {
  const program = call === "refresh_game_cards" ? cards : players;
  const descriptor = JSON.parse(
    await Deno.readTextFile(
      new URL(
        call === "refresh_game_cards"
          ? "cards.risingwave.json"
          : "player_stats.risingwave.json",
        import.meta.url,
      ),
    ),
  );
  const db = await DuckDBInstance.create(":memory:", {
    memory_limit: "32MB",
    threads: "1",
  });
  const conn = await db.connect();
  try {
    for (const table of program.reads) {
      await conn.run(`CREATE TABLE ${quote(table)} (${schema[table]})`);
      const fields = schema[table].split(", ").map((field) =>
        field.split(" ")[0]
      );
      const rows = (await pg.query<Record<string, string | null>>(
        `SELECT ${
          fields.map((field) => `${quote(field)}::text AS ${quote(field)}`)
            .join(",")
        } FROM ${quote(table)}`,
      )).rows;
      for (let i = 0; i < rows.length; i += 128) {
        await conn.run(
          `INSERT INTO ${quote(table)} VALUES ${
            rows.slice(i, i + 128).map((row) =>
              "(" + fields.map((field) => literal(row[field])).join(",") + ")"
            ).join(",")
          }`,
        );
      }
    }
    await conn.run("CREATE SCHEMA duckstream_private");
    const inputs: Record<string, Record<string, unknown>[]> = {};
    for (const [sink, sql] of Object.entries(program.queries)) {
      await conn.run("SET memory_limit='256MB'");
      inputs[sink] = (await conn.runAndReadAll(sql)).getRowObjectsJson();
      await conn.run(`CREATE VIEW result_${sink} AS ${sql}`);
      const partitioned = (await conn.runAndReadAll(
        descriptor.incremental.outputs[sink].partitionQuery,
      )).getRowObjectsJson();
      const partitionField = sink === "game_card"
        ? "phase_id"
        : sink === "team_game"
        ? "phase_key"
        : "championship_id";
      assertEquals(
        sorted(partitioned),
        sorted(
          inputs[sink].map((row) => ({
            __partition: String(row[partitionField]),
            ...row,
          })),
        ),
        `${sink} native partition`,
      );
      await conn.run("SET memory_limit='32MB'");
      const physical = (program.queryStages as Record<
        string,
        { sql: string; stages: { name: string; sql: string }[] }
      >)[sink];
      for (const stage of physical.stages) {
        await conn.run(`CREATE TABLE ${quote(stage.name)} AS ${stage.sql}`);
      }
      assertEquals(
        sorted((await conn.runAndReadAll(physical.sql)).getRowObjectsJson()),
        sorted(inputs[sink]),
        `${sink} physical parity`,
      );

      const fields = Object.keys(inputs[sink][0] ?? {}).filter((field) =>
        !["phase_key", "category_key", "category_id", "fixture_available"].includes(field)
      );
      if (fields.length) {
        const actual = inputs[sink].map((row) =>
          Object.fromEntries(fields.map((field) => [field, row[field]]))
        );
        const projection = fields.map((field) =>
          field === "kickoff"
            ? `to_char(kickoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS kickoff`
            : field === "day"
            ? "day::text AS day"
            : quote(field)
        );
        const expected = (await pg.query<{ row: Record<string, unknown> }>(
          `SELECT row_to_json(r) AS row FROM (SELECT ${
            projection.join(",")
          } FROM ${quote(sink)}) r`,
        )).rows.map((row) => row.row);
        assertEquals(
          sorted(actual),
          sorted(expected),
          `${sink} existing PostgreSQL projection parity`,
        );
      } else {assertEquals(
          (await pg.query(`SELECT id FROM ${quote(sink)}`)).rows,
          [],
        );}
      if (sink === "team_game") {
        const expected = (await pg.query<Record<string, unknown>>(
          `SELECT tg.id,p.id AS phase_key,c.category_id,coalesce(c.category_id,'professional') AS category_key, g.played OR coalesce(g.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded') AS fixture_available FROM team_game tg JOIN game g ON g.id=tg.game_id JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id`,
        )).rows;
        assertEquals(
          sorted(
            inputs[sink].map((
              { id, phase_key, category_id, category_key, fixture_available },
            ) => ({ id, phase_key, category_id, category_key, fixture_available })),
          ),
          sorted(expected),
        );
      }
      await conn.run(
        `CREATE TABLE duckstream_private.result_${sink} AS SELECT row_number() OVER () AS sequence,to_json(r)::VARCHAR AS value FROM (${physical.sql}) r`,
      );
      for (const stage of physical.stages) {
        await conn.run(`DROP TABLE ${quote(stage.name)}`);
      }
    }
    const host = {
      query: async (sql: string) =>
        (await conn.runAndReadAll(sql)).getRowObjectsJson(),
    };
    const sinks = Object.keys(program.queries),
      emitted: Record<string, Record<string, unknown>[]> = Object.fromEntries(
        sinks.map((sink) => [sink, []]),
      );
    let checkpoint: unknown = null;
    for (let i = 0; i < 10000; i++) {
      const step = await projectionStep(
        host,
        sinks,
        structuredClone(checkpoint),
      );
      assertEquals(
        await projectionStep(host, sinks, structuredClone(checkpoint)),
        step,
        "retry must reproduce the same page",
      );
      for (const [sink, rows] of Object.entries(step.writes)) {
        emitted[sink].push(...rows);
      }
      checkpoint = structuredClone(step.checkpoint);
      if (step.done) {
        assertEquals(program.plan(inputs, 0, []), []);
        for (const sink of sinks) {
          assertEquals(
            sorted(emitted[sink]),
            sorted(
              (program.finish(inputs, []) as Record<
                string,
                Record<string, unknown>[]
              >)[sink],
            ),
          );
        }
        return;
      }
    }
    throw new Error("projection paging did not finish");
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}
