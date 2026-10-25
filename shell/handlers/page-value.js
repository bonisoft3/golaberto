(state, _event, params) => {
  const row = state.items[0];
  const page = Math.max(1, row.page + params.step / 40);
  const origin = row.page_origin ?? 0;
  const originPage = Math.ceil(origin / 40) + 1;
  const offset = Math.max(0, origin + (page - originPage) * 40);
  const nextOffset = Math.max(0, origin + (page - originPage + 1) * 40);
  if (params.field === "page") return page;
  if (params.field === "page_size") return nextOffset - offset;
  if (params.field === "next_offset") return nextOffset;
  return offset;
}
