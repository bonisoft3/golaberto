(state, event, params) => {
  const row = state.items[0];
  if (!row) return params?.field?.startsWith('guard') ? false : -1;
  const from = String(event.from || '');
  const graph = from.startsWith('position-graph-');
  let positions = [];
  try { positions = JSON.parse(row.current_json).positions || []; } catch {}
  const ordered = [...positions].sort((a,b) => a.position-b.position);
  let position = row.position_number;
  if (from.startsWith('position-slider-') && event.value !== '') {
    const value = Number(event.value);
    if (Number.isInteger(value) && ordered.some(item => item.position === value)) position = value;
  } else if (graph && Number.isFinite(event.pointerX) && ordered.length) {
    const fraction = Math.max(0,Math.min(1,(event.pointerX * .64 - 52) / 574));
    position = ordered[Math.min(ordered.length-1,Math.floor(fraction*ordered.length))].position;
  }
  if (params?.field === 'guard-pointer') {
    if (graph) return position !== row.position_number;
    if (!from.startsWith('odds-graph-') || !Number.isFinite(event.pointerX)) return false;
    const index = Math.round(Math.max(0,Math.min(1,(event.pointerX * .64 - 52) / 574))*row.snapshot_last);
    return index !== (row.snapshot_index < 0 ? row.snapshot_last : row.snapshot_index);
  }
  if (params?.field === 'table_mode') return from.startsWith('odds-values-') && ['current','history'].includes(event.value) ? event.value : row.table_mode;
  return position;
}
