export interface ProjectionHost {
  query(sql: string): Promise<Record<string, unknown>[]>;
}
type Checkpoint = { sink: number; after: number };
const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

export async function projectionStep(
  host: ProjectionHost,
  sinks: readonly string[],
  checkpoint: unknown,
) {
  const state = (checkpoint ?? { sink: 0, after: 0 }) as Checkpoint;
  if (
    !state || !Number.isSafeInteger(state.sink) || state.sink < 0 ||
    state.sink > sinks.length ||
    !Number.isSafeInteger(state.after) || state.after < 0
  ) throw new Error("invalid projection checkpoint");
  if (state.sink === sinks.length) {
    return { checkpoint: state, writes: {}, done: true };
  }
  const sink = sinks[state.sink];
  if (!/^[a-z_][a-z_0-9]*$/.test(sink)) {
    throw new Error("invalid projection sink");
  }
  const page = await host.query(
    `SELECT sequence::DOUBLE AS sequence,value FROM duckstream_private.result_${sink}
    WHERE sequence>${state.after} AND sequence<=${
      state.after + 1024
    } ORDER BY sequence LIMIT 1024`,
  );
  const writes: Record<string, unknown>[] = [];
  let after = state.after, bytes = 2;
  for (const item of page) {
    if (
      !Number.isSafeInteger(item.sequence) || Number(item.sequence) <= after ||
      typeof item.value !== "string"
    ) {
      throw new Error("invalid projection result page");
    }
    const size = encoder.encode(item.value).length + (writes.length ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      if (!writes.length) {
        throw new Error("projection row exceeds publication page");
      }
      break;
    }
    const row = JSON.parse(item.value);
    if (
      !row || Array.isArray(row) || typeof row !== "object" ||
      typeof row.id !== "string"
    ) throw new Error("invalid projection row");
    writes.push(row);
    bytes += size;
    after = Number(item.sequence);
  }
  const next = page.length === 0
    ? { sink: state.sink + 1, after: 0 }
    : { sink: state.sink, after };
  return {
    checkpoint: next,
    writes: writes.length ? { [sink]: writes } : {},
    done: next.sink === sinks.length,
  };
}
