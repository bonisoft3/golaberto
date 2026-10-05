(state, event) => {
  const row = state.items[0];
  if (!row || !String(event.from || '').startsWith('odds-graph-') || !Number.isFinite(event.pointerX)) return false;
  const index = Math.round(Math.max(0,Math.min(1,(event.pointerX * 0.64 - 52) / 574)) * row.snapshot_last);
  return index !== (row.snapshot_index < 0 ? row.snapshot_last : row.snapshot_index);
}
