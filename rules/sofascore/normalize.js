// SofaScore responses normalized without I/O, reconciliation or a clock: the
// port of tools/sofascore/normalize.py, keeping its Python value semantics
// (truthiness, str(), json.dumps) where they decide an output. The calendar
// day is the database's: an event carries `start_at`, and SQL converts it
// in America/Sao_Paulo (sofa.event_day).

const fail = (message) => { throw new TypeError(message); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, missing = null) => (has(o, k) ? o[k] : missing);
// Python's truthiness, as `x or y` and `if x` read it.
const truthy = (v) => !(v === null || v === false || v === 0 || v === "" ||
  (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0));
// `obj.get(...)` on a value Python cannot call .get on raises.
const dict = (v) => (isObject(v) ? v : fail("value has no keys"));

const object = (value, name) => (isObject(value) ? value : fail(`${name} must be an object`));

const floatRepr = (v) => {
  const [mantissa, exp] = v.toExponential().split("e");
  const digits = mantissa.replace(".", "").replace("-", "");
  const e = Number(exp);
  const sign = v < 0 ? "-" : "";
  if (e < -4 || e >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (e < 0) return `${sign}0.${"0".repeat(-e - 1)}${digits}`;
  const whole = digits.padEnd(e + 1, "0");
  const frac = digits.slice(e + 1);
  return `${sign}${whole.slice(0, e + 1)}.${frac || "0"}`;
};
const numberStr = (v) => (Number.isInteger(v) ? BigInt(v).toString() : Number.isNaN(v) ? "nan" : !Number.isFinite(v) ? (v > 0 ? "inf" : "-inf") : floatRepr(v));
const quoteRepr = (s) => {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + q;
};
const repr = (v) => {
  if (typeof v === "string") return quoteRepr(v);
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (isObject(v)) return `{${Object.keys(v).map((k) => `${quoteRepr(k)}: ${repr(v[k])}`).join(", ")}}`;
  return str(v);
};
// Python's str().
const str = (v) => {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return numberStr(v);
  if (typeof v === "string") return v;
  return repr(v);
};
// json.dumps(value, sort_keys=True) with its default separators and ASCII escapes.
const jsonString = (s) => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
};
const dumps = (v) => {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return Number.isFinite(v) ? numberStr(v) : numberStr(v) === "nan" ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) return `[${v.map(dumps).join(", ")}]`;
  return `{${Object.keys(v).sort().map((k) => `${jsonString(k)}: ${dumps(v[k])}`).join(", ")}}`;
};

const MAX_ID = 2n ** 63n;
const id = (value) => {
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isInteger(value)) text = BigInt(value).toString();
  else return null;
  if (!text.trim() || !/^[0-9]+$/.test(text)) return null;
  const n = BigInt(text);
  return n > 0n && n < MAX_ID ? n.toString() : null;
};

const number = (value, name) =>
  (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fail(`${name} must be a nonnegative integer`));

// datetime.fromtimestamp(value, timezone.utc): microseconds rounded half to
// even, years 1 through 9999.
const pad = (n, w) => String(n).padStart(w, "0");
const instant = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("timestamp must be numeric");
  let seconds = Math.trunc(value);
  const scaled = (value - seconds) * 1e6;
  let micros = Math.round(scaled);
  // Math.round takes a half upward; an odd result steps down to the even one.
  if (Math.abs(scaled % 1) === 0.5 && micros % 2 !== 0) micros -= 1;
  if (micros >= 1000000) { seconds += 1; micros -= 1000000; } else if (micros < 0) { seconds -= 1; micros += 1000000; }
  const days = Math.floor(seconds / 86400);
  const rest = seconds - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  if (year < 1 || year > 9999) fail("timestamp out of range");
  const date = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const time = `${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor(rest / 60) % 60, 2)}:${pad(rest % 60, 2)}${micros ? `.${pad(micros, 6)}` : ""}`;
  return { date, iso: `${date}T${time}Z` };
};

const score = (s, keys) => {
  for (const key of keys) if (get(s, key) !== null) return number(s[key], key);
  return null;
};

