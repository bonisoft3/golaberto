import {
  type PhysicalQuery,
  quote,
  type Relation,
  type Schema,
  type as sqlType,
} from "@bonisoft3/pronto/duckstream/translator.ts";

export const outputs = {
  ratings: [
    "games",
    "phases",
    "cutoff",
    "teams",
    "players",
    "appearances",
    "goals",
  ],
  chances: ["groups", "members", "games", "zones"],
  cards: ["game_card", "team_game"],
  standings: ["groups", "members", "form", "zones"],
  player_stats: ["player_stat"],
};
const order: Record<string, Record<string, string>> = {
  cards: { game_card: "id", team_game: "id" },
  standings: {
    groups: "id",
    members: "group_id, team_id",
    form: "",
    zones: "group_id, id",
  },
  player_stats: { player_stat: "id" },
  ratings: {
    games: "moment, id",
    phases: "id",
    teams: "id",
    players: "id",
    appearances: "id",
    goals: "__order",
  },
  chances: {
    groups: "id",
    members: "group_id, name, team_id",
    games: "group_id, __order, id",
    zones: "group_id, first, last, id",
  },
};
export type Computation = keyof typeof outputs;
const utc =
  "coalesce(kickoff::TIMESTAMPTZ AT TIME ZONE 'UTC', day::DATE::TIMESTAMP)";
// A fixture the provider cancelled, abandoned or awarded without play has no
// result to project: chances neither keep its group live nor simulate it.
const withdrawn =
  "coalesce(sync_status, 'scheduled') IN ('cancelled', 'abandoned', 'awarded')";
const stamp = (value: string) => `strftime(${value}, '%Y-%m-%dT%H:%M:%S.%fZ')`;

