(state) => {
  const source = state.rows.source?.[0];
  const payload = {
    payload_json: source?.payload_json ?? "",
    home_name: source?.home_name ?? "",
    away_name: source?.away_name ?? "",
  };
  const stored = state.rows.stored?.[0];
  if (!stored) {
    if (!state.items[0]) return { updates: [] };
    const { id, ...row } = state.items[0];
    return {
      updates: [{
        op: "put",
        entity: "match_probability_scenario",
        id,
        row: { ...row, ...payload },
      }],
    };
  }
  return Object.keys(payload).every((key) => payload[key] === stored[key])
    ? { updates: [] }
    : {
      updates: [{
        op: "patch",
        entity: "match_probability_scenario",
        id: stored.id,
        row: payload,
      }],
    };
}
