(state, _event, params) => {
  const offset = Math.max(0, state.items[0].offset + params.step);
  if (params.field === "page") return offset / 40 + 1;
  if (params.field === "next_offset") return offset + 40;
  return offset;
}
