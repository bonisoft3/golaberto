import { assertEquals } from "jsr:@std/assert@1.0.8";
import pg from "npm:pg@8.16.3";
import { pgTest, postgres } from "@bonisoft3/mecha/services/compute/pg-test.ts";
import type { IncrementalProgram } from "@bonisoft3/mecha/services/compute/native-sources.ts";
import { TABLES, uid, World } from "../computations/tests/world.ts";

pgTest(
  "PostgreSQL native projections preserve DuckDB calendar, UUID, f32 and microsecond carriers",
  async () => {
    await using database = await postgres();
    const client = new pg.Client(database.url);
    await client.connect();
    try {
      const world = new World();
      const times = [
        "2024-02-29T23:59:59.500001Z",
        "2024-02-29T23:59:59.499999Z",
        "1969-12-31T23:59:59.500000Z",
        "1970-01-01T00:00:00.500000Z",
        "1969-12-31T23:59:58.500000Z",
        "2028-02-29T23:59:59.500000Z",
        "2026-05-24T03:00:00.000001+03:00",
      ];
      times.forEach((kickoff, i) => world.rows.game[i].kickoff = kickoff);
      world.rows.team_rating = world.teams.map((team_id, i) => ({
        id: uid(12, i),
        team_id,
        measure_date: "2026-05-24",
        offense: "1.23456789",
        defense: "0.987654321",
        rating: "50",
      }));
      const lake = await world.lake();
      for (const [table, columns] of Object.entries(TABLES)) {
        await client.query(`CREATE TABLE "${table}" (${columns})`);
        const names = columns.split(", ").map((column) => column.split(" ")[0]);
        for (
          const row of table === "standing"
            ? world.standing()
            : world.rows[table]
        ) {
          await client.query(
            `INSERT INTO "${table}" VALUES (${
              names.map((_, i) => "$" + (i + 1)).join(",")
            })`,
            names.map((name) => row[name] ?? null),
          );
        }
      }
      for (const name of ["ratings", "chances"]) {
        const descriptor: IncrementalProgram = JSON.parse(
          await Deno.readTextFile(
            new URL(`${name}.feldera.json`, import.meta.url),
          ),
        );
        for (const [source, input] of Object.entries(descriptor.inputs)) {
          const native = descriptor.incremental.inputs[source];
          const columns = input.fields.map((field) =>
            field.type === "TIMESTAMP"
              ? `to_char("${field.name}", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${field.name}"`
              : `"${field.name}"`
          ).join(",");
          const actual = (await client.query(
            `SELECT ${columns} FROM (SELECT ${native.projection} FROM "${native.table}") projected`,
          )).rows;
          const expected = await lake.query(input.query);
          const normalize = (rows: Record<string, unknown>[]) =>
            rows.map((row) => {
              for (const field of input.fields) {
                if (field.type === "BIGINT" && row[field.name] !== null) {
                  row[field.name] = Number(row[field.name]);
                }
              }
              return JSON.stringify(row);
            }).sort();
          assertEquals(
            normalize(actual),
            normalize(expected),
            name + "/" + source,
          );
        }
      }
    } finally {
      await client.end();
    }
  },
);

pgTest(
  "cards native bootstrap derives fixture availability with DuckDB parity",
  async () => {
    await using database = await postgres();
    const client = new pg.Client(database.url);
    await client.connect();
    try {
      const { duckdb, readerOf } = await import("@mecha/compute/main.ts");
      const con = await (await duckdb()).connect();
      const columns =
        `id text, phase_id text, "round" integer, day text, kickoff timestamptz,
        played boolean, home_id text, away_id text, home_score integer, away_score integer,
        home_aet integer, away_aet integer, home_pen integer, away_pen integer,
        stadium_id text, referee_id text, attendance integer, sync_status text`;
      await client.query(`CREATE TABLE game (${columns})`);
      await con.run(`CREATE TABLE game (${columns})`);
      for (
        const [i, status] of [
          null,
          "scheduled",
          "cancelled",
          "abandoned",
          "awarded",
        ].entries()
      ) {
        for (const played of [false, true]) {
          const id = `${i}-${played}`;
          await client.query(
            "INSERT INTO game(id,played,sync_status) VALUES($1,$2,$3)",
            [id, played, status],
          );
          await con.run(
            "INSERT INTO game(id,played,sync_status) VALUES(?,?,?)",
            [id, played, status],
          );
        }
      }
      const descriptor: IncrementalProgram = JSON.parse(
        await Deno.readTextFile(new URL("cards.feldera.json", import.meta.url)),
      );
      const native = descriptor.incremental.inputs.source_game;
      const actual = (await client.query(
        `SELECT id,fixture_available FROM (SELECT ${native.projection} FROM "${native.table}") projected ORDER BY id`,
      )).rows;
      const expected = await readerOf(con).query(
        `SELECT id,fixture_available FROM (${descriptor.inputs.source_game.query}) projected ORDER BY id`,
      );
      assertEquals(actual, expected);
      assertEquals(actual.map((row) => row.fixture_available), [
        true,
        true,
        true,
        true,
        false,
        true,
        false,
        true,
        false,
        true,
      ]);
    } finally {
      await client.end();
    }
  },
);
