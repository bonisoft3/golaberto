(state, event) => {
  const row = state.items[0];
  if (!row) return '*';
  if (event.value === '*') return '*';
  try {
    const zones = JSON.parse(row.series_json).zones;
    if (zones.some(zone => zone.id === event.value)) return event.value;
  } catch {}
  return row.zone_id;
}
