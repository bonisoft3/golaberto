({ context }) => {
  if (context.rows.stored?.length || !context.items[0]) return {updates:[]};
  const {id,...row}=context.items[0];
  return {updates:[{op:'put',entity:'team_chart_state',id,row}]};
}
