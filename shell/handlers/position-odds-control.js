(state, event, params) => {
  const row = state.items[0];
  if (!row) return params?.field?.startsWith('guard') ? false : -1;
  const from = String(event.from || '');
  const graph = from.startsWith('position-graph-');
  const at = (pointerX) => Math.max(0,Math.min(1,(pointerX * .64 - 52) / 574));
  if (params?.field === 'table_mode') return from.startsWith('odds-values-') && ['current','history'].includes(event.value) ? event.value : row.table_mode;
  if (params?.field === 'guard-pointer' && !graph) {
    if (!from.startsWith('odds-graph-') || !Number.isFinite(event.pointerX)) return false;
    return Math.round(at(event.pointerX)*row.snapshot_last) !== (row.snapshot_index < 0 ? row.snapshot_last : row.snapshot_index);
  }
  let position = row.position_number;
  if (from.startsWith('position-slider-') && event.value !== '') {
    const value = Number(event.value);
    const positions = JSON.parse(row.current_json).positions ?? [];
    if (Number.isInteger(value) && positions.some(item => item.position === value)) position = value;
  } else if (graph && Number.isFinite(event.pointerX)) {
    const ordered = [...(JSON.parse(row.current_json).positions ?? [])].sort((a,b) => a.position-b.position);
    if (ordered.length) position = ordered[Math.min(ordered.length-1,Math.floor(at(event.pointerX)*ordered.length))].position;
  }
  if (params?.field === 'guard-pointer') return position !== row.position_number;
  return position;
}