const scores = (event) => {
  const both = ["homeScore", "awayScore"].map((key) => object(get(event, key, {}), key));
  let normal = both.map((s) => score(s, ["normaltime", "NORMAL_TIME", "FINAL_RESULT", "finalResult"]));
  const current = both.map((s) => score(s, ["current", "display"]));
  let pens = both.map((s) => score(s, ["penalties", "PENALTIES"]));
  let aet = both.map((s, i) => {
    const parts = ["extra1", "extra2"].map((key) => score(s, [key]));
    const total = score(s, ["afterExtraTime", "extraTime", "EXTRA_TIME", "overtime", "OVER_TIME"]);
    if (parts.some((v) => v !== null)) return parts.reduce((sum, v) => sum + (v ?? 0), 0);
    if (total !== null && normal[i] !== null && total >= normal[i]) return total - normal[i];
    return null;
  });
  const partial = (pair) => pair.some((v) => v !== null) && !pair.every((v) => v !== null);
  if (partial(aet)) aet = [null, null];
  if (partial(pens)) pens = [null, null];
  if (normal.every((v) => v === null) && ![...aet, ...pens].some((v) => v !== null)) normal = current;
  return { normal, aet, pens };
};

const STATUSES = {
  notstarted: "scheduled", inprogress: "in_progress", finished: "finished", postponed: "postponed",
  canceled: "cancelled", cancelled: "cancelled", abandoned: "abandoned", awarded: "awarded",
  interrupted: "in_progress", suspended: "in_progress",
};
const TERMINAL = ["finished", "cancelled", "abandoned", "awarded"];
const NONE = [null, null];

const normalizeEvents = (payload) => {
  object(payload, "payload");
  const events = get(payload, "events");
  if (!Array.isArray(events)) fail("events must be a list");
  return events.map((raw) => {
    object(raw, "event");
    const home = object(get(raw, "homeTeam"), "homeTeam");
    const away = object(get(raw, "awayTeam"), "awayTeam");
    const ids = [id(get(raw, "id")), id(get(home, "id")), id(get(away, "id"))];
    if (!ids.every((v) => v !== null) || ids[1] === ids[2] || typeof get(home, "name") !== "string" || typeof get(away, "name") !== "string") {
      fail("event must have distinct identified teams and names");
    }
    const statusData = object(get(raw, "status"), "status");
    const kind = get(statusData, "type");
    if (typeof kind !== "string") fail("status type must be a string");
    const description = str(get(statusData, "description", "")).toLowerCase();
    let status = has(STATUSES, kind.toLowerCase()) ? STATUSES[kind.toLowerCase()] : "unknown";
    if (description.includes("award") || description.includes("walkover")) status = "awarded";
    else if (description.includes("abandon")) status = "abandoned";
    const when = instant(get(raw, "startTimestamp"));
    const unknownTime = get(raw, "startTimeConfirmed") === false || get(raw, "timeConfirmed") === false ||
      get(raw, "startTimeTBD") === true || get(raw, "timeTBD") === true;
    let { normal, aet, pens } = status === "finished" ? scores(raw) : { normal: NONE, aet: NONE, pens: NONE };
    const played = status === "finished" && normal.every((v) => v !== null);
    if (!played) { normal = NONE; aet = NONE; pens = NONE; }
    const tournament = object(get(raw, "tournament", {}), "tournament");
    const roundInfo = object(get(raw, "roundInfo", {}), "roundInfo");
    const round = {};
    for (const k of ["slug", "prefix"]) if (truthy(get(roundInfo, k))) round[k] = roundInfo[k];
    return {
      external_id: ids[0], home_external_id: ids[1], away_external_id: ids[2],
      home: home.name, away: away.name,
      stage_id: id(get(tournament, "id")),
      season_id: id(get(dict(get(raw, "season", {})), "id")),
      unique_tournament_id: id(get(dict(get(tournament, "uniqueTournament", {})), "id")),
      stage_key: str(get(tournament, "id")) + (truthy(get(roundInfo, "slug")) || truthy(get(roundInfo, "prefix")) ? `|${dumps(round)}` : ""),
      round_key: get(roundInfo, "round"),
      start_at: when.iso,
      kickoff: unknownTime ? null : when.iso,
      status, played, terminal: TERMINAL.includes(status),
      home_score: normal[0], away_score: normal[1], home_aet: aet[0], away_aet: aet[1], home_pen: pens[0], away_pen: pens[1],
    };
  });
};

