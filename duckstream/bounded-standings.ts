import { rankGroup, retainForm } from "./standings.pure.js";
import type { Step } from "./bounded-ratings.ts";
import type { ProjectionHost } from "./bounded-projection.ts";

type Row = Record<string, any>;
type Checkpoint = {
  group: number;
  form: number;
  forms: Record<string, Row[]>;
  after: number;
  ready: boolean;
};
const source = (name: string) => `duckstream_private.result_${name}`;
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_STATE = 4 * 1024 * 1024;
const PAGE_BYTES = 256 * 1024;
const QUERY_BRANCHES = 4;
export async function step(
  host: ProjectionHost,
  checkpoint: unknown,
): Promise<Step> {
  if (
    checkpoint == null ||
    (checkpoint as { prepare?: unknown }).prepare !== undefined
  ) {
    const prepare = checkpoint == null
      ? 0
      : (checkpoint as { prepare: number }).prepare;
    if (!Number.isSafeInteger(prepare) || prepare < 0 || prepare > 128) {
      throw new Error("invalid standings preparation checkpoint");
    }
    const statement = prepare === 64
      ? `CREATE TABLE standings_zones AS SELECT sequence,value,value->>'group_id' AS group_id FROM ${source("zones")} ORDER BY group_id,sequence`
      : `CREATE TABLE standings_${prepare < 64 ? "members" : "form"}_${
        prepare < 64 ? prepare : prepare - 65
      } AS SELECT sequence,value,value->>'group_id' AS group_id FROM ${
        source(prepare < 64 ? "members" : "form")
      } WHERE hash(value->>'group_id') % 64 = ${
        prepare < 64 ? prepare : prepare - 65
      } ORDER BY group_id,sequence`;
    return {
      checkpoint: prepare === 128
        ? { group: 0, form: 0, forms: {}, after: 0, ready: false }
        : { prepare: prepare + 1 },
      writes: {},
      done: false,
      statements: [statement],
    };
  }
  const state = checkpoint as Checkpoint;
  if (
    !state ||
    ![state.group, state.form, state.after].every((n) =>
      Number.isSafeInteger(n) && n >= 0
    ) ||
    typeof state.ready !== "boolean" || !state.forms ||
    Array.isArray(state.forms) || bytes(state) > MAX_STATE
  ) {
    throw new Error("invalid bounded standings checkpoint");
  }
  if (!state.ready && state.form === 0 && state.after === 0) {
    const candidates = await host.query(
      `SELECT sequence::DOUBLE AS sequence,value,CAST(hash(value->>'id') % 64 AS INTEGER) AS bucket FROM ${source("groups")} WHERE sequence>${state.group} ORDER BY sequence LIMIT 32`,
    );
    if (!candidates.length) return { checkpoint: state, writes: {}, done: true };
    const groups = candidates.map((row) => {
      const group = JSON.parse(String(row.value));
      if (typeof group.id !== "string" || !Number.isInteger(row.bucket) || Number(row.bucket) < 0 || Number(row.bucket) >= 64) {
        throw new Error("invalid standings group");
      }
      return { id: group.id as string, bucket: Number(row.bucket), sequence: Number(row.sequence) };
    });
    const parts = (group: typeof groups[number], index: number) => ["members", "form", "zones"].map((kind) => ({
      kind, index,
      id: group.id,
      table: `standings_${kind}${kind === "zones" ? "" : `_${group.bucket}`}`,
    }));
    const all = groups.flatMap(parts);
    const byTable = (parts: typeof all, kind: string) => {
      const tables = new Map<string, typeof all>();
      for (const part of parts) {
        if (part.kind !== kind) continue;
        const entries = tables.get(part.table) ?? [];
        entries.push(part);
        tables.set(part.table, entries);
      }
      return [...tables].map(([table, entries]) => ({ table, values: entries.map(({ index, id }) => `(${index},${literal(id)})`).join(",") }));
    };
    const stats: Row[] = [];
    for (const kind of ["members", "form", "zones"]) {
      const matching = byTable(all, kind);
      for (let at = 0; at < matching.length; at += QUERY_BRANCHES) {
        stats.push(...await host.query(matching.slice(at, at + QUERY_BRANCHES).map(({ table, values }) =>
          `SELECT wanted.idx,${literal(kind)} AS kind,count(source.group_id)::DOUBLE AS n,COALESCE(sum(octet_length(encode(source.value))),0)::DOUBLE AS size FROM (VALUES ${values}) AS wanted(idx,id) LEFT JOIN ${table} AS source ON source.group_id=wanted.id GROUP BY wanted.idx`
        ).join(" UNION ALL ")));
      }
    }
    const summaries = groups.map(() => ({ members: 0, bytes: 0, rows: 0 }));
    for (const row of stats) {
      const summary = summaries[Number(row.idx)];
      if (!summary || !["members", "form", "zones"].includes(String(row.kind))) throw new Error("invalid standings batch metadata");
      const count = Number(row.n), size = Number(row.size);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(size) || size < 0) throw new Error("invalid standings batch size");
      if (row.kind === "members") summary.members = count;
      summary.rows += count;
      summary.bytes += size * 6 + count * 128;
    }
    let count = 0, totalMembers = 0, totalBytes = 0, totalRows = 0;
    for (const summary of summaries) {
      if (totalMembers + summary.members > 128 || totalBytes + summary.bytes > MAX_STATE || totalRows + summary.rows > 8192) break;
      count++; totalMembers += summary.members; totalBytes += summary.bytes; totalRows += summary.rows;
    }
    if (count) {
      const selected = all.filter((part) => part.index < count);
      const rows: Row[] = [];
      for (const kind of ["members", "form", "zones"]) {
        const matching = byTable(selected, kind);
        for (let at = 0; at < matching.length; at += QUERY_BRANCHES) {
          rows.push(...await host.query(matching.slice(at, at + QUERY_BRANCHES).map(({ table, values }) =>
            `SELECT wanted.idx,${literal(kind)} AS kind,source.sequence::DOUBLE AS sequence,source.value FROM (VALUES ${values}) AS wanted(idx,id) JOIN ${table} AS source ON source.group_id=wanted.id`
          ).join(" UNION ALL ") + " ORDER BY idx,sequence"));
        }
      }
      const inputs = groups.slice(0, count).map(() => ({ members: [] as Row[], form: [] as Row[], zones: [] as Row[] }));
      for (const row of rows) {
        const input = inputs[Number(row.idx)];
        const kind = String(row.kind) as keyof typeof input;
        if (!input || !(kind in input)) throw new Error("invalid standings batch row");
        input[kind].push(JSON.parse(String(row.value)));
      }
      const page: Row[] = [];
      let accepted = 0;
      for (const input of inputs) {
        const result = rankGroup(input.members, input.zones, retainForm({}, input.form));
        if (page.length + result.length > 128 || bytes([...page, ...result]) > PAGE_BYTES) break;
        page.push(...result);
        accepted++;
      }
      if (accepted) return {
        checkpoint: { group: groups[accepted - 1].sequence, form: 0, forms: {}, after: 0, ready: false },
        writes: page.length ? { standing: page } : {}, done: false,
      };
    }
  }
  const [next] = await host.query(
    `SELECT sequence::DOUBLE AS sequence,value,CAST(hash(value->>'id') % 64 AS INTEGER) AS bucket FROM ${
      source("groups")
    } WHERE sequence>${state.group} ORDER BY sequence LIMIT 1`,
  );
  if (!next) return { checkpoint: state, writes: {}, done: true };
  const group = JSON.parse(String(next.value));
  if (typeof group.id !== "string") throw new Error("invalid standings group");
  if (
    !Number.isInteger(next.bucket) || Number(next.bucket) < 0 ||
    Number(next.bucket) >= 64
  ) throw new Error("invalid standings form partition");
  const condition = `group_id=${literal(group.id)}`;
  if (!state.ready) {
    const page = await host.query(
      `SELECT sequence::DOUBLE AS sequence,value FROM standings_form_${next.bucket} WHERE ${condition} AND sequence>${state.form} ORDER BY sequence LIMIT 128`,
    );
    const forms = retainForm(
      JSON.parse(JSON.stringify(state.forms)),
      page.map((row) => JSON.parse(String(row.value))),
    );
    const nextState = {
      ...state,
      forms,
      form: page.length ? Number(page.at(-1)!.sequence) : state.form,
      ready: page.length === 0,
    };
    if (bytes(nextState) > MAX_STATE) {
      throw new Error("standings group form exceeds checkpoint capacity");
    }
    return { checkpoint: nextState, writes: {}, done: false };
  }
  const read = async (name: string) => {
    const rows = await host.query(
      `SELECT value FROM standings_${name}${name === "members" ? `_${next.bucket}` : ""} WHERE ${condition} ORDER BY sequence LIMIT 8193`,
    );
    if (rows.length > 8192 || bytes(rows) > MAX_STATE) {
      throw new Error("standings group exceeds bounded ranking capacity");
    }
    return rows.map((row) => JSON.parse(String(row.value)));
  };
  const members = await read("members"), zones = await read("zones");
  const result = rankGroup(members, zones, state.forms);
  const page: Row[] = [];
  for (const row of result.slice(state.after, state.after + 128)) {
    if (bytes([...page, row]) > PAGE_BYTES) {
      if (!page.length) {
        throw new Error("standing exceeds publication page capacity");
      }
      break;
    }
    page.push(row);
  }
  const after = state.after + page.length;
  return {
    checkpoint: after === result.length
      ? {
        group: Number(next.sequence),
        form: 0,
        forms: {},
        after: 0,
        ready: false,
      }
      : { ...state, after },
    writes: page.length ? { standing: page } : {},
    done: false,
  };
}
