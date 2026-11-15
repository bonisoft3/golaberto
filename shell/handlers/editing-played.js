({ context, event }, params) => {
  const row = context.items[0];
  const values = [event.value, row?.[params.other]];
  return values.every((value) =>
    value !== null && value !== undefined && /^\d+$/.test(String(value).trim())
  );
}
