(state) => {
  const source = state.items[0];
  if (!source) return {updates: []};
  let count = 0;
  let zones = [];
  try { const payload = JSON.parse(source.series_json); count = payload.snapshots.length; zones = payload.zones || []; } catch {}
  const snapshot_last = Math.min(359, Math.max(0, count - 1));
  const view = state.rows.view?.[0];
  if (view) {
    const zone_id = zones.some(zone => zone.id === view.zone_id) ? view.zone_id : '*';
    if (view.zone_id === zone_id && view.series_json === source.series_json && view.snapshot_last === snapshot_last) return {updates: []};
    return {updates: [{op:'patch', entity:'team_odds_progress_state', id:source.id, row:{series_json:source.series_json,zone_id,snapshot_last,snapshot_index:view.snapshot_index < 0 ? snapshot_last : Math.min(view.snapshot_index,snapshot_last)}}]};
  }
  return {updates:[{op:'put',entity:'team_odds_progress_state',id:source.id,row:{group_id:source.group_id,team_id:source.team_id,state:'viewing',zone_id:'*',snapshot_index:snapshot_last,snapshot_last,pointer_x:1000,series_json:source.series_json,current_json:'{}',position_number:-1,position_last:0,table_mode:'current'}}]};
}
