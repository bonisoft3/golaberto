(state) => {
  const stored = state.rows.view?.[0];
  const seed = state.items.find(row => typeof row.id === 'string' && row.id.includes(':') && row.group_id && row.team_id);
  const view = stored || seed;
  if (!view) return {updates: []};
  const positions = (state.rows.positions || []).map(({position,percent,current,reach}) => ({position,percent,current,reach})).sort((a,b) => a.position-b.position);
  const zones = (state.rows.zones || []).map(({id,name,color,first,last,positions}) => ({id,name,color,first,last,positions})).sort((a,b) => (a.first-b.first) || (a.last-b.last) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const current_json = JSON.stringify({positions,zones});
  const position_last = Math.max(0,...positions.map(row => row.position));
  const position_number = positions.some(row => row.position === view.position_number) ? view.position_number : positions.find(row => row.current)?.position ?? positions[0]?.position ?? -1;
  const table_mode = view.table_mode === 'history' ? 'history' : 'current';
  const series_json = state.rows.history?.[0]?.series_json || '{}';
  const payload = JSON.parse(series_json);
  const count = payload.snapshots?.length ?? 0;
  const history_zones = payload.zones ?? [];
  const snapshot_last = Math.min(359,Math.max(0,count-1));
  // A reader on the latest day stays on the latest day as captures arrive.
  const follows = view.snapshot_index < 0 || view.snapshot_index >= view.snapshot_last;
  const snapshot_index = count ? (follows ? snapshot_last : Math.min(view.snapshot_index,snapshot_last)) : -1;
  const zone_id = history_zones.some(zone => zone.id === view.zone_id) ? view.zone_id : '*';
  const patch = {current_json,position_last,position_number,table_mode,series_json,snapshot_last,snapshot_index,zone_id};
  if (stored) {
    if (Object.entries(patch).every(([key,value]) => stored[key] === value)) return {updates: []};
    return {updates:[{op:'patch',entity:'team_odds_progress_state',id:view.id,row:patch}]};
  }
  return {updates:[{op:'put',entity:'team_odds_progress_state',id:view.id,row:{group_id:view.group_id,team_id:view.team_id,state:'viewing',pointer_x:1000,range_from:'',range_to:'',...patch}}]};
}
