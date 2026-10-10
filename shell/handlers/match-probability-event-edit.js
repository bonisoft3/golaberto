(state, event, params) => {
  const row = state.items[0];
  if (!row) throw new Error("Hypothetical match event is missing");
  if (params.field === "side") {
    return event.from === `${row.id}-side` &&
        (event.value === "home" || event.value === "away")
      ? event.value
      : row.side;
  }
  if (params.field === "minute") {
    return event.from === `${row.id}-minute` &&
        Number.isInteger(event.valueAsNumber) &&
        event.valueAsNumber >= 0 && event.valueAsNumber <= 130
      ? event.valueAsNumber
      : row.minute;
  }
  if (params.field === "remove") return event.from === `${row.id}-remove`;
  throw new RangeError("Unknown hypothetical event field");
}
