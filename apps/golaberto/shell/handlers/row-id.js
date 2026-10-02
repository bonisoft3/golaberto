// golaberto handler row-id (ir: handler-row-id): a guard — the click names a
// row: a goal's remove button, which carries the goal's id as its value and no
// id of its own. Every other control in the editor has an id (a select's value
// is a uuid too, and clicking it must not remove a goal).
(state, event) =>
  event.from === undefined && typeof event.value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.value)
