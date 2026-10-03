// golaberto handler both-scored (ir: handler-both-scored): a game is played
// exactly when both sides have a score (the game's own check), so typing one
// score decides it from that score and the other side's, already in the draft.
(state, event, params) => {
  const other = state.items[0]?.[params.other];
  return typeof event.value === "string" && /^\d+$/.test(event.value.trim()) && other !== null && other !== undefined;
}
