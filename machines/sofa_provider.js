const PAUSES = [401, 403];
const BLOCKS = 429;

return {
  initial: () => ({phase: "open", reason: "", until: 0, wait: 0}),
  invariant: state => state.phase === "judged" || ((state.phase === "blocked") === (state.until > 0) && (state.phase === "open") === (state.reason === "")),
  project: ({wait: _wait, ...state}) => state,
  isPaused: ({context: state}) => state.reason !== "" && state.until === 0,
  isBlocked: ({context: state}) => state.until > 0,
  // A pause outranks a block, which only an operator lifts; a block keeps its
  // latest instant; any other refusal leaves the standing as it was. Either
  // way the blocked state's timer, entered again, waits the time left.
  refuse: ({context: state, event}) => {
    const p = event;
    if (PAUSES.includes(p.status)) return {...state, reason: "HTTP " + p.status, until: 0, wait: 0};
    if (p.status === BLOCKS && p.until > 0 && !(state.reason !== "" && state.until === 0)) {
      const until = Math.max(state.until, p.until);
      return {...state, reason: "HTTP " + p.status, until, wait: Math.max(0, until - p._time)};
    }
    return {...state, wait: Math.max(0, state.until - p._time)};
  },
  resume: ({context: state}) => ({...state, reason: "", until: 0, wait: 0}),
};
