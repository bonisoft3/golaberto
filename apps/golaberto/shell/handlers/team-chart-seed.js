(state) => {
  if (state.rows.stored?.length || !state.items[0]) return {updates:[]};
  const {id,...row}=state.items[0];
  return {updates:[{op:'put',entity:'team_chart_state',id,row}]};
}
