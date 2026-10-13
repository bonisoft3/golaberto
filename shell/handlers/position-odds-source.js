(state) => {
  const stored = state.rows.view?.[0];
  const view = stored || state.items.find(row => typeof row.id === 'string' && row.id.includes(':') && row.group_id && row.team_id);
  if (!view) return {updates: []};
  const positions = (state.rows.positions || []).map(({position,percent,current,reach}) => ({position,percent,current,reach})).sort((a,b) => a.position-b.position);
  const zones = (state.rows.zones || []).map(({id,name,color,first,last,positions}) => ({id,name,color,first,last,positions})).sort((a,b) => (a.first-b.first) || (a.last-b.last) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const current_json = JSON.stringify({positions,zones});
  const series_json = state.rows.history?.[0]?.series_json || '{}';
  if (stored?.current_json === current_json && stored?.series_json === series_json) return {updates: []};
  return {updates: [{op:'put',entity:'team_odds_progress_source',id:view.id,row:{group_id:view.group_id,team_id:view.team_id,current_json,series_json}}]};
}
