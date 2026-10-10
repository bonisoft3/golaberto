(state, event) => {
  const row = state.items[0];
  const index = Number(event.value);
  const applies = row && String(event.from || '').startsWith('odds-date-') && typeof event.value === 'string' && event.value !== '' && Number.isInteger(index) && index >= 0 && index <= row.snapshot_last;
  return applies ? index : row?.snapshot_index ?? -1;
}
