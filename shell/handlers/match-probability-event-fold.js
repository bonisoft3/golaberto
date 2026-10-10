(state) => {
  const view = state.rows.view?.[0];
  if (!view) return { updates: [] };
  if (state.items.length > 20) {
    throw new RangeError(
      "A match probability scenario cannot exceed 20 events",
    );
  }
  const events = state.items.map((row) => {
    if (
      typeof row.id !== "string" || !Number.isInteger(row.sequence) ||
      row.sequence < 1 || (row.kind !== "goal" && row.kind !== "red_card") ||
      (row.side !== "home" && row.side !== "away") ||
      !Number.isInteger(row.minute) || row.minute < 0 || row.minute > 130
    ) {
      throw new RangeError("Hypothetical match event is invalid");
    }
    return {
      id: row.id,
      sequence: row.sequence,
      kind: row.kind,
      side: row.side,
      minute: row.minute,
    };
  }).sort((left, right) => left.sequence - right.sequence);
  const events_json = JSON.stringify(events);
  const event_count = events.length;
  return events_json === view.events_json && event_count === view.event_count
    ? { updates: [] }
    : {
      updates: [{
        op: "patch",
        entity: "match_probability_scenario",
        id: view.id,
        row: { events_json, event_count },
      }],
    };
}
