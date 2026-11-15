import { finish } from "./ratings.pure.js";
import {
  advanceHistoric,
  type HistoricCheckpoint,
  initialHistoric,
  type SpiRating,
} from "./historic.ts";

export type Row = Record<string, unknown>;
export interface Host {
  query(sql: string): Promise<Row[]>;
  wasm(name: string, input: unknown): Promise<unknown>;
  wasmFromQuery(
    name: string,
    input: unknown,
    query: { path: string[]; sql: string; orderBy: string },
  ): Promise<unknown>;
  seed?: number;
}
export interface Step {
  checkpoint: unknown;
  writes: Record<string, Row[]>;
  statements?: string[];
  done: boolean;
}
type Checkpoint =
  | { stage: "prepare"; index: number }
  | { stage: "prepare_players"; index: number; now: number; cutoff: string }
  | { stage: "initialize" }
  | { stage: "historic"; historic: HistoricCheckpoint; last: number }
  | { stage: "eval"; after: string }
  | { stage: "players"; after: number; now: number; cutoff: string }
  | { stage: "done" };

export const JOB_BYTES = 8 * 1024 * 1024;
const PLAYER_BATCH = 32;
const APPEARANCE_LIMIT = 12000;
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const source = (name: string) => `duckstream_private.result_${name}`;
const n = (row: Row, name: string) => {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ratings integer ${name}`);
  }
  return value;
};
const text = (row: Row, name: string) => {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`invalid ratings text ${name}`);
  }
  return value;
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

export async function boundedRows(db: Host, sql: string): Promise<Row[]> {
  const rows: Row[] = [];
  let size = 2;
  for (;;) {
    const page = await db.query(
      `WITH bounded_page AS MATERIALIZED (
        SELECT * FROM (${sql}) AS bounded_page LIMIT 4096 OFFSET ${rows.length}
      ), bounded_numbered AS (
        SELECT *,row_number() OVER () AS __bounded_position FROM bounded_page
      ), bounded_sized AS (
        SELECT *,sum(octet_length(encode(to_json(r)::VARCHAR))+1)
          OVER (ORDER BY __bounded_position) AS __bounded_total
        FROM bounded_numbered r
      ) SELECT * EXCLUDE(__bounded_position,__bounded_total) FROM bounded_sized
      WHERE CASE WHEN __bounded_position=1 AND __bounded_total>1048574
        THEN error('execution query row exceeds page limit')
        ELSE __bounded_total<=1048574 END ORDER BY __bounded_position`,
    );
    for (const row of page) {
      size += bytes(row) + (rows.length ? 1 : 0);
      if (size > JOB_BYTES) {
        throw new Error(
          "computation query exceeds bounded WASM input capacity",
        );
      }
      rows.push(row);
    }
    if (page.length === 0) break;
  }
  return rows;
}

export async function boundedWasm(db: Host, input: unknown): Promise<unknown> {
  if (bytes(input) > JOB_BYTES) {
    throw new Error("computation job exceeds bounded WASM input capacity");
  }
  return await db.wasm("golaberto-odds", input);
}

const preparation = [
  `CREATE TABLE ratings_team_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'id') AS id FROM ${source("teams")})`,
  `CREATE TABLE ratings_player_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'id') AS id FROM ${source("players")})`,
  `CREATE TABLE ratings_phase_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'phase_id') AS id FROM ${source("games")})`,
  `CREATE TABLE ratings_game_inputs AS SELECT
      r.id AS uuid,r.phase_id,r.home_id,r.away_id,r.home_score,r.away_score,r.home_aet,r.away_aet,
      r.home_field,r.moment AS timestamp,r.date,r.recent,r.seven_years
    FROM (SELECT from_json_strict(value,'{"id":"VARCHAR","phase_id":"VARCHAR","home_id":"VARCHAR","away_id":"VARCHAR",
      "home_score":"INTEGER","away_score":"INTEGER","home_aet":"INTEGER","away_aet":"INTEGER","home_field":"INTEGER",
      "moment":"BIGINT","date":"VARCHAR","recent":"BOOLEAN","seven_years":"BOOLEAN"}') AS r FROM ${
    source("games")
  })`,
  `CREATE TABLE ratings_home_games AS SELECT g.* EXCLUDE(home_id),
      coalesce(t.number,error('unknown home team')) AS home_id
    FROM ratings_game_inputs g
    LEFT JOIN ratings_team_ids t ON t.id=g.home_id`,
  "DROP TABLE ratings_game_inputs",
  `CREATE TABLE ratings_away_games AS SELECT g.* EXCLUDE(away_id),
      coalesce(t.number,error('unknown away team')) AS away_id
    FROM ratings_home_games g LEFT JOIN ratings_team_ids t ON t.id=g.away_id`,
  "DROP TABLE ratings_home_games",
  `CREATE TABLE ratings_joined_games AS SELECT g.* EXCLUDE(phase_id),p.number AS phase_id
    FROM ratings_away_games g JOIN ratings_phase_ids p ON p.id=g.phase_id`,
  "DROP TABLE ratings_away_games",
  `CREATE TABLE ratings_game_ordinals AS SELECT rowid AS source_row,
      (row_number() OVER (ORDER BY timestamp,uuid)-1)::INTEGER AS ordinal
    FROM ratings_joined_games`,
  `CREATE TABLE ratings_games AS SELECT o.ordinal,g.uuid,g.phase_id,g.home_id,g.away_id,
      g.* EXCLUDE(uuid,phase_id,home_id,away_id)
    FROM ratings_joined_games g JOIN ratings_game_ordinals o ON g.rowid=o.source_row`,
  "DROP TABLE ratings_game_ordinals",
  "DROP TABLE ratings_joined_games",
  `CREATE TABLE ratings_historic_games AS SELECT * EXCLUDE(ordinal),
    (row_number() OVER (ORDER BY ordinal)-1)::INTEGER AS ordinal FROM ratings_games WHERE seven_years`,
  `CREATE TABLE ratings_history(team_id INTEGER, measure_date VARCHAR, off_rating DOUBLE, def_rating DOUBLE)`,
];

const playerPreparation = [
  `CREATE TABLE ratings_game_ids AS SELECT row_number() OVER (ORDER BY uuid)::INTEGER AS number, uuid
    FROM ratings_games WHERE recent`,
  `CREATE TABLE ratings_appearance_inputs AS SELECT r.id,r.game_id,r.player_id,r.team_id,r.on,r.off,r.red,
    CASE WHEN r.position IN ('dm','am') THEN 'cm'
      WHEN r.position IN ('g','dc','dl','dr','cm','fw','') THEN r.position ELSE NULL END AS position
    FROM (SELECT from_json_strict(value,'{"id":"VARCHAR","game_id":"VARCHAR","player_id":"VARCHAR","team_id":"VARCHAR",
      "on":"INTEGER","off":"INTEGER","red":"BOOLEAN","position":"VARCHAR"}') AS r FROM ${
    source("appearances")
  })`,
  `CREATE TABLE ratings_game_appearances AS SELECT a.* EXCLUDE(game_id),
    coalesce(g.number,error('unknown appearance game')) AS game_id
    FROM ratings_appearance_inputs a LEFT JOIN ratings_game_ids g ON g.uuid=a.game_id`,
  "DROP TABLE ratings_appearance_inputs",
  `CREATE TABLE ratings_player_appearances AS SELECT a.* EXCLUDE(player_id),
    coalesce(p.number,error('unknown appearance player')) AS player_id
    FROM ratings_game_appearances a LEFT JOIN ratings_player_ids p ON p.id=a.player_id`,
  "DROP TABLE ratings_game_appearances",
  `CREATE TABLE ratings_typed_appearances AS SELECT a.* EXCLUDE(team_id),
    coalesce(t.number,error('unknown appearance team')) AS team_id
    FROM ratings_player_appearances a LEFT JOIN ratings_team_ids t ON t.id=a.team_id`,
  "DROP TABLE ratings_player_appearances",
  `CREATE TABLE ratings_appearance_ordinals AS SELECT rowid AS source_row,
    row_number() OVER (ORDER BY id)::INTEGER AS id FROM ratings_typed_appearances`,
  `CREATE TABLE ratings_appearances AS SELECT o.id,a.game_id,a.player_id,a.team_id,a.on,a.off,a.red,a.position
    FROM ratings_typed_appearances a JOIN ratings_appearance_ordinals o ON a.rowid=o.source_row`,
  "DROP TABLE ratings_appearance_ordinals",
  "DROP TABLE ratings_typed_appearances",
  `CREATE TABLE ratings_goal_inputs AS SELECT
    row_number() OVER (ORDER BY r.__order,sequence) AS sequence,
    r.game_id,r.player_id,r.team_id,r.time,r.penalty,r.own_goal
    FROM (SELECT sequence,from_json_strict(value,'{"__order":"VARCHAR","game_id":"VARCHAR","player_id":"VARCHAR",
      "team_id":"VARCHAR","time":"INTEGER","penalty":"BOOLEAN","own_goal":"BOOLEAN"}') AS r FROM ${
    source("goals")
  })`,
  `CREATE TABLE ratings_game_goals AS SELECT a.* EXCLUDE(game_id),
    coalesce(g.number,error('unknown goal game')) AS game_id
    FROM ratings_goal_inputs a LEFT JOIN ratings_game_ids g ON g.uuid=a.game_id`,
  "DROP TABLE ratings_goal_inputs",
  `CREATE TABLE ratings_player_goals AS SELECT a.* EXCLUDE(player_id),
    coalesce(p.number,error('unknown goal player')) AS player_id
    FROM ratings_game_goals a LEFT JOIN ratings_player_ids p ON p.id=a.player_id`,
  "DROP TABLE ratings_game_goals",
  `CREATE TABLE ratings_goals AS SELECT a.* EXCLUDE(team_id),
    coalesce(t.number,error('unknown goal team')) AS team_id
    FROM ratings_player_goals a LEFT JOIN ratings_team_ids t ON t.id=a.team_id`,
  "DROP TABLE ratings_player_goals",
];

const teamGames = async (db: Host, table: string, where: string) => {
  const rows = await boundedRows(
    db,
    `SELECT phase_id,home_id,away_id,home_score,away_score,home_aet,away_aet,timestamp,home_field
    FROM ${table} WHERE ${where} ORDER BY ordinal`,
  );
  return rows.map((g) => {
    const length = g.home_aet === null ? 1 : 4 / 3;
    return {
      phase_id: g.phase_id,
      home_id: g.home_id,
      away_id: g.away_id,
      home_score:
        (Number(g.home_score) + (g.home_aet === null ? 0 : n(g, "home_aet"))) /
        length,
      away_score:
        (Number(g.away_score) + (g.away_aet === null ? 0 : n(g, "away_aet"))) /
        length,
      timestamp: g.timestamp,
      length,
      advantage:
        [0.16133676871779334, 0, -0.16133676871779334][n(g, "home_field")],
    };
  });
};
const teams = (db: Host) =>
  boundedRows(db, "SELECT number,id FROM ratings_team_ids ORDER BY number");
const zero = (rows: Row[]) =>
  rows.map((r) => ({ id: n(r, "number"), offense: 0, defense: 0, team: 0 }));
const shaping = (teamRows: Row[], playerRows: Row[] = [], recent = false) => ({
  teams: teamRows.map((r) => ({ id: r.id })),
  players: playerRows.map((r) => ({ id: r.id })),
  games: [{ phase_id: "bounded", recent }],
  phases: [],
});
const answer = (
  checkpoint: Checkpoint,
  writes: Record<string, Row[]> = {},
  statements?: string[],
): Step => ({
  checkpoint,
  writes,
  ...(statements ? { statements } : {}),
  done: checkpoint.stage === "done",
});

export async function step(db: Host, state: unknown): Promise<Step> {
  const checkpoint = (state ?? { stage: "prepare", index: 0 }) as Checkpoint;
  if (checkpoint.stage === "prepare") {
    if (
      !Number.isSafeInteger(checkpoint.index) || checkpoint.index < 0 ||
      checkpoint.index >= preparation.length
    ) {
      throw new Error("invalid ratings preparation checkpoint");
    }
    return answer(
      checkpoint.index + 1 === preparation.length ? { stage: "initialize" } : {
        stage: "prepare",
        index: checkpoint.index + 1,
      },
      {},
      [preparation[checkpoint.index]],
    );
  }
  if (checkpoint.stage === "prepare_players") {
    if (
      !Number.isSafeInteger(checkpoint.index) || checkpoint.index < 0 ||
      checkpoint.index >= playerPreparation.length
    ) {
      throw new Error("invalid player preparation checkpoint");
    }
    return answer(
      checkpoint.index + 1 === playerPreparation.length
        ? {
          stage: "players",
          after: 0,
          now: checkpoint.now,
          cutoff: checkpoint.cutoff,
        }
        : { ...checkpoint, index: checkpoint.index + 1 },
      {},
      [playerPreparation[checkpoint.index]],
    );
  }
  if (checkpoint.stage === "done") return answer(checkpoint);
  if (checkpoint.stage === "initialize") {
    const [bounds] = await db.query(
      "SELECT min(timestamp) AS first,max(ordinal)::INTEGER AS last FROM ratings_historic_games",
    );
    if (bounds.first === null) {
      const [all] = await db.query(
        "SELECT count(*)::INTEGER AS n FROM ratings_games",
      );
      if (n(all, "n") !== 0) {
        throw new Error("nonempty archive has no seven-year games");
      }
      return answer({ stage: "done" });
    }
    const historic = initialHistoric(zero(await teams(db)));
    historic.firstTimestamp = n(bounds, "first");
    return answer({ stage: "historic", historic, last: n(bounds, "last") });
  }
  if (checkpoint.stage === "historic") {
    const prior = checkpoint.historic;
    const [game] = await db.query(
      `SELECT ordinal,timestamp FROM ratings_historic_games
      WHERE ordinal>${prior.lastOrdinal} AND (timestamp>${
        prior.firstTimestamp! + prior.nextOffset
      } OR ordinal=${checkpoint.last})
      ORDER BY ordinal LIMIT 1`,
    );
    if (!game) throw new Error("historic continuation lost its final game");
    const ordinal = n(game, "ordinal");
    const result = await advanceHistoric(
      { ...prior, lastOrdinal: ordinal - 1 },
      {
        ordinal,
        timestamp: n(game, "timestamp"),
        last: ordinal === checkpoint.last,
      },
      async (window, ratings) =>
        await boundedWasm(db, {
          op: "spi",
          request: {
            games: await teamGames(
              db,
              "ratings_historic_games",
              `timestamp>=${window.minimumTimestamp} AND ordinal<=${window.throughOrdinal}`,
            ),
            ratings,
            phases_to_eval: [],
          },
        }) as Record<string, SpiRating | null>,
    );
    const teamRows = await teams(db);
    const writes = finish(shaping(teamRows), [result.rows]) as Record<
      string,
      Row[]
    >;
    const numbers = new Map(teamRows.map((r) => [r.id, r.number]));
    const rows = writes.team_rating;
    const statements = rows.length
      ? [
        `INSERT INTO ratings_history VALUES ${
          rows.map((r) =>
            `(${numbers.get(r.team_id)},${
              literal(String(r.measure_date))
            },${r.offense},${r.defense})`
          ).join(",")
        }`,
      ]
      : [];
    if (rows.length) {
      statements.unshift(
        `DELETE FROM ratings_history WHERE measure_date=${
          literal(String(rows[0].measure_date))
        } AND team_id IN (${
          rows.map((r) => numbers.get(r.team_id)).join(",")
        })`,
      );
    }
    return answer(
      result.checkpoint.complete ? { stage: "eval", after: "" } : {
        ...checkpoint,
        historic: result.checkpoint,
      },
      writes,
      statements,
    );
  }
  if (checkpoint.stage === "eval") {
    const [phase] = await db.query(
      `SELECT (p.value->>'id') AS id, ((p.value->>'since'))::BIGINT AS since,
      ((p.value->>'until'))::BIGINT AS until,n.number FROM ${source("phases")} p
      LEFT JOIN ratings_phase_ids n ON n.id=(p.value->>'id')
      WHERE (p.value->>'id')>${
        literal(checkpoint.after)
      } ORDER BY (p.value->>'id') LIMIT 1`,
    );
    if (phase) {
      const output = await db.wasmFromQuery("golaberto-odds", {
        op: "eval",
        request: {
          games: [],
          ratings: zero(await teams(db)),
          phases_to_eval: [n(phase, "number")],
        },
      }, {
        path: ["request", "games"],
        orderBy: "ordinal",
        sql: `SELECT ordinal,phase_id,home_id,away_id,
          (CAST(home_score AS DOUBLE)+coalesce(home_aet,0))/(CASE WHEN home_aet IS NULL THEN 1.0 ELSE 4.0/3.0 END) AS home_score,
          (CAST(away_score AS DOUBLE)+coalesce(away_aet,0))/(CASE WHEN home_aet IS NULL THEN 1.0 ELSE 4.0/3.0 END) AS away_score,
          timestamp,CASE WHEN home_aet IS NULL THEN 1.0 ELSE 4.0/3.0 END AS length,
          CASE home_field WHEN 0 THEN CAST(0.16133676871779334 AS DOUBLE) WHEN 1 THEN 0.0
            WHEN 2 THEN CAST(-0.16133676871779334 AS DOUBLE) ELSE error('invalid home field') END AS advantage
          FROM ratings_games WHERE timestamp>${
          n(phase, "since")
        } AND timestamp<=${n(phase, "until")}`,
      }) as { rps: number };
      return answer({ stage: "eval", after: text(phase, "id") }, {
        rating_eval: [{ id: phase.id, rps: output.rps }],
      });
    }
    const [recent] = await db.query(
      "SELECT CASE WHEN count(*)=0 THEN NULL ELSE greatest(0,max(timestamp)) END AS now FROM ratings_games WHERE recent",
    );
    if (recent.now === null) return answer({ stage: "done" });
    const [cutoff] = await db.query(
      `SELECT (value->>'since') AS since FROM ${
        source("cutoff")
      } ORDER BY sequence LIMIT 1`,
    );
    return answer({
      stage: "prepare_players",
      index: 0,
      now: n(recent, "now"),
      cutoff: text(cutoff, "since"),
    });
  }
  if (checkpoint.stage !== "players") {
    throw new Error("unknown bounded ratings checkpoint");
  }
  let targets = await db.query(`SELECT p.number,p.id FROM ratings_player_ids p
    WHERE p.number>${checkpoint.after} AND EXISTS(SELECT 1 FROM ratings_appearances a WHERE a.player_id=p.number)
    ORDER BY p.number LIMIT ${PLAYER_BATCH}`);
  if (targets.length === 0) return answer({ stage: "done" });
  let request: Row;
  for (;;) {
    const ids = targets.map((r) => n(r, "number")).join(",");
    const wanted =
      `SELECT DISTINCT game_id FROM ratings_appearances WHERE player_id IN (${ids})`;
    const [size] = await db.query(
      `SELECT count(*)::INTEGER AS n FROM ratings_appearances WHERE game_id IN (${wanted})`,
    );
    if (n(size, "n") > APPEARANCE_LIMIT) {
      if (targets.length === 1) {
        throw new Error(
          "one player's games exceed bounded appearance capacity",
        );
      }
      targets = targets.slice(0, Math.ceil(targets.length / 2));
      continue;
    }
    const selected =
      `SELECT ids.number AS id,g.* FROM ratings_games g JOIN ratings_game_ids ids ON ids.uuid=g.uuid
      WHERE ids.number IN (${wanted})`;
    const games = await boundedRows(
      db,
      `SELECT id,home_id,away_id,date,home_field,home_aet FROM (${selected}) ORDER BY ordinal`,
    );
    const goals = await boundedRows(
      db,
      `SELECT * EXCLUDE(sequence) FROM ratings_goals WHERE game_id IN (${wanted}) ORDER BY sequence`,
    );
    const appearances = await boundedRows(
      db,
      `SELECT * FROM ratings_appearances WHERE game_id IN (${wanted}) ORDER BY id`,
    );
    // get_rating advances only past dates strictly before the game. Its first
    // available row also covers games older than the retained history.
    const historical_ratings = await boundedRows(
      db,
      `WITH selected AS (${selected}), needed AS (
      SELECT home_id AS team_id,substr(date,1,10) AS date FROM selected UNION
      SELECT away_id AS team_id,substr(date,1,10) AS date FROM selected), chosen AS (
      SELECT n.team_id,coalesce(
        (SELECT max(h.measure_date) FROM ratings_history h WHERE h.team_id=n.team_id
          AND h.measure_date>${
        literal(checkpoint.cutoff)
      } AND h.measure_date<n.date),
        (SELECT min(h.measure_date) FROM ratings_history h WHERE h.team_id=n.team_id
          AND h.measure_date>${
        literal(checkpoint.cutoff)
      })) AS measure_date FROM needed n)
      SELECT DISTINCT h.* FROM ratings_history h JOIN chosen c USING(team_id,measure_date) ORDER BY team_id,measure_date`,
    );
    request = {
      games,
      goals,
      appearances,
      historical_ratings,
      now: checkpoint.now,
    };
    if (bytes({ op: "player_ratings", request }) <= JOB_BYTES) break;
    if (targets.length === 1) {
      throw new Error("one player's games exceed bounded WASM input capacity");
    }
    targets = targets.slice(0, Math.ceil(targets.length / 2));
  }
  const output = await boundedWasm(db, {
    op: "player_ratings",
    request,
  }) as Record<string, number[]>;
  const byPlayer = new Map(output.player_id.map((id, i) => [id, i]));
  const people = targets.filter((r) => byPlayer.has(n(r, "number")));
  const totals: Record<string, number[]> = {
    player_id: people.map((_, i) => i + 1),
  };
  for (const name of ["player_off", "player_def", "player_minutes"]) {
    totals[name] = people.map((r) =>
      output[name][byPlayer.get(n(r, "number"))!]
    );
  }
  const writes = finish(shaping([], people, true), [[], totals]) as Record<
    string,
    Row[]
  >;
  return answer({
    ...checkpoint,
    after: n(targets[targets.length - 1], "number"),
  }, writes);
}
