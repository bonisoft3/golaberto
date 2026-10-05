(state, event, params) => {
  const row = state.items[0];
  const applies = row && String(event.from || '').startsWith('odds-graph-') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key);
  if (params?.guard) return Boolean(applies);
  if (!applies) return row?.snapshot_index ?? -1;
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return row.snapshot_last;
  const index = row.snapshot_index < 0 ? row.snapshot_last : row.snapshot_index;
  return Math.max(0, Math.min(row.snapshot_last, index + (event.key === 'ArrowLeft' ? -1 : 1)));
}
