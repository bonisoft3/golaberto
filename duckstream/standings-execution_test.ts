// Standings through mecha's compute worker and paged execution, which this
// file alone loads: the pure standings tests run without them.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { DuckDBInstance } from "npm:@duckdb/node-api@1.5.6-r.1";
import { Cage, compile } from "@bonisoft3/mecha/services/compute/workers.ts";
import type {} from "@bonisoft3/mecha/services/compute/cage.ts";
import { fixture as wasmFixture, asyncHost } from "@bonisoft3/mecha/packages/mecha-edge/test/duckdb-fixture.ts";
import { PagedExecution } from "@bonisoft3/mecha/packages/compute-snapshot/src/execution.ts";
import {
  fixture,
  insert,
  schema,
} from "../tests/portable-projections-fixture.ts";
import * as program from "../computations/standings.js";
import { step } from "./bounded-standings.ts";
import { canonical, literal, quote } from "./standings-test.ts";

Deno.test("compiled standings preserve PostgreSQL ladders, forms, zones and bounded replay", async () => {
  const pg = await fixture();
  const db = await DuckDBInstance.create(":memory:", {
    memory_limit: "32MB",
    threads: "1",
  });
  const conn = await db.connect();
  try {
    await insert(pg, "championship", [{
      id: "c",
      point_win: 3,
      point_draw: 1,
      point_loss: -1,
    }]);
    await insert(pg, "team", [{ id: "a", name: "Á" }, { id: "b", name: "Z" }, {
      id: "c",
      name: "😀",
    }, { id: "d", name: "\uE000" }]);
    const sorts = [
      "pt,w,gd,gf,name",
      "head,pt,name",
      "g_average,gp,g_aet,g_away,bias,name",
      "name",
      "bias,head",
      "pt,name",
    ];
    for (let i = 0; i < sorts.length; i++) {
      const phase = "p" + i, group = "g" + i;
      await insert(pg, "phase", [{
        id: phase,
        championship_id: "c",
        sort: sorts[i],
        bonus_points: 1,
        bonus_points_threshold: 3,
      }]);
      await insert(pg, "stage_group", [{ id: group, phase_id: phase }, {
        id: group + "empty",
        phase_id: phase,
      }]);
      await insert(
        pg,
        "team_group",
        ["a", "b", "c", "d"].slice(0, i === 5 ? 2 : 4).map((
          team_id,
          index,
        ) => ({
          id: group + team_id,
          group_id: group,
          team_id,
          add_sub: index === 3 ? -2 : 0,
          bias: index - 2,
        })),
      );
      await insert(pg, "zone", [
        {
          id: group + "z1",
          group_id: group,
          first: 1,
          last: 4,
          positions: "",
          color: "broad",
        },
        {
          id: group + "z2",
          group_id: group,
          first: 2,
          last: 2,
          positions: "1,3",
          color: "explicit",
        },
        {
          id: group + "z0",
          group_id: group,
          first: 2,
          last: 2,
          positions: "1,3",
          color: "id-tie",
        },
      ]);
      await insert(
        pg,
        "game",
        Array.from({ length: 9 }, (_, j) => ({
          id: group + "game" + j,
          phase_id: phase,
          day: j === 8 ? null : "2026-01-01",
          kickoff: j % 3 === 0
            ? null
            : `2026-01-01T${String(j).padStart(2, "0")}:00:00+02:00`,
          home_id: j % 2 ? "b" : "a",
          away_id: j % 2 ? "c" : "b",
          home_score: j % 4,
          away_score: j % 3,
          home_aet: j % 2,
          away_aet: 0,
          home_pen: 3,
          away_pen: 2,
          played: j !== 7,
        })),
      );
    }
    await insert(pg, "phase", [{
      id: "decimal",
      championship_id: "c",
      sort: "g_average,name",
    }]);
    await insert(pg, "stage_group", [{ id: "decimal", phase_id: "decimal" }]);
    await insert(pg, "team_group", [
      {
        id: "decimal-a",
        group_id: "decimal",
        team_id: "a",
        add_sub: 0,
        bias: 0,
      },
      {
        id: "decimal-b",
        group_id: "decimal",
        team_id: "b",
        add_sub: 0,
        bias: 0,
      },
    ]);
    await insert(pg, "game", [
      {
        id: "round-below-half",
        phase_id: "decimal",
        day: "2026-01-01",
        played: true,
        home_id: "a",
        away_id: "c",
        home_score: 9999996,
        away_score: 1999999,
      },
      {
        id: "round-comparator",
        phase_id: "decimal",
        day: "2026-01-01",
        played: true,
        home_id: "b",
        away_id: "c",
        home_score: 5,
        away_score: 1,
      },
    ]);
    await pg.exec("SELECT refresh_standings()");
    for (const table of program.reads) {
      await conn.run(
        `CREATE TABLE ${quote(table)} (${
          schema[table as keyof typeof schema]
        })`,
      );
      const fields = schema[table as keyof typeof schema].split(", ").map(
        (field) => field.split(" ")[0],
      );
      const rows =
        (await pg.query<Record<string, unknown>>(`SELECT ${
          fields.map((field) => `${quote(field)}::text AS ${quote(field)}`)
            .join(",")
        } FROM ${quote(table)}`)).rows;
      if (rows.length) {
        await conn.run(`INSERT INTO ${quote(table)} VALUES ${
          rows.map((row) =>
            "(" + fields.map((field) => literal(row[field])).join(",") +
            ")"
          ).join(",")
        }`);
      }
    }
    await conn.run("CREATE SCHEMA duckstream_private");
    const inputs: Record<string, any[]> = {};
    for (const [name, sql] of Object.entries(program.queries)) {
      inputs[name] = (await conn.runAndReadAll(sql)).getRowObjectsJson();
      const physical =
        program.queryStages[name as keyof typeof program.queryStages];
      for (const stage of physical.stages) {
        await conn.run(`CREATE TABLE ${quote(stage.name)} AS ${stage.sql}`);
      }
      const actual = (await conn.runAndReadAll(physical.sql))
        .getRowObjectsJson();
      assertEquals(
        canonical(actual),
        canonical(inputs[name]),
        name + " physical/logical parity",
      );
      await conn.run(
        `CREATE TABLE duckstream_private.result_${name} AS SELECT row_number() OVER ()::BIGINT AS sequence,to_json(r)::VARCHAR AS value FROM (${physical.sql}) r`,
      );
    }
    const expected = (await pg.query("SELECT * FROM standing")).rows;
    assertEquals(
      canonical(program.finish(inputs).standing),
      canonical(expected),
    );
    const file =
      new URL("../computations/standings.js", import.meta.url).pathname;
    const cage = new Cage(file);
    try {
      await cage.load(compile(file, await Deno.readTextFile(file)), [
        "TextEncoder",
      ]);
      assertEquals((await cage.ask({ inputs, seed: 17 })).jobs, []);
      const result = await cage.ask({ outputs: [] });
      assertEquals(
        canonical((result.out as { standing: unknown[] }).standing),
        canonical(expected),
        "the admitted pure computation uses the same finish",
      );
    } finally {
      cage.close();
    }
    const host = {
      query: async (sql: string) =>
        (await conn.runAndReadAll(sql)).getRowObjectsJson(),
    };
    let state: unknown = null;
    const actual: any[] = [];
    for (let i = 0; i < 1000; i++) {
      const result = await step(host, state);
      assertEquals(
        await step(host, state),
        result,
        "replaying an immutable input and checkpoint",
      );
      for (const sql of result.statements ?? []) await conn.run(sql);
      if ("standing" in result.writes) {
        actual.push(...(result.writes.standing ?? []));
      }
      state = JSON.parse(JSON.stringify(result.checkpoint));
      if (result.done) break;
      if (i === 999) throw new Error("standings did not finish");
    }
    assertEquals(canonical(actual), canonical(expected));
  } finally {
    conn.closeSync();
    db.closeSync();
    await pg.close();
  }
});

