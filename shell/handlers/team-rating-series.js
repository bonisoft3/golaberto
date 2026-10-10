(state) => {
  const view = state.rows.view?.[0];
  const series = state.items[0];
  const series_json = series?.series_json ?? "{}";
  // A page row exists only once stored; the first paint stores it with the
  // fallback the paged read declares, or the series would wait for a click.
  if (!view) {
    if (!series) return { updates: [] };
    return {
      updates: [{
        op: "put",
        entity: "archive_page",
        id: `team-rating-history-${series.team_id}`,
        row: {
          owner_id: series.team_id, offset: 0, next_offset: 40, page: 1,
          state: "browsing", period: series.period, date_from: "", date_to: "",
          series_json,
        },
      }],
    };
  }
  return series_json === view.series_json ? { updates: [] } : {
    updates: [{
      op: "patch",
      entity: "archive_page",
      id: view.id,
      row: { series_json },
    }],
  };
}
