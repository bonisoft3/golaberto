(state) => {
  const view = state.rows.view?.[0];
  if (!view) return { updates: [] };
  if (state.items.length > 40) throw new Error("A player CSV page cannot exceed 40 rows");
  const fields = ["position", "played", "started", "came_on", "bench", "minutes", "goals", "goals_per90", "contribution", "contribution_per90", "off_rating", "def_rating", "penalties", "own_goals", "yellow", "red"];
  const csv_rows = JSON.stringify(state.items.map((row) => [
    row.player_name, row.championship?.season, row.championship_name, row.team_name,
    ...fields.map((field) => row[field] ?? null),
  ]));
  return { updates: csv_rows === view.csv_rows ? [] : [{ op: "patch", entity: "archive_page", id: view.id, row: { csv_rows } }] };
}
