const SEP = "\u001f";
const SVG_W = 640;
const SVG_H = 300;
const LEFT = 48;
const RIGHT = 16;
const TOP = 18;
const BOTTOM = 34;
const PLOT_W = SVG_W - LEFT - RIGHT;
const PLOT_H = SVG_H - TOP - BOTTOM;

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function bounded(value, low, high, label, integer = false) {
  finite(value, label);
  if (value < low || value > high || (integer && !Number.isInteger(value))) {
    throw new RangeError(
      `${label} must be ${
        integer ? "an integer " : ""
      }between ${low} and ${high}`,
    );
  }
  return value;
}

function means(powers) {
  if (!powers || typeof powers !== "object") {
    throw new TypeError("powers are required");
  }
  bounded(powers.home, 0.01, 10, "home power");
  bounded(powers.away, 0.01, 10, "away power");
}

function poisson(mean, last) {
  const probabilities = [Math.exp(-mean)];
  for (let count = 1; count <= last; count++) {
    probabilities.push(probabilities[count - 1] * mean / count);
  }
  return probabilities;
}

function totals(home, draw, away) {
  return { home, draw, away };
}

function prematchOdds(powers) {
  means(powers);
  const homeGoals = poisson(powers.home, 19);
  const awayGoals = poisson(powers.away, 19);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const probability = homeGoals[i] * awayGoals[j];
      if (i > j) home += probability;
      else if (i < j) away += probability;
      else draw += probability;
    }
  }
  return totals(home, draw, away);
}

