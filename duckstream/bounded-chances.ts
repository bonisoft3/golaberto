import { finish, plan } from "./chances.pure.js";
import {
  boundedWasm,
  type Host,
  literal,
  type Row,
  type Step,
} from "./bounded-ratings.ts";

type CompactResponse = {
  team_odds: Record<string, { Pos: number[] }>;
  game_importance: Record<string, [number | null, number | null]>;
  rare_position_estimates: Record<
    string,
    Record<string, { reachability: string }>
  >;
};
type Checkpoint =
  | { stage: "groups"; after: number }
  | {
    stage: "finish";
    ordinal: number;
    after: number;
    outputs: CompactResponse[];
  }
  | { stage: "done" };
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
const JOB_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 256 * 1024;
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

async function boundedRows(db: Host, sql: string): Promise<Row[]> {
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
    let pageSize = 0;
    for (const row of page) {
      const cost = bytes(row) + (rows.length ? 1 : 0);
      size += cost;
      pageSize += cost;
      if (size > JOB_BYTES) {
        throw new Error(
          "computation query exceeds bounded WASM input capacity",
        );
      }
      rows.push(row);
    }
    if (page.length === 0 || (page.length < 4096 && pageSize < 524288)) break;
  }
  return rows;
}
const compact = (output: unknown): CompactResponse => {
  const response = output as CompactResponse;
  return {
    team_odds: Object.fromEntries(
      Object.entries(response.team_odds).map((
        [id, value],
      ) => [id, { Pos: value.Pos }]),
    ),
    game_importance: response.game_importance,
    rare_position_estimates: Object.fromEntries(
      Object.entries(response.rare_position_estimates).map((
        [id, positions],
      ) => [
        id,
        Object.fromEntries(
          Object.entries(positions).map((
            [position, value],
          ) => [position, { reachability: value.reachability }]),
        ),
      ]),
    ),
  };
};
const source = (name: string) => `duckstream_private.result_${name}`;
const rows = (db: Host, name: string, id: string) =>
  boundedRows(
    db,
    `SELECT * EXCLUDE(ordinal) FROM chances_${name}
    WHERE group_id=${literal(id)} ORDER BY ordinal`,
  );