// Row-local carriers retain the archive's UTC, calendar-year and f32 contracts.
// Relational joins and aggregates belong to the compiled Duckstream program.
function expression(
  name: Computation,
  table: string,
  field: string,
  type: string,
) {
  // Four exact 32-bit limbs preserve all 128 identity bits for ASOF equality keys.
  const key = /^(home|away|team)_key_([0-3])$/.exec(field);
  if (key) {
    const column = key[1] === "team" ? "team_id" : key[1] + "_id";
    const value = `CAST('0x' || substr(replace(${column}::VARCHAR, '-', ''), ${
      Number(key[2]) * 8 + 1
    }, 8) AS BIGINT)`;
    return field === "team_key_0"
      ? `CASE WHEN count(*) OVER (PARTITION BY team_id, measure_date::DATE) > 1 THEN error('ambiguous team_rating team/day') ELSE ${value} END`
      : value;
  }
  if (
    (name === "cards" || name === "standings") && table === "game" &&
    field === "kickoff"
  ) {
    return stamp("kickoff::TIMESTAMPTZ AT TIME ZONE 'UTC'");
  }
  if (name === "chances" && table === "game" && field === "withdrawn") {
    return withdrawn;
  }
  if (name === "cards" && table === "game" && field === "fixture_available") {
    return `played OR NOT (${withdrawn})`;
  }
  if (table === "game") {
    if (name === "ratings") {
      const special: Record<string, string> = {
        utc,
        moment: `epoch(${utc})::BIGINT`,
        date: `strftime(${utc}, '%Y-%m-%d %H:%M:%S')`,
        four_years: `epoch(${utc} - INTERVAL 4 YEAR)::BIGINT`,
        cutoff: `(${utc} - INTERVAL 1463 DAY)::DATE::VARCHAR`,
        home_field:
          "CASE home_field WHEN 'left' THEN 0 WHEN 'neutral' THEN 1 WHEN 'right' THEN 2 ELSE error('home_field ' || home_field) END",
      };
      if (special[field]) return special[field];
    } else if (field === "moment") return utc;
  }
  if (table === "team_rating") {
    // >= ASOF at microsecond precision is the original strict comparison to the
    // rating day's UTC midnight.
    if (field === "moment") {
      return "measure_date::DATE::TIMESTAMP + INTERVAL 1 MICROSECOND";
    }
    if (["offense", "defense"].includes(field)) {
      return `${quote(field)}::DOUBLE::FLOAT::DOUBLE`;
    }
  }
  return `CAST(${quote(field)} AS ${type})`;
}
function projection(name: Computation, relation: Relation, json: boolean) {
  const table = relation.name.replace(/^source_/, "");
  return relation.fields.map((field) => {
    const type = sqlType(field.columntype);
    const value = expression(name, table, field.name, type);
    return `${json && type === "TIMESTAMP" ? stamp(value) : value} AS ${
      quote(field.name)
    }`;
  }).join(", ");
}
export function carriers(
  name: Computation,
  queries: Record<string, string>,
  schema: Schema,
) {
  const bindings = sourceBindings(name, schema);
  return Object.fromEntries(outputs[name].map((output) => {
    const view = "result_" + output;
    if (!queries[view]) throw new Error("missing compiled view " + view);
    return [
      output,
      `WITH ${bindings.join(",\n")}\n${
        resultCarrier(queries[view], schema, view)
      }${order[name][output] ? " ORDER BY " + order[name][output] : ""}`,
    ];
  }));
}
function sourceBindings(name: Computation, schema: Schema) {
  return schema.inputs.map((relation) =>
    `${quote(relation.name)} AS (SELECT ${
      projection(name, relation, false)
    } FROM ${quote(relation.name.replace(/^source_/, ""))})`
  );
}
function resultCarrier(query: string, schema: Schema, view: string) {
  const relation = schema.outputs.find((r) => r.name === view);
  if (!relation) throw new Error("missing compiled view " + view);
  const columns = relation.fields.map((field) =>
    field.columntype.type === "TIMESTAMP"
      ? `${stamp(`result.${quote(field.name)}`)} AS ${quote(field.name)}`
      : `result.${quote(field.name)}`
  );
  return `SELECT ${columns.join(", ")} FROM (${
    query.trim().replace(/;$/, "")
  }) result`;
}
export function physicalCarriers(
  name: Computation,
  queries: Record<string, PhysicalQuery>,
  schema: Schema,
): Record<string, PhysicalQuery> {
  const bindings = sourceBindings(name, schema);
  return Object.fromEntries(outputs[name].map((output) => {
    const view = "result_" + output;
    const query = queries[view];
    if (!query) throw new Error("missing compiled view " + view);
    return [
      output,
      {
        sql: resultCarrier(query.sql, schema, view),
        stages: query.stages.map((stage) => ({
          name: stage.name,
          sql: `WITH ${bindings.join(",\n")}\n${stage.sql}`,
        })),
      },
    ];
  }));
}
function postgresProjection(name: Computation, relation: Relation) {
  const table = relation.name.replace(/^source_/, "");
  const epoch = (value: string) =>
    `(EXTRACT(EPOCH FROM ${value})::double precision)::bigint`;
  return relation.fields.map((field) => {
    const column = quote(field.name);
    const type = sqlType(field.columntype);
    let value = `CAST(${column} AS ${
      type === "DOUBLE" ? "double precision" : type
    })`;
    if (
      (name === "cards" || name === "standings") && table === "game" &&
      field.name === "kickoff"
    ) {
      value =
        `to_char(kickoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    }
    const limb = /^(home|away|team)_key_([0-3])$/.exec(field.name);
    if (limb) {
      const id = limb[1] === "team" ? "team_id" : limb[1] + "_id";
      value = `('x' || substr(replace(${quote(id)}::text, '-', ''), ${
        Number(limb[2]) * 8 + 1
      }, 8))::bit(32)::bigint`;
    } else if (
      name === "chances" && table === "game" && field.name === "withdrawn"
    ) {
      value = withdrawn;
    } else if (
      name === "cards" && table === "game" && field.name === "fixture_available"
    ) {
      value = `played OR NOT (${withdrawn})`;
    } else if (table === "game" && name === "ratings") {
      const special: Record<string, string> = {
        utc,
        moment: epoch(utc),
        date: `to_char(${utc}, 'YYYY-MM-DD HH24:MI:SS')`,
        four_years: epoch(`(${utc} - INTERVAL '4 years')`),
        cutoff: `(${utc} - INTERVAL '1463 days')::date::varchar`,
        home_field:
          "CASE home_field WHEN 'left' THEN 0 WHEN 'neutral' THEN 1 WHEN 'right' THEN 2 ELSE ('invalid home_field: ' || home_field)::integer END",
      };
      value = special[field.name] ?? value;
    } else if (table === "game" && field.name === "moment") value = utc;
    else if (table === "team_rating") {
      if (field.name === "moment") {
        value = "measure_date::date::timestamp + INTERVAL '1 microsecond'";
      }
      if (["offense", "defense"].includes(field.name)) {
        value = `${column}::double precision::real::double precision`;
      }
    }
    return `${value} AS ${column}`;
  }).join(", ");
}

export function descriptor(name: Computation, sql: string, schema: Schema) {
  const fields = (r: Relation) =>
    r.fields.map((f) => {
      const type = sqlType(f.columntype);
      if (
        !["VARCHAR", "BOOLEAN", "INTEGER", "BIGINT", "DOUBLE", "TIMESTAMP"]
          .includes(type)
      ) throw new Error("unsupported RisingWave JSON type " + type);
      return { name: f.name, type };
    });
  return {
    sql,
    incremental: {
      ...(name === "chances"
        ? {
          checks: {
            duplicate_team_rating:
              "SELECT team_id,moment,COUNT(*) AS n FROM source_team_rating GROUP BY team_id,moment HAVING COUNT(*)>1",
          },
        }
        : {}),
      inputs: Object.fromEntries(schema.inputs.map((r) => [r.name, {
        table: r.name.replace(/^source_/, ""),
        projection: postgresProjection(name, r),
      }])),
      outputs: Object.fromEntries(outputs[name].map((output) => [output, {
        partitionQuery: name === "chances"
          ? `SELECT g.phase_id AS __partition,r.* FROM result_${output} r JOIN source_stage_group g ON g.id=r.${
            output === "groups" ? "id" : "group_id"
          }`
          : name === "standings"
          ? `SELECT r.${output === "groups" ? "id" : "group_id"} AS __partition,r.* FROM result_${output} r`
          : name === "cards"
          ? `SELECT r.${output === "game_card" ? "phase_id" : "phase_key"} AS __partition,r.* FROM result_${output} r`
          : name === "player_stats"
          ? `SELECT r.championship_id AS __partition,r.* FROM result_${output} r`
          : `SELECT CAST('' AS VARCHAR) AS __partition,r.* FROM result_${output} r`,
      }])),
    },
    inputs: Object.fromEntries(schema.inputs.map((r) => [r.name, {
      query: `SELECT ${projection(name, r, true)} FROM ${
        quote(r.name.replace(/^source_/, ""))
      }`,
      fields: fields(r),
    }])),
    outputs: Object.fromEntries(outputs[name].map((output) => {
      const r = schema.outputs.find((r) => r.name === "result_" + output);
      if (!r?.materialized) {
        throw new Error("missing materialized view " + output);
      }
      return [output, { view: r.name, fields: fields(r) }];
    })),
  };
}
