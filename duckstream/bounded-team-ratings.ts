import { finish } from "./team_ratings.pure.js";
import {
  advanceHistoric,
  type HistoricCheckpoint,
  initialHistoric,
  type SpiRating,
} from "./historic.ts";
import {
  boundedRows,
  boundedWasm,
  bytes,
  type Host,
  n,
  type Row,
  source,
  type Step,
  stepJobLimit,
  teams,
  zero,
} from "./bounded-ratings.ts";

type Checkpoint =
  | { stage: "prepare"; index: number }
  | { stage: "initialize" }
  | { stage: "historic"; historic: HistoricCheckpoint; last: number }
  | { stage: "done" };

const STEP_WRITE_BUDGET = 2 * 1024 * 1024;

const preparation = [
  `CREATE TABLE ratings_team_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'id') AS id FROM ${source("teams")})`,
  `CREATE TABLE ratings_game_inputs AS SELECT
      r.id AS uuid,r.home_id,r.away_id,r.home_score,r.away_score,r.home_aet,r.away_aet,
      r.home_field,r.moment AS timestamp,r.date
    FROM (SELECT from_json_strict(value,'{"id":"VARCHAR","home_id":"VARCHAR","away_id":"VARCHAR",
      "home_score":"INTEGER","away_score":"INTEGER","home_aet":"INTEGER","away_aet":"INTEGER","home_field":"INTEGER",
      "moment":"BIGINT","date":"VARCHAR"}') AS r FROM ${source("games")})`,
  `CREATE TABLE ratings_home_games AS SELECT g.* EXCLUDE(home_id),
      coalesce(t.number,error('unknown home team')) AS home_id
    FROM ratings_game_inputs g
    LEFT JOIN ratings_team_ids t ON t.id=g.home_id`,
  "DROP TABLE ratings_game_inputs",
  `CREATE TABLE ratings_away_games AS SELECT g.* EXCLUDE(away_id),
      coalesce(t.number,error('unknown away team')) AS away_id
    FROM ratings_home_games g LEFT JOIN ratings_team_ids t ON t.id=g.away_id`,
  "DROP TABLE ratings_home_games",
  `CREATE TABLE ratings_game_ordinals AS SELECT rowid AS source_row,
      (row_number() OVER (ORDER BY timestamp,uuid)-1)::INTEGER AS ordinal
    FROM ratings_away_games`,
  `CREATE TABLE ratings_historic_games AS SELECT o.ordinal,g.uuid,g.home_id,g.away_id,
      g.* EXCLUDE(uuid,home_id,away_id)
    FROM ratings_away_games g JOIN ratings_game_ordinals o ON g.rowid=o.source_row`,
  "DROP TABLE ratings_game_ordinals",
  "DROP TABLE ratings_away_games",
];

const teamGames = async (db: Host, where: string) => {
  const rows = await boundedRows(
    db,
    `SELECT home_id,away_id,home_score,away_score,home_aet,away_aet,timestamp,home_field
    FROM ratings_historic_games WHERE ${where} ORDER BY ordinal`,
  );
  return rows.map((g) => {
    const length = g.home_aet === null ? 1 : 4 / 3;
    return {
      phase_id: 0,
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
      throw new Error("invalid team ratings preparation checkpoint");
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
  if (checkpoint.stage === "done") return answer(checkpoint);
  if (checkpoint.stage === "initialize") {
    const [bounds] = await db.query(
      "SELECT min(timestamp) AS first,max(ordinal)::INTEGER AS last FROM ratings_historic_games",
    );
    if (bounds.first === null) return answer({ stage: "done" });
    const historic = initialHistoric(zero(await teams(db)));
    historic.firstTimestamp = n(bounds, "first");
    return answer({ stage: "historic", historic, last: n(bounds, "last") });
  }
  if (checkpoint.stage !== "historic") {
    throw new Error("unknown bounded team ratings checkpoint");
  }
  const teamRows = await teams(db);
  const shaping = {
    teams: teamRows.map((r) => ({ id: r.id })),
    games: [{ id: "bounded" }],
  };
  const maxRefits = stepJobLimit(db, 8);
  const byId = new Map<string, Row>();
  let current = checkpoint.historic;
  let refits = 0;
  let approxBytes = 2;
  while (!current.complete && refits < maxRefits) {
    const [game] = await db.query(
      `SELECT ordinal,timestamp FROM ratings_historic_games
      WHERE ordinal>${current.lastOrdinal} AND (timestamp>${
        current.firstTimestamp! + current.nextOffset
      } OR ordinal=${checkpoint.last})
      ORDER BY ordinal LIMIT 1`,
    );
    if (!game) throw new Error("historic continuation lost its final game");
    const ordinal = n(game, "ordinal");
    const result = await advanceHistoric(
      { ...current, lastOrdinal: ordinal - 1 },
      {
        ordinal,
        timestamp: n(game, "timestamp"),
        last: ordinal === checkpoint.last,
      },
      async (window, ratings) => {
        refits++;
        return await boundedWasm(db, {
          op: "spi",
          request: {
            games: await teamGames(
              db,
              `timestamp>=${window.minimumTimestamp} AND ordinal<=${window.throughOrdinal}`,
            ),
            ratings,
            phases_to_eval: [],
          },
        }) as Record<string, SpiRating | null>;
      },
    );
    current = result.checkpoint;
    if (result.rows.length) {
      const { team_rating } = finish(shaping, [result.rows]) as {
        team_rating: Row[];
      };
      for (const row of team_rating) {
        const id = String(row.id);
        if (!byId.has(id)) approxBytes += bytes(row) + 1;
        byId.set(id, row);
      }
      if (approxBytes >= STEP_WRITE_BUDGET) break;
    }
  }
  return answer(
    current.complete ? { stage: "done" } : { ...checkpoint, historic: current },
    { team_rating: [...byId.values()] },
  );
}