const minuteOf = (incident) => {
  let value = get(incident, "time");
  if (value === null && get(incident, "timeSeconds") !== null) value = Math.floor(number(incident.timeSeconds, "timeSeconds") / 60) + 1;
  return value === null ? null : number(value, "time");
};

const sideOf = (incident) => {
  const isHome = get(incident, "isHome");
  if (typeof isHome === "boolean") return isHome ? "home" : "away";
  const pos = get(incident, "pos");
  if (pos === 0 || pos === 1) return pos === 0 ? "home" : "away";
  return null;
};

// `(x or {}).get("id")`.
const refId = (value) => id(get(truthy(value) ? dict(value) : {}, "id"));

// The second key of Python's sort: `addedTime or 0`, where a bool compares as an int.
const sortAdded = (incident) => {
  const v = get(incident, "addedTime");
  if (!truthy(v)) return 0;
  if (typeof v === "boolean") return 1;
  return typeof v === "number" ? v : fail("addedTime must be comparable");
};

const normalizeDetails = (lineups, incidents, event) => {
  object(lineups, "lineups");
  object(incidents, "incidents");
  object(event, "event");
  const missing = [];
  const players = [];
  const appearances = [];
  const goals = [];
  const substitutions = [];
  const byId = new Map();
  const usedSubstitutes = new Set();
  if (!truthy(get(event, "played")) || get(event, "status") !== "finished") missing.push("event is not a played final");
  let incidentList = get(incidents, "incidents");
  if (incidentList === null) {
    missing.push("incidents missing");
    incidentList = [];
  } else if (!Array.isArray(incidentList)) fail("incidents must be a list");
  let end = get(event, "home_aet") !== null || get(event, "away_aet") !== null ? 120 : 90;
  for (const inc of incidentList) {
    object(inc, "incident");
    if (get(inc, "incidentType") === "period") {
      const minute = minuteOf(inc);
      if (minute !== null && minute > 90 && minute < 999) end = 120;
    }
  }
  for (const side of ["home", "away"]) {
    const lineup = get(lineups, side);
    if (lineup === null) { missing.push(`${side} lineup missing`); continue; }
    object(lineup, `${side} lineup`);
    const entries = get(lineup, "players");
    if (entries === null || (Array.isArray(entries) && entries.length === 0)) { missing.push(`${side} lineup empty or missing`); continue; }
    if (!Array.isArray(entries)) fail(`${side} players must be a list`);
    for (const entry of entries) {
      object(entry, "lineup entry");
      const p = object(get(entry, "player"), "lineup player");
      const pid = id(get(p, "id"));
      if (pid === null || typeof get(p, "name") !== "string" || typeof get(entry, "substitute") !== "boolean") {
        missing.push(`${side} lineup player incomplete`);
        continue;
      }
      if (byId.has(pid)) { missing.push(`duplicate player ${pid}`); continue; }
      const birth = get(p, "dateOfBirthTimestamp");
      const country = get(p, "country");
      if (country !== null) object(country, "country");
      players.push({
        external_id: pid,
        name: truthy(get(p, "shortName")) ? p.shortName : p.name,
        full_name: p.name,
        birth: birth !== null ? instant(birth).date : null,
        country: truthy(country) ? get(country, "name") : null,
        height: get(p, "height"),
        position: get(p, "position"),
      });
      const sub = entry.substitute;
      const statistics = get(entry, "statistics");
      if (statistics !== null) {
        object(statistics, "lineup statistics");
        const minutes = get(statistics, "minutesPlayed");
        if (minutes !== null && number(minutes, "minutesPlayed") > 0 && sub) usedSubstitutes.add(pid);
      }
      const appearance = { player_external_id: pid, side, on_minute: 0, off_minute: sub ? null : end, bench: sub, yellow: false, red: false };
      appearances.push(appearance);
      byId.set(pid, appearance);
    }
  }
  const keyed = incidentList.map((inc, index) => {
    const minute = minuteOf(inc);
    return { inc, index, minute: minute !== null ? minute : 999, added: sortAdded(inc) };
  });
  keyed.sort((a, b) => a.minute - b.minute || a.added - b.added || a.index - b.index);
  for (const { inc, index: order } of keyed) {
    const typ = get(inc, "incidentType");
    const cls = get(inc, "incidentClass");
    if (typ !== "goal" && typ !== "substitution" && typ !== "card") continue;
    const minute = minuteOf(inc);
    if (minute !== null && minute >= 999) continue;
    if (typ === "goal" && ["missed", "missedPenalty", "penaltyShootout"].includes(cls)) continue;
    const side = sideOf(inc);
    const added = get(inc, "addedTime");
    if (added !== null) number(added, "addedTime");
    const base = { external_id: id(get(inc, "id")), side, minute, added_time: added, period: get(inc, "period"), source_order: order };
    if (typ === "goal") {
      const pid = refId(get(inc, "player"));
      const own = cls === "ownGoal";
      const expectedSide = own && side !== null ? (side === "home" ? "away" : "home") : side;
      if (!["regular", "penalty", "ownGoal"].includes(cls) || minute === null || side === null || !byId.has(pid) || byId.get(pid).side !== expectedSide) {
        missing.push(`goal ${order} incomplete`);
      }
      goals.push({ ...base, player_external_id: pid, penalty: cls === "penalty", own_goal: own, aet: minute !== null && minute > 90 });
    } else if (typ === "substitution") {
      const incoming = refId(get(inc, "playerIn"));
      const outgoing = refId(get(inc, "playerOut"));
      substitutions.push({ ...base, player_off_external_id: outgoing, player_on_external_id: incoming });
      if (minute === null || side === null || !byId.has(incoming) || !byId.has(outgoing) || byId.get(incoming).side !== side ||
        byId.get(outgoing).side !== side || !byId.get(incoming).bench || byId.get(outgoing).bench) {
        missing.push(`substitution ${order} incomplete`);
        continue;
      }
      Object.assign(byId.get(incoming), { on_minute: minute, off_minute: end, bench: false });
      byId.get(outgoing).off_minute = minute;
    } else if (["yellow", "red", "yellowRed"].includes(cls)) {
      const p = get(inc, "player");
      if (p === null) continue;
      const pid = id(get(object(p, "card player"), "id"));
      if (!byId.has(pid) || side === null || byId.get(pid).side !== side || minute === null) {
        missing.push(`card ${order} incomplete`);
        continue;
      }
      const app = byId.get(pid);
      if (cls === "yellow" || cls === "yellowRed") app.yellow = true;
      if (cls === "red" || cls === "yellowRed") {
        app.red = true;
        if (!app.bench && app.off_minute !== null) app.off_minute = Math.min(app.off_minute, minute);
      }
    }
  }
  for (const pid of [...usedSubstitutes].sort()) {
    if (byId.get(pid).bench) missing.push(`substitute ${pid} played but substitution is missing`);
  }
  if (truthy(get(event, "played"))) {
    for (const side of ["home", "away"]) {
      const expected = get(event, `${side}_score`);
      const extra = truthy(get(event, `${side}_aet`)) ? event[`${side}_aet`] : 0;
      if (expected === null || goals.filter((g) => g.side === side).length !== expected + extra) {
        missing.push(`${side} goal count does not match final score`);
      }
    }
  }
  return { players, appearances, goals, substitutions, complete: missing.length === 0, missing };
};

(input) => {
  object(input, "input");
  if (input.kind === "events") return normalizeEvents(get(input, "payload"));
  if (input.kind === "details") return normalizeDetails(get(input, "lineups"), get(input, "incidents"), get(input, "event"));
  return fail("kind must be events or details");
};