export async function step(db: Host, state: unknown): Promise<Step> {
  if (state === null || state === undefined) {
    return {
      checkpoint: { stage: "groups", after: -1 },
      writes: {},
      done: false,
      statements: [
        `CREATE TABLE chances_groups AS SELECT (row_number() OVER (ORDER BY r.id)-1)::INTEGER AS ordinal,r.* FROM (SELECT from_json_strict(value,'{"id":"VARCHAR","live":"BOOLEAN","sort":"VARCHAR","bonus_points":"INTEGER","bonus_points_threshold":"INTEGER","win":"INTEGER","draw":"INTEGER","loss":"INTEGER"}') AS r FROM ${
          source("groups")
        }) ORDER BY ordinal`,
        `CREATE TABLE chances_members AS SELECT (row_number() OVER (PARTITION BY r.group_id ORDER BY r.name,r.team_id)-1)::INTEGER AS ordinal,r.* FROM (SELECT from_json_strict(value,'{"group_id":"VARCHAR","team_id":"VARCHAR","name":"VARCHAR","add_sub":"INTEGER","bias":"INTEGER","position":"INTEGER","points":"INTEGER","played":"INTEGER"}') AS r FROM ${
          source("members")
        }) ORDER BY r.group_id,ordinal`,
        `CREATE TABLE chances_games AS SELECT (row_number() OVER (PARTITION BY r.group_id ORDER BY r.__order,r.id)-1)::INTEGER AS ordinal,r.* FROM (SELECT from_json_strict(value,'{"group_id":"VARCHAR","id":"VARCHAR","home_id":"VARCHAR","away_id":"VARCHAR","home_field":"VARCHAR","played":"BOOLEAN","home_score":"INTEGER","away_score":"INTEGER","home_off":"DOUBLE","home_def":"DOUBLE","away_off":"DOUBLE","away_def":"DOUBLE","__order":"VARCHAR"}') AS r FROM ${
          source("games")
        }) ORDER BY r.group_id,ordinal`,
        `CREATE TABLE chances_zones AS SELECT (row_number() OVER (PARTITION BY r.group_id ORDER BY r.first,r.last,r.id)-1)::INTEGER AS ordinal,r.* FROM (SELECT from_json_strict(value,'{"group_id":"VARCHAR","id":"VARCHAR","first":"INTEGER","last":"INTEGER","positions":"VARCHAR","color":"VARCHAR"}') AS r FROM ${
          source("zones")
        }) ORDER BY r.group_id,ordinal`,
        "CREATE TABLE chances_importance(id VARCHAR,home DOUBLE,away DOUBLE)",
      ],
    };
  }
  const checkpoint = state as Checkpoint;
  if (checkpoint.stage === "done") {
    return { checkpoint, writes: {}, done: true };
  }
  if (checkpoint.stage !== "groups" && checkpoint.stage !== "finish") {
    throw new Error("unknown bounded chances checkpoint");
  }
  if (!Number.isSafeInteger(db.seed)) {
    throw new Error("bounded chances needs the computation seed");
  }
  const batch = await db.query(
    `SELECT * FROM chances_groups
    WHERE ${
      checkpoint.stage === "finish"
        ? `ordinal=${checkpoint.ordinal} ORDER BY ordinal LIMIT 1`
        : `ordinal>${checkpoint.after} AND ordinal<=${
          checkpoint.after + 32
        } ORDER BY ordinal LIMIT 32`
    }`,
  );
  const [next] = batch;
  if (!next) {
    if (checkpoint.stage === "finish") {
      throw new Error("unfinished chances group is missing");
    }
    return { checkpoint: { stage: "done" }, writes: {}, done: true };
  }
  if (checkpoint.stage === "groups" && !next.live) {
    const finished: Row[] = [];
    for (const row of batch) {
      if (row.live) break;
      finished.push(row);
    }
    const ids = finished.map((row) => literal(String(row.id))).join(",");
    const memberRows = finished.length === 1
      ? await rows(db, "members", String(finished[0].id))
      : await boundedRows(
        db,
        `SELECT * EXCLUDE(ordinal) FROM chances_members WHERE group_id IN (${ids}) ORDER BY group_id,ordinal`,
      );
    const zoneRows = finished.length === 1
      ? await rows(db, "zones", String(finished[0].id))
      : await boundedRows(
        db,
        `SELECT * EXCLUDE(ordinal) FROM chances_zones WHERE group_id IN (${ids}) ORDER BY group_id,ordinal`,
      );
    const membersByGroup = new Map<string, Row[]>();
    for (const row of memberRows) {
      const key = String(row.group_id);
      let list = membersByGroup.get(key);
      if (!list) {
        list = [];
        membersByGroup.set(key, list);
      }
      list.push(row);
    }
    const zonesByGroup = new Map<string, Row[]>();
    for (const row of zoneRows) {
      const key = String(row.group_id);
      let list = zonesByGroup.get(key);
      if (!list) {
        list = [];
        zonesByGroup.set(key, list);
      }
      list.push(row);
    }
    const writes: Record<string, Row[]> = {
      team_chance: [],
      zone_chance: [],
      position_chance: [],
      game_importance: [],
    };
    let size = bytes(writes);
    let lastOrdinal = checkpoint.after;
    for (const item of finished) {
      const { ordinal, ...group } = item;
      const groupId = String(group.id);
      const groupWrites: Record<string, Row[]> = {
        team_chance: [],
        zone_chance: [],
        position_chance: [],
        game_importance: [],
      };
      let groupSize = 0;
      let fits = true;
      finish(
        {
          groups: [group],
          members: membersByGroup.get(groupId) ?? [],
          games: [],
          zones: zonesByGroup.get(groupId) ?? [],
        },
        [],
        (sink: string, row: Row) => {
          const cost = bytes(row) + 1;
          if (size + groupSize + cost > PAGE_BYTES) {
            fits = false;
            return false;
          }
          groupWrites[sink].push(row);
          groupSize += cost;
        },
      );
      if (!fits) {
        if (lastOrdinal === checkpoint.after) {
          return {
            checkpoint: {
              stage: "finish",
              ordinal: Number(ordinal),
              after: 0,
              outputs: [],
            },
            writes: {},
            done: false,
          };
        }
        break;
      }
      for (const sink of Object.keys(writes)) {
        writes[sink].push(...groupWrites[sink]);
      }
      size += groupSize;
      lastOrdinal = Number(ordinal);
    }
    return {
      checkpoint: { stage: "groups", after: lastOrdinal },
      writes,
      done: false,
    };
  }
  const { ordinal, ...group } = next;
  const groupId = String(group.id);
  const inputs = {
    groups: [group],
    members: await rows(db, "members", groupId),
    games: await rows(db, "games", groupId),
    zones: await rows(db, "zones", groupId),
  };
  if (checkpoint.stage === "groups") {
    const jobs = plan(inputs, db.seed);
    const outputs: CompactResponse[] = [];
    if (jobs.length) {
      if (jobs.length !== 1) {
        throw new Error("one group planned multiple odds jobs");
      }
      jobs[0].input.request.id = Number(ordinal) + 1;
      outputs.push(compact(await boundedWasm(db, jobs[0].input)));
    }
    const saved: Checkpoint = {
      stage: "finish",
      ordinal: Number(ordinal),
      after: 0,
      outputs,
    };
    if (bytes(saved) > CHECKPOINT_BYTES) {
      throw new Error("chances result exceeds bounded checkpoint capacity");
    }
    return { checkpoint: saved, writes: {}, done: false };
  }
  const writes: Record<string, Row[]> = {
    team_chance: [],
    zone_chance: [],
    position_chance: [],
    game_importance: [],
  };
  let cursor = 0;
  let size = bytes(writes);
  let complete = true;
  finish(inputs, checkpoint.outputs, (sink: string, row: Row) => {
    if (cursor < checkpoint.after) {
      cursor++;
      return;
    }
    // An importance side can gain a finite DOUBLE from the preceding group.
    const cost = bytes(row) + 1 + (sink === "game_importance" ? 64 : 0);
    if (size + cost > PAGE_BYTES) {
      if (cursor === checkpoint.after) {
        throw new Error("chances row exceeds bounded page capacity");
      }
      complete = false;
      return false;
    }
    writes[sink].push(row);
    cursor++;
    size += cost;
  });
  const importance = writes.game_importance;
  const statements: string[] = [];
  if (importance.length) {
    const prior = await boundedRows(
      db,
      `SELECT * FROM chances_importance WHERE id IN (${
        importance.map((r) => literal(String(r.id))).join(",")
      }) ORDER BY id`,
    );
    const byId = new Map(prior.map((r) => [r.id, r]));
    for (const row of importance) {
      const before = byId.get(row.id);
      row.home = row.home ?? before?.home ?? null;
      row.away = row.away ?? before?.away ?? null;
    }
    statements.push(
      `DELETE FROM chances_importance WHERE id IN (${
        importance.map((r) => literal(String(r.id))).join(",")
      })`,
    );
    statements.push(
      `INSERT INTO chances_importance VALUES ${
        importance.map((r) =>
          `(${literal(String(r.id))},${r.home === null ? "NULL" : r.home},${
            r.away === null ? "NULL" : r.away
          })`
        ).join(",")
      }`,
    );
  }
  return {
    checkpoint: complete
      ? { stage: "groups", after: Number(ordinal) }
      : { ...checkpoint, after: cursor },
    writes,
    statements,
    done: false,
  };
}
