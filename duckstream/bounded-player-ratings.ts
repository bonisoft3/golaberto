import { finish } from "./player_ratings.pure.js";
import {
  boundedRows,
  boundedWasm,
  bytes,
  type Host,
  JOB_BYTES,
  literal,
  n,
  type Row,
  source,
  type Step,
  stepJobLimit,
  text,
  workerLimit,
} from "./bounded-ratings.ts";

type Checkpoint =
  | { stage: "prepare"; index: number }
  | { stage: "initialize" }
  | { stage: "players"; after: number; now: number; cutoff: string }
  | { stage: "done" };

const PLAYER_BATCH = 32;
const APPEARANCE_LIMIT = 12000;
const PLAYER_FIELDS = ["player_id", "player_off", "player_def", "player_minutes"] as const;

const preparation = [
  `CREATE TABLE ratings_team_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'id') AS id FROM ${source("teams")})`,
  `CREATE TABLE ratings_player_ids AS SELECT row_number() OVER (ORDER BY id)::INTEGER AS number, id
    FROM (SELECT DISTINCT (value->>'id') AS id FROM ${source("players")})`,
  `CREATE TABLE ratings_game_inputs AS SELECT
      r.id AS uuid,r.home_id,r.away_id,r.home_aet,r.home_field,r.moment AS timestamp,r.date
    FROM (SELECT from_json_strict(value,'{"id":"VARCHAR","home_id":"VARCHAR","away_id":"VARCHAR",
      "home_aet":"INTEGER","home_field":"INTEGER","moment":"BIGINT","date":"VARCHAR"}') AS r FROM ${
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
  `CREATE TABLE ratings_game_ordinals AS SELECT rowid AS source_row,
      (row_number() OVER (ORDER BY timestamp,uuid)-1)::INTEGER AS ordinal
    FROM ratings_away_games`,
  `CREATE TABLE ratings_games AS SELECT o.ordinal,g.uuid,g.home_id,g.away_id,
      g.* EXCLUDE(uuid,home_id,away_id)
    FROM ratings_away_games g JOIN ratings_game_ordinals o ON g.rowid=o.source_row`,
  "DROP TABLE ratings_game_ordinals",
  "DROP TABLE ratings_away_games",
  `CREATE TABLE ratings_game_ids AS SELECT row_number() OVER (ORDER BY uuid)::INTEGER AS number, uuid
    FROM ratings_games`,
  `CREATE TABLE ratings_history_inputs AS SELECT r.team_id,r.measure_date,r.offense,r.defense
    FROM (SELECT from_json_strict(value,'{"team_id":"VARCHAR","measure_date":"VARCHAR","offense":"DOUBLE","defense":"DOUBLE"}') AS r FROM ${
    source("team_ratings")
  })`,
  `CREATE TABLE ratings_history AS SELECT coalesce(t.number,error('unknown rated team')) AS team_id,
    h.measure_date,h.offense AS off_rating,h.defense AS def_rating
    FROM ratings_history_inputs h LEFT JOIN ratings_team_ids t ON t.id=h.team_id`,
  "DROP TABLE ratings_history_inputs",
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

async function buildSlice(
  db: Host,
  after: number,
  now: number,
  cutoff: string,
): Promise<{ targets: Row[]; request: Row; last: number } | null> {
  let targets = await db.query(`SELECT p.number,p.id FROM ratings_player_ids p
    WHERE p.number>${after} AND EXISTS(SELECT 1 FROM ratings_appearances a WHERE a.player_id=p.number)
    ORDER BY p.number LIMIT ${PLAYER_BATCH}`);
  if (targets.length === 0) return null;
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
        literal(cutoff)
      } AND h.measure_date<n.date),
        (SELECT min(h.measure_date) FROM ratings_history h WHERE h.team_id=n.team_id
          AND h.measure_date>${
        literal(cutoff)
      })) AS measure_date FROM needed n)
      SELECT DISTINCT h.* FROM ratings_history h JOIN chosen c USING(team_id,measure_date) ORDER BY team_id,measure_date`,
    );
    const request = {
      games,
      goals,
      appearances,
      historical_ratings,
      now,
    };
    if (bytes({ op: "player_ratings", request }) <= JOB_BYTES) {
      return {
        targets,
        request,
        last: n(targets[targets.length - 1], "number"),
      };
    }
    if (targets.length === 1) {
      throw new Error("one player's games exceed bounded WASM input capacity");
    }
    targets = targets.slice(0, Math.ceil(targets.length / 2));
  }
}

export async function step(db: Host, state: unknown): Promise<Step> {
  const checkpoint = (state ?? { stage: "prepare", index: 0 }) as Checkpoint;
  if (checkpoint.stage === "prepare") {
    if (
      !Number.isSafeInteger(checkpoint.index) || checkpoint.index < 0 ||
      checkpoint.index >= preparation.length
    ) {
      throw new Error("invalid player ratings preparation checkpoint");
    }
    return answer(
      checkpoint.index + 1 === preparation.length
        ? { stage: "initialize" }
        : { stage: "prepare", index: checkpoint.index + 1 },
      {},
      [preparation[checkpoint.index]],
    );
  }
  if (checkpoint.stage === "done") return answer(checkpoint);
  if (checkpoint.stage === "initialize") {
    const [recent] = await db.query(
      "SELECT CASE WHEN count(*)=0 THEN NULL ELSE greatest(0,max(timestamp)) END AS now FROM ratings_games",
    );
    if (recent.now === null) return answer({ stage: "done" });
    const [cutoff] = await db.query(
      `SELECT (value->>'since') AS since FROM ${
        source("cutoff")
      } ORDER BY sequence LIMIT 1`,
    );
    return answer({
      stage: "players",
      after: 0,
      now: n(recent, "now"),
      cutoff: text(cutoff, "since"),
    });
  }
  if (checkpoint.stage !== "players") {
    throw new Error("unknown bounded player ratings checkpoint");
  }
  const maxSlices = stepJobLimit(db, 64);
  const workerCount = workerLimit(db, Math.min(16, maxSlices));
  const slices: { targets: Row[]; request: Row; last: number }[] = [];
  const outputs: Record<string, number[]>[] = [];
  let cursor = checkpoint.after;
  let exhausted = false;
  let sliceLock = Promise.resolve();
  const nextSlice = () => {
    const pending = sliceLock.then(async () => {
      if (exhausted || slices.length >= maxSlices) return null;
      const slice = await buildSlice(db, cursor, checkpoint.now, checkpoint.cutoff);
      if (!slice) {
        exhausted = true;
        return null;
      }
      const index = slices.length;
      slices.push(slice);
      cursor = slice.last;
      return { index, slice };
    });
    sliceLock = pending.then(() => {}, () => {});
    return pending;
  };
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const item = await nextSlice();
        if (!item) return;
        outputs[item.index] = await boundedWasm(
          db,
          { op: "player_ratings", request: item.slice.request },
          PLAYER_FIELDS,
        ) as Record<string, number[]>;
      }
    }),
  );
  if (slices.length === 0) return answer({ stage: "done" });
  const rows: Row[] = [];
  for (let s = 0; s < slices.length; s++) {
    const output = outputs[s];
    const targets = slices[s].targets;
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
    const batch = finish(
      { players: people.map((r) => ({ id: r.id })), games: [{ id: "bounded" }] },
      [totals],
    ) as { player_rating: Row[] };
    rows.push(...batch.player_rating);
  }
  return answer({ ...checkpoint, after: cursor }, { player_rating: rows });
}
