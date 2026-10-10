(state, _event, params) => {
  const row = state.items[0];
  if (!row) throw new Error("Match probability scenario is missing");
  const sequence = row.event_sequence;
  const count = row.event_count;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= 2147483647) {
    throw new RangeError("Match probability event sequence is invalid");
  }
  if (!Number.isInteger(count) || count < 0 || count > 20) {
    throw new RangeError("Match probability event count is invalid");
  }
  if (params.operation === "can-add") return count < 20;
  if (params.operation === "next-sequence") return sequence + 1;
  if (params.operation === "next-count") return count + 1;
  if (params.operation === "next-id") return `${row.id}:hyp:${sequence + 1}`;
  throw new RangeError("Unknown match probability event operation");
}
