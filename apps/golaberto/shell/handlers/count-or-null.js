// golaberto handler count-or-null (ir: handler-count-or-null): a score, a
// minute or a crowd typed by the editor, as the integer the game stores; a
// cleared box, or an event carrying no value, states that the count is unknown.
// Anything but digits is not a count, and is refused rather than stored.
(state, event) => {
  if (typeof event.value !== "string" || event.value.trim() === "") return null;
  if (!/^\d+$/.test(event.value.trim())) throw new Error(`not a count: ${event.value}`);
  return Number(event.value);
}
