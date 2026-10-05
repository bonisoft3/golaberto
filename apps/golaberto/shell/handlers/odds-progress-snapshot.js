(state, event, params) => {
  const row = state.items[0];
  const index = Number(event.value);
  const applies = row && !String(event.from || '').startsWith('position-') && typeof event.value === 'string' && event.value !== '' && Number.isInteger(index) && index >= 0 && index <= row.snapshot_last && index !== row.snapshot_index;
  if (params?.guard) return Boolean(applies);
  return applies ? index : row?.snapshot_index ?? -1;
}
