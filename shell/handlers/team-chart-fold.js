(state) => {
  const view = state.rows.view?.[0];
  if (!view) return { updates: [] };
  const rows = state.items;
  const series = [];
  for (const teamId of [view.team_id, view.compare_id]) {
    if (series.some((item) => item.id === teamId)) continue;
    const own = rows.filter((row) => row.team_id === teamId);
    if (!own.length) continue;
    series.push({ id: teamId, label: own[0].team?.name || teamId, points: own.map((row) => view.metric === 'percent' ? {x:row.position,y:row.percent,label:String(row.position)} : { x: row.sequence, y: row.points, position: row.position, label: row.day, href: `${view.game_prefix}${row.game.slug}` }) });
  }
  const series_json = JSON.stringify({kind: view.metric === 'percent' ? 'bars' : 'line', ...(view.metric === 'percent' ? {yMin:0,yMax:100}:{}), invert: false, series});
  return { updates: series_json === view.series_json ? [] : [{op:'patch',entity:'team_chart_state',id:view.id,row:{series_json}}] };
}
