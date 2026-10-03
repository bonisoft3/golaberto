// golaberto handler country-option (ir: handler-country-option): select a
// fixed country from the current list, keeping other directory filters.
(state, event) => ({
  updates: event.type === "click" && state.items.some(country => country.id === event.id)
    ? [{op: "patch", entity: "directory_filter", id: "teams", row: {
      country_selection: event.id, country: "", country_key: "",
      offset: 0, next_offset: 40, page: 1,
    }}]
    : [],
})
