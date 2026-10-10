(state, event, params) => {
  const row = state.items[0];
  if (!row) throw new Error("Team chart state is missing");
  const matches = typeof event.from === "string" &&
    event.from === `${row.id}${params.suffix}`;
  if (params.operation === "matches") return matches;
  if (params.field !== "range_from" && params.field !== "range_to") {
    throw new RangeError("Unknown final-position field");
  }
  if (!matches) return row[params.field];
  // Stored as typed: an unusable position is the reader's to see, and the
  // chart says so beside the inputs rather than refusing the keystroke.
  return (event.value?.trim() ?? "").slice(0, 12);
}
