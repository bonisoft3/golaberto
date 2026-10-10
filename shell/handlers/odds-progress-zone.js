(state, event) => {
  const row = state.items[0];
  if (!row) return '*';
  if (event.value === '*') return '*';
  if (typeof event.value !== 'string' || event.value === '') return row.zone_id;
  const zones = JSON.parse(row.series_json).zones ?? [];
  return zones.some(zone => zone.id === event.value) ? event.value : row.zone_id;
}