// A payload carries at most 100 recorded events of a kind, and a scenario adds
// at most 20 hypothetical ones to them.
function events(rows, label, limit = 120) {
  if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array`);
  if (rows.length > limit) {
    throw new RangeError(`${label} exceeds the event limit`);
  }
  return rows.map((event) => {
    if (!event || (event.side !== "home" && event.side !== "away")) {
      throw new RangeError(`${label} side must be home or away`);
    }
    bounded(event.minute, 0, 130, `${label} minute`, true);
    return { side: event.side, minute: event.minute };
  });
}

function scenario(options) {
  const addedTime = bounded(options.addedTime ?? 5, 0, 40, "added time", true);
  return {
    duration: 90 + addedTime,
    goals: events(options.goals ?? [], "goal"),
    redCards: events(options.redCards ?? [], "red card"),
  };
}

function at(powers, state, minute) {
  bounded(minute, 0, state.duration, "minute");
  const score = { home: 0, away: 0 };
  const reds = { home: 0, away: 0 };
  for (const event of state.goals) {
    if (event.minute <= minute) score[event.side]++;
  }
  for (const event of state.redCards) {
    if (event.minute <= minute) reds[event.side]++;
  }
  const remaining = (state.duration - minute) / 95;
  const homeMean = powers.home * 0.8 ** reds.home * 1.25 ** reds.away *
    remaining;
  const awayMean = powers.away * 1.25 ** reds.home * 0.8 ** reds.away *
    remaining;
  finite(homeMean, "remaining home power");
  finite(awayMean, "remaining away power");
  const homeLead = Math.max(score.home - score.away, 0);
  const awayLead = Math.max(score.away - score.home, 0);
  const homeGoals = poisson(homeMean, 19 + awayLead);
  const awayGoals = poisson(awayMean, 19 + homeLead);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < 20; i++) {
    if (i >= awayLead) {
      for (let j = 0; j < i + homeLead - awayLead; j++) {
        home += homeGoals[i] * awayGoals[j];
      }
    }
    draw += homeGoals[i + awayLead] * awayGoals[i + homeLead];
    if (i >= homeLead) {
      for (let j = 0; j < i + awayLead - homeLead; j++) {
        away += homeGoals[j] * awayGoals[i];
      }
    }
  }
  return {
    minute,
    score,
    redCards: reds,
    remainingPower: { home: homeMean, away: awayMean },
    odds: totals(home, draw, away),
  };
}

function scenarioAt(powers, options = {}) {
  means(powers);
  const state = scenario(options);
  const minute = options.minute ?? 0;
  bounded(minute, 0, state.duration, "minute");
  return at(powers, state, minute);
}

function scenarioTimeline(powers, options = {}) {
  means(powers);
  const state = scenario(options);
  return Array.from(
    { length: state.duration + 1 },
    (_, minute) => at(powers, state, minute),
  );
}

function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function integer(raw, low, high) {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= low && value <= high
    ? value
    : null;
}

function percentage(value, locale) {
  finite(value, "probability");
  const text = (value * 100).toFixed(1);
  return `${
    /^(pt|es|it|de|fr)/i.test(locale) ? text.replace(".", ",") : text
  }%`;
}

function hypothetical(raw) {
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new TypeError("Hypothetical match events must be an array");
  }
  if (rows.length > 20) {
    throw new RangeError("Hypothetical match events exceed the event limit");
  }
  return rows.map((event) => {
    if (
      !event || typeof event.id !== "string" ||
      !Number.isInteger(event.sequence) || event.sequence < 1 ||
      (event.kind !== "goal" && event.kind !== "red_card") ||
      (event.side !== "home" && event.side !== "away") ||
      !Number.isInteger(event.minute) || event.minute < 0 || event.minute > 130
    ) {
      throw new RangeError("Hypothetical match event is invalid");
    }
    return event;
  });
}

function unavailable(message) {
  return [
    element("div", {
      class: "match-probability match-probability--unavailable",
    }, [
      element("p", { class: "match-probability__unavailable" }, [message]),
    ]),
  ];
}

function probabilityList(labels, odds, locale, className) {
  return element("ul", { class: className }, [
    element("li", { class: "match-probability__home" }, [
      element("span", {}, [labels.home]),
      element("strong", {}, [percentage(odds.home, locale)]),
    ]),
    element("li", { class: "match-probability__draw" }, [
      element("span", {}, [labels.draw]),
      element("strong", {}, [percentage(odds.draw, locale)]),
    ]),
    element("li", { class: "match-probability__away" }, [
      element("span", {}, [labels.away]),
      element("strong", {}, [percentage(odds.away, locale)]),
    ]),
  ]);
}

function timelineChart(timeline, selected, labels, locale, eventMinutes) {
  const duration = timeline.length - 1;
  const xAt = (minute) => LEFT + minute / duration * PLOT_W;
  const yAt = (probability) => TOP + (1 - probability) * PLOT_H;
  const children = [element("title", {}, [labels.timeline])];
  for (let tick = 0; tick <= 4; tick++) {
    const probability = 1 - tick / 4;
    const y = TOP + tick / 4 * PLOT_H;
    children.push(
      element("line", {
        class: "team-chart__grid",
        x1: LEFT,
        y1: y,
        x2: SVG_W - RIGHT,
        y2: y,
      }),
    );
    children.push(
      element("text", {
        class: "team-chart__axis-value",
        x: LEFT - 7,
        y: y + 4,
        "text-anchor": "end",
      // Quarter ticks are whole percentages, and "100,0%" outgrows the margin.
      }, [`${probability * 100}%`]),
    );
  }
  children.push(
    element("line", {
      class: "team-chart__axis",
      x1: LEFT,
      y1: TOP + PLOT_H,
      x2: SVG_W - RIGHT,
      y2: TOP + PLOT_H,
    }),
  );
  children.push(
    element("text", {
      class: "team-chart__axis-value",
      x: LEFT,
      y: SVG_H - 9,
      "text-anchor": "start",
    }, ["0"]),
  );
  children.push(
    element("text", {
      class: "team-chart__axis-value",
      x: SVG_W - RIGHT,
      y: SVG_H - 9,
      "text-anchor": "end",
    }, [String(duration)]),
  );
  for (
    const [key, label] of [["home", labels.home], ["draw", labels.draw], [
      "away",
      labels.away,
    ]]
  ) {
    children.push(element("polyline", {
      class:
        `team-chart__line match-probability__line match-probability__line--${key}`,
      points: timeline.map((point) =>
        `${xAt(point.minute)},${yAt(point.odds[key])}`
      ).join(" "),
      "aria-label": label,
    }));
  }
  for (const minute of eventMinutes) {
    if (minute <= duration) {
      children.push(element("line", {
        class: "match-probability__event",
        x1: xAt(minute),
        y1: TOP,
        x2: xAt(minute),
        y2: TOP + PLOT_H,
      }));
    }
  }
  const described = new Set([0, duration, selected.minute, ...eventMinutes]);
  for (let minute = 0; minute <= duration; minute += 5) described.add(minute);
  for (const minute of [...described].sort((a, b) => a - b)) {
    if (minute < 0 || minute > duration) continue;
    const point = timeline[minute];
    const description = `${labels.minute} ${minute}: ${labels.home} ${
      percentage(point.odds.home, locale)
    }, ${labels.draw} ${percentage(point.odds.draw, locale)}, ${labels.away} ${
      percentage(point.odds.away, locale)
    }`;
    children.push(element("circle", {
      class: "match-probability__point",
      cx: xAt(minute),
      cy: yAt(point.odds.home),
      r: minute === selected.minute ? 5 : 3,
      tabindex: 0,
      "aria-label": description,
      title: description,
    }, [element("title", {}, [description])]));
  }
  return element("figure", { class: "team-chart match-probability__chart" }, [
    element("figcaption", { class: "team-chart__title" }, [labels.timeline]),
    element("svg", {
      class: "team-chart__svg",
      viewBox: `0 0 ${SVG_W} ${SVG_H}`,
      role: "img",
      lang: locale,
      "aria-label": labels.timeline,
    }, children),
  ]);
}

export default function render(value) {
  const parts = String(value ?? "").split(SEP);
  if (parts.length !== 17) {
    throw new Error("Match probability payload is incomplete");
  }
  const [
    raw,
    minuteRaw,
    addedRaw,
    hypotheticalRaw,
    home,
    away,
    draw,
    prematch,
    ratedOn,
    timelineLabel,
    missingRating,
    ambiguousRating,
    unknownMinute,
    eventLimit,
    invalidScenario,
    locale,
    minuteLabel,
  ] = parts;
  // The scenario row carries no payload until the game's probabilities are
  // folded onto it; the source region says when the game has none.
  if (raw === "") return [];
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== "object") {
    throw new Error("Match probability payload is not an object");
  }
  if (payload.rating_status === "missing-rating") {
    return unavailable(missingRating);
  }
  if (payload.rating_status === "ambiguous-rating") {
    return unavailable(ambiguousRating);
  }
  if (payload.rating_status !== "available") {
    throw new Error("Unknown match rating status");
  }
  const powers = { home: payload.home_power, away: payload.away_power };
  means(powers);
  const labels = {
    home,
    away,
    draw,
    timeline: timelineLabel,
    minute: minuteLabel,
  };
  const children = [
    element("h3", {}, [prematch]),
    probabilityList(
      labels,
      prematchOdds(powers),
      locale,
      "match-probability__prematch",
    ),
    element("p", { class: "match-probability__rating-dates" }, [
      `${ratedOn}: ${home} ${payload.home_measure_date}; ${away} ${payload.away_measure_date}`,
    ]),
  ];
  if (payload.timeline_status !== "available") {
    const message = payload.timeline_status === "unknown-event-minute"
      ? unknownMinute
      : payload.timeline_status === "event-limit"
      ? eventLimit
      : payload.timeline_status === "missing-rating"
      ? missingRating
      : payload.timeline_status === "ambiguous-rating"
      ? ambiguousRating
      : null;
    if (message === null) throw new Error("Unknown match timeline status");
    children.push(
      element("p", {
        class: "match-probability__timeline-unavailable",
      }, [message]),
    );
    return [element("div", { class: "match-probability" }, children)];
  }
  const minute = integer(minuteRaw, 0, 130);
  const addedTime = integer(addedRaw, 0, 40);
  if (
    [minute, addedTime].some((item) => item === null) ||
    minute > 90 + addedTime
  ) {
    children.push(
      element("p", {
        class: "match-probability__scenario-error",
      }, [invalidScenario]),
    );
    return [element("div", { class: "match-probability" }, children)];
  }
  const additions = hypothetical(hypotheticalRaw);
  // An event after the final whistle would never count; the reader is told
  // rather than shown a timeline that silently ignores it.
  if (additions.some((event) => event.minute > 90 + addedTime)) {
    children.push(
      element("p", {
        class: "match-probability__scenario-error",
      }, [invalidScenario]),
    );
    return [element("div", { class: "match-probability" }, children)];
  }
  const goals = events(payload.goals, "goal", 100).concat(
    additions.filter((event) => event.kind === "goal"),
  );
  const redCards = events(payload.red_cards, "red card", 100).concat(
    additions.filter((event) => event.kind === "red_card"),
  );
  const options = { minute, addedTime, goals, redCards };
  const selected = scenarioAt(powers, options);
  const timeline = scenarioTimeline(powers, options);
  children.push(element("p", { class: "match-probability__snapshot" }, [
    `${minuteLabel} ${minute}: ${home} ${
      percentage(selected.odds.home, locale)
    } · ${draw} ${percentage(selected.odds.draw, locale)} · ${away} ${
      percentage(selected.odds.away, locale)
    }`,
  ]));
  const eventMinutes = [
    ...new Set([...goals, ...redCards].map((event) => event.minute)),
  ].sort((a, b) => a - b);
  children.push(
    timelineChart(timeline, selected, labels, locale, eventMinutes),
  );
  return [element("div", { class: "match-probability" }, children)];
}

render.prematchOdds = prematchOdds;
render.scenarioAt = scenarioAt;
render.scenarioTimeline = scenarioTimeline;
render;