Deno.test("standings preparation and replay pass the real paged execution admission boundary", async () => {
  const db = await wasmFixture();
  try {
    const conn = db.connect();
    conn.query("CREATE SCHEMA duckstream_private");
    const members = ["a", "b"].map((team_id) => ({
      group_id: "g",
      team_id,
      team_name: team_id,
      sort: "pt,name",
      points: 0,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      goal_diff: 0,
    }));
    const form = Array.from(
      { length: 260 },
      (_, i) => ({
        group_id: "g",
        team_id: "a",
        id: String(i).padStart(4, "0"),
        day: "2026-01-01",
        kickoff: null,
        result: i % 2 ? "w" : "l",
      }),
    );
    const inputs = { groups: [{ id: "g" }], members, form, zones: [] };
    for (const [name, rows] of Object.entries(inputs)) {
      conn.query(
        `CREATE TABLE duckstream_private.result_${name}(sequence BIGINT,value VARCHAR)`,
      );
      if (rows.length) {
        conn.query(
          `INSERT INTO duckstream_private.result_${name} VALUES ${
            rows.map((row, i) => `(${i + 1},${literal(JSON.stringify(row))})`)
              .join(",")
          }`,
        );
      }
    }
    conn.close();
    let store = await PagedExecution.open(asyncHost(db), ["standing"]);
    for (let i = 0; i < 200; i++) {
      const before = await store.state();
      const result = await step({
        query: (sql) => store.query(sql),
      }, before.checkpoint);
      const after = await store.commit(before.revision, result);
      assertEquals(await store.commit(before.revision, result), after);
      store = await PagedExecution.open(asyncHost(db), ["standing"]);
      assertEquals(await store.state(), after, "durable restart");
      if (result.done) break;
      if (i === 199) throw new Error("standings did not finish");
    }
    assertEquals(
      canonical((await store.output("standing")).rows),
      canonical(program.finish(inputs).standing),
    );
  } finally {
    db.reset();
  }
});
