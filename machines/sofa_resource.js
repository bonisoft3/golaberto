const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SETTLED = ["finished", "cancelled", "abandoned", "awarded"];
const DETAILS = ["lineups", "incidents"];
// An incomplete detail is checked again after these, then given up.
const LADDER = [20 * MINUTE, 2 * HOUR, DAY, 7 * DAY];
// An answer the stack never delivered frees its resource after this.
const STUCK = 30 * MINUTE;
const RETRY_FLOOR = 30000;
// A refusal without Retry-After waits a minute, doubling to 4 hours 16 minutes.
const BACKOFF = [60, 120, 240, 480, 960, 1920, 3840, 7680, 15360];

// When the soonest still-owed event needs its round asked again.
const roundDue = (owed, now) => {
  const today = Math.floor(now / DAY) * DAY;
  return owed.filter(e => !SETTLED.includes(e.status)).reduce((soonest, e) => {
    const next = e.status === "postponed" && e.kickoff === 0 ? now + DAY
      : e.kickoff === 0 ? now + (e.day <= today ? 20 * MINUTE : 4 * HOUR)
      : e.kickoff <= now ? now + 20 * MINUTE
      : e.kickoff - now <= DAY ? Math.min(e.kickoff, now + 4 * HOUR)
      : e.kickoff - now <= 7 * DAY ? now + DAY
      : now + 7 * DAY;
    return Math.min(soonest, next);
  }, now + 7 * DAY);
};

// After its championship's last day a season's rounds wait out thirty more
// days, then are audited weekly while fixtures stay unresolved.
const season = (state, p, due, now) => {
  if (!["rounds", "round"].includes(state.family) || p.fixtures || p.ends === 0 || now < p.ends + DAY) return due;
  const closing = p.ends + 30 * DAY;
  if (now < closing) return p.unresolved && due > 0 ? Math.min(due, closing) : closing;
  return p.unresolved ? now + 7 * DAY : 0;
};

// What an answer makes of the resource, before its cache holds it back.
const answered = (state, p, now) => {
  if (DETAILS.includes(state.family)) {
    const checks = state.checks + 1;
    if (p.complete) {
      const done = state.complete_checks + 1;
      return {due: done === 1 ? now + DAY : 0, checks, complete_checks: done, complete: true, settled: state.settled};
    }
    return {due: checks <= LADDER.length ? now + LADDER[checks - 1] : 0, checks, complete_checks: state.complete_checks, complete: false, settled: state.settled};
  }
  const kept = {checks: state.checks, complete_checks: state.complete_checks, complete: state.complete};
  if (state.family === "rounds") return {...kept, settled: state.settled, due: p.fixtures ? 0 : season(state, p, now + DAY, now)};
  let due = roundDue(p.owed, now);
  let settled = state.settled;
  if (state.family === "event" && p.unresolved && p.kept) due = Math.min(due, now + DAY);
  if (p.kept && p.terminal) {
    if (!settled) {
      due = p.unresolved ? Math.min(due, now + DAY) : now + DAY;
      settled = true;
    } else if (state.family === "event" && !p.unresolved) due = 0;
  } else if (p.kept) settled = false;
  if (p.fixtures && (state.family === "round" || !p.kept)) due = 0;
  return {...kept, settled, due: season(state, p, due, now)};
};

const next = ({context: state, event}) => {
  const p = event, now = event._time, step = answered(state, p, now);
  const due = step.due > 0 && p.max_age >= 0 ? Math.max(step.due, now + p.max_age * 1000) : step.due;
  return {...step, due};
};
return {
  initial: ({input}) => ({phase: "idle", family: input.family, due: input.owed.length ? roundDue(input.owed, input._time) : input.due, failures: 0, checks: 0, complete_checks: 0, complete: false, settled: false, status: 0}),
  invariant: state => (["done", "review"].includes(state.phase) ? state.due === 0 : ["acquiring", "idle", "backoff"].includes(state.phase) ? state.due > 0 : true)
    && (state.phase !== "review" || DETAILS.includes(state.family)),
  project: state => ({...state}),
  isDue: ({context: state, event}) => state.due > 0 && state.due <= event._time,
  // A detail with nothing left to ask is given up unless its pair settled
  // complete; one that failed five times is given up either way.
  givenUp: ({context: state}) => state.due === 0 && DETAILS.includes(state.family) && (!state.complete || state.failures > 0),
  finished: ({context: state}) => state.due === 0,
  admit: ({context: state, event}) => ({...state, due: event._time + STUCK}),
  answer: ({context: state, event}) => ({...state, ...next({context: state, event}), failures: 0, status: 0}),
  fail: ({context: state, event}) => {
    const p = event, now = event._time, failures = state.failures + 1;
    const retry = p.retry_at > 0 ? Math.max(now + RETRY_FLOOR, p.retry_at) : now + BACKOFF[Math.min(state.failures, BACKOFF.length - 1)] * 1000;
    return {...state, failures, status: p.status, due: DETAILS.includes(state.family) && failures >= 5 ? 0 : retry};
  },
  // A fixture seen again pulls an untroubled resource's next ask forward.
  hasten: ({context: state, event}) => {
    const due = roundDue(event.owed, event._time);
    return state.phase === "idle" && state.failures === 0 && state.due > due ? {...state, due} : state;
  },
  reopen: ({context: state, event}) => ({...state, due: event._time, checks: 0, complete_checks: 0, complete: false}),
  pair: ({context: state, event}) => ({...state, due: event._time + DAY, complete: true, complete_checks: 1}),
  stop: ({context: state}) => ({...state, due: 0}),
};
