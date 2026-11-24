export type Row = Record<string, unknown>;
export interface Host {
  query(sql: string): Promise<Row[]>;
  wasm(name: string, input: unknown, select?: readonly string[]): Promise<unknown>;
  wasmFromQuery(
    name: string,
    input: unknown,
    query: { path: string[]; sql: string; orderBy: string },
    select?: readonly string[],
  ): Promise<unknown>;
  seed?: number;
  concurrency?: number;
  maxJobs?: number;
}
export interface Step {
  checkpoint: unknown;
  writes: Record<string, Row[]>;
  statements?: string[];
  done: boolean;
}

export const JOB_BYTES = 8 * 1024 * 1024;
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const source = (name: string) => `duckstream_private.result_${name}`;
export const n = (row: Row, name: string) => {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ratings integer ${name}`);
  }
  return value;
};
export const text = (row: Row, name: string) => {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`invalid ratings text ${name}`);
  }
  return value;
};
export const bytes = (value: unknown) =>
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

export async function boundedWasm(
  db: Host,
  input: unknown,
  select?: readonly string[],
): Promise<unknown> {
  if (bytes(input) > JOB_BYTES) {
    throw new Error("computation job exceeds bounded WASM input capacity");
  }
  return await (select !== undefined
    ? db.wasm("golaberto-odds", input, select)
    : db.wasm("golaberto-odds", input));
}

export const teams = (db: Host) =>
  boundedRows(db, "SELECT number,id FROM ratings_team_ids ORDER BY number");
export const zero = (rows: Row[]) =>
  rows.map((r) => ({ id: n(r, "number"), offense: 0, defense: 0, team: 0 }));
export const stepJobLimit = (db: Host, max = 64) =>
  Math.max(1, Math.min(max, db.maxJobs ?? 1));
export const workerLimit = (db: Host, max = 16) =>
  Math.max(1, Math.min(max, db.concurrency ?? 1));
