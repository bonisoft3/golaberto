(_state, event, params) => {
  const row = _state.items[0];
  const values = [event.value, row?.[params.other]];
  return values.every((value) =>
    value !== null && value !== undefined && /^\d+$/.test(String(value).trim())
  );
}
