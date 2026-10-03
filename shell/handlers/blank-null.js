// golaberto handler blank-null (ir: handler-blank-null): an optional choice
// the editor left unset — a select's empty option — is no value, not an empty
// one, so the game's reference is cleared rather than pointed at "".
(state, event) => (event.value === "" ? null : event.value)
