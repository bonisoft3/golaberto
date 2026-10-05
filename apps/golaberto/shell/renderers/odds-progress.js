// A team's probability history. The value is JSON and localized labels joined
// by the terminal's unit separator; this renderer only returns safe nodes.
const SEP = "\u001f";
const SVG_W = 640;
const SVG_H = 300;
const LEFT = 52;
const RIGHT = 14;
const TOP = 18;
const BOTTOM = 38;
const PLOT_W = SVG_W - LEFT - RIGHT;
const PLOT_H = SVG_H - TOP - BOTTOM;
const HEX_COLOR = /^#[0-9a-f]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function validDay(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function dateParts(day) {
  return day.split("-").map(Number);
}

// Numeric civil dates are stable across machines and do not depend on the
// browser's timezone, clock, DateStyle, or Intl implementation.
function formatDate(day, locale, short = false) {
  if (!validDay(day)) return "";
  const [year, month, date] = dateParts(day);
  const lang = locale.toLowerCase().split(/[-_]/)[0];
  const monthText = String(month).padStart(2, "0");
  const dayText = String(date).padStart(2, "0");
  if (lang === "en" && /^(en-us|en-ca)/i.test(locale)) {
    return short ? `${month}/${date}` : `${month}/${date}/${year}`;
  }
  return short ? `${dayText}/${monthText}` : `${dayText}/${monthText}/${year}`;
}

function numberText(value, locale) {
  const rounded = Math.round(value * 100) / 100;
  const text = String(rounded);
  return /^(pt|es|it|de|fr)([-_]|$)/i.test(locale)
    ? text.replace(".", ",")
    : text;
}

function validColor(value) {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function localGameHref(game, prefix = "/jogo/") {
  if (!game || typeof game.id !== "string" || !UUID.test(game.id)) return null;
  const route = prefix || "/jogo/";
  if (!route.startsWith("/") || route.startsWith("//") || !route.endsWith("/") || /[\u0000-\u0020\u007f\\]/.test(route)) return null;
  return `${route}${game.id}`;
}

function empty(title, missing) {
  return [element("div", { class: "team-odds-progress team-odds-progress--empty" }, [
    element("h3", { class: "team-odds-progress__title" }, [title]),
    ...(missing ? [element("p", { class: "team-odds-progress__note" }, [missing])] : []),
  ])];
}

function validChart(chart) {
  if (
    !chart || chart.version !== 1 || chart.kind !== "odds-progress" ||
    !integer(chart.positionCount) || chart.positionCount < 1 ||
    !integer(chart.sourceCount) || !integer(chart.retainedCount) ||
    !integer(chart.omittedCount) || !Array.isArray(chart.zones) ||
    !Array.isArray(chart.positions) || !Array.isArray(chart.snapshots) ||
    chart.positions.length !== chart.positionCount ||
    chart.snapshots.length > 360 || chart.retainedCount !== chart.snapshots.length
  ) return false;

  const zoneIds = new Set();
  for (const zone of chart.zones) {
    if (
      !zone || typeof zone.id !== "string" || typeof zone.name !== "string" ||
      zoneIds.has(zone.id) || !validColor(zone.color) ||
      !integer(zone.first) || !integer(zone.last) || zone.first < 1 ||
      zone.last < zone.first
    ) return false;
    zoneIds.add(zone.id);
  }

  let priorPosition = Infinity;
  for (const position of chart.positions) {
    if (
      !position || !integer(position.position) || position.position < 1 ||
      position.position >= priorPosition || !validColor(position.color) ||
      !Array.isArray(position.zoneIds) ||
      !position.zoneIds.every((id) => typeof id === "string" && zoneIds.has(id))
    ) return false;
    priorPosition = position.position;
  }
  if (chart.positions[0].position !== chart.positionCount || chart.positions.at(-1).position !== 1) {
    return false;
  }

  let previousDay = "";
  for (const snapshot of chart.snapshots) {
    if (
      !snapshot || !validDay(snapshot.day) || snapshot.day <= previousDay ||
      typeof snapshot.percentages !== "object" || snapshot.percentages === null ||
      Array.isArray(snapshot.percentages) ||
      typeof snapshot.zoneValues !== "object" || snapshot.zoneValues === null ||
      Array.isArray(snapshot.zoneValues)
    ) return false;
    previousDay = snapshot.day;
    let total = 0;
    for (const position of chart.positions) {
      const value = snapshot.percentages[String(position.position)];
      if (!finite(value) || value < 0 || value > 100) return false;
      total += value;
    }
    if (Math.abs(total - 100) > 0.0500001) return false;
    for (const zone of chart.zones) {
      if (!finite(snapshot.zoneValues[zone.id])) return false;
    }
    for (const game of snapshot.lastGame === null ? [] : [snapshot.lastGame]) {
      if (
        !game || typeof game.id !== "string" ||
        typeof game.homeName !== "string" || typeof game.awayName !== "string" ||
        (game.homeScore !== null && !finite(game.homeScore)) ||
        (game.awayScore !== null && !finite(game.awayScore))
      ) return false;
    }
  }
  return chart.sourceCount >= chart.retainedCount &&
    chart.omittedCount <= chart.sourceCount - chart.retainedCount;
}

function tickIndexes(count) {
  if (count <= 1) return count === 1 ? [0] : [];
  return [...new Set([0, Math.round((count - 1) / 3), Math.round(2 * (count - 1) / 3), count - 1])];
}

function xAt(index, count) {
  if (count === 1) return LEFT + PLOT_W / 2;
  return LEFT + index * PLOT_W / (count - 1);
}

function yAt(percent) {
  return TOP + (1 - percent / 100) * PLOT_H;
}

function titleNode(text) {
  return element("title", {}, [text]);
}

function areaPath(snapshots, position, lower) {
  const upperPoints = [];
  const lowerPoints = [];
  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i];
    const percent = snapshot.percentages[String(position.position)];
    const previous = lower[i];
    const high = previous + percent;
    const x = xAt(i, snapshots.length);
    upperPoints.push([x, yAt(high)]);
    lowerPoints.push([x, yAt(previous)]);
    lower[i] = high;
  }
  if (snapshots.length === 1) {
    const [xUpper, yUpper] = upperPoints[0];
    const [xLower, yLower] = lowerPoints[0];
    const half = 3;
    return `M${xUpper - half},${yUpper} L${xUpper + half},${yUpper} L${xLower + half},${yLower} L${xLower - half},${yLower} Z`;
  }
  const path = [`M${upperPoints[0][0]},${upperPoints[0][1]}`];
  for (let i = 1; i < upperPoints.length; i += 1) {
    path.push(`L${upperPoints[i][0]},${upperPoints[i][1]}`);
  }
  for (let i = lowerPoints.length - 1; i >= 0; i -= 1) {
    path.push(`L${lowerPoints[i][0]},${lowerPoints[i][1]}`);
  }
  path.push("Z");
  return path.join(" ");
}

function gameText(game, missing) {
  const homeScore = game.homeScore === null ? missing : String(game.homeScore);
  const awayScore = game.awayScore === null ? missing : String(game.awayScore);
  return `${game.homeName} ${homeScore} × ${awayScore} ${game.awayName}`;
}

function gameCell(game, prefix, label, missing) {
  if (!game) return label;
  const text = gameText(game, missing);
  const children = [text];
  const href = localGameHref(game, prefix);
  return href
    ? element("a", { href, title: text }, children)
    : element("span", {}, children);
}

function zoneSwatch(zone) {
  return element("svg", {
    class: "team-odds-progress__swatch",
    viewBox: "0 0 12 12",
    width: "12",
    height: "12",
    "aria-hidden": "true",
    focusable: "false",
  }, [element("rect", {
    x: "1",
    y: "1",
    width: "10",
    height: "10",
    rx: "2",
    fill: zone.color,
  })]);
}

function summary(chart, samplingLabel, omittedLabel) {
  const children = [];
  const eligibleCount = chart.sourceCount - chart.omittedCount;
  if (samplingLabel && chart.retainedCount < eligibleCount) {
    children.push(element("span", {}, [samplingLabel, " ", `${chart.retainedCount}/${eligibleCount}`]));
  }
  if (omittedLabel && chart.omittedCount > 0) {
    children.push(element("span", {}, [omittedLabel, " ", String(chart.omittedCount)]));
  }
  return children.length
    ? element("p", { class: "team-odds-progress__note" }, children)
    : null;
}

function inspector(chart, snapshot, index, labels) {
  const date = formatDate(snapshot.day, labels.locale);
  const children = [element("p", { class: "team-odds-progress__inspector-date" }, [date])];
  const game = snapshot.lastGame;
  children.push(element("p", { class: "team-odds-progress__inspector-game" }, [
    ...(labels.gameLabel ? [element("span", {}, [labels.gameLabel, ": "])] : []),
    game ? gameCell(game, labels.gamePrefix, labels.noGameLabel, labels.noGameLabel) : labels.noGameLabel,
  ]));
  children.push(element("ul", { class: "team-odds-progress__values" }, chart.zones.map((zone) =>
    element("li", {}, [
      zoneSwatch(zone),
      element("span", { class: "team-odds-progress__zone-name" }, [zone.name]),
      element("strong", {}, [`${numberText(snapshot.zoneValues[zone.id], labels.locale)}%`]),
    ])
  )));
  return element("div", {
    class: "team-odds-progress__inspector",
    title: `${date} ${index + 1}/${chart.snapshots.length}`,
  }, children);
}

function graph(chart, selectedZoneId, selectedIndex, labels) {
  const selectedZone = chart.zones.find((zone) => zone.id === selectedZoneId);
  const filteredPositions = selectedZone
    ? chart.positions.filter((position) => position.zoneIds.includes(selectedZone.id))
    : chart.positions;
  if (!chart.snapshots.length || !filteredPositions.length) return null;

  const selected = selectedIndex >= 0 && selectedIndex < chart.snapshots.length
    ? selectedIndex
    : chart.snapshots.length - 1;
  const lower = chart.snapshots.map(() => 0);
  const paths = filteredPositions.map((position) => {
    const description = `${labels.positionLabel} ${position.position}`;
    return element("path", {
      class: "team-odds-progress__area",
      d: areaPath(chart.snapshots, position, lower),
      fill: position.color,
    }, [titleNode(description)]);
  });
  const children = [titleNode(labels.title), element("desc", {}, [labels.samplingLabel])];
  for (let tick = 0; tick <= 4; tick += 1) {
    const percent = 100 - tick * 25;
    const y = yAt(percent);
    children.push(element("line", {
      class: "team-odds-progress__grid",
      x1: LEFT,
      y1: y,
      x2: SVG_W - RIGHT,
      y2: y,
    }));
    children.push(element("text", {
      class: "team-odds-progress__axis-value",
      x: LEFT - 8,
      y: y + 4,
      "text-anchor": "end",
    }, [`${percent}%`]));
  }
  children.push(...paths);

  // One transparent, titled strip per exact observation preserves a native
  // hover label even when the calendar dates are denser than the axis labels.
  for (let index = 0; index < chart.snapshots.length; index += 1) {
    const x = xAt(index, chart.snapshots.length);
    const snapshot = chart.snapshots[index];
    children.push(element("line", {
      class: "team-odds-progress__date-hit",
      x1: x,
      y1: TOP,
      x2: x,
      y2: TOP + PLOT_H,
      "stroke-width": 8,
    }, [titleNode(formatDate(snapshot.day, labels.locale))]));
  }
  children.push(element("line", {
    class: "team-odds-progress__crosshair",
    x1: xAt(selected, chart.snapshots.length),
    y1: TOP,
    x2: xAt(selected, chart.snapshots.length),
    y2: TOP + PLOT_H,
  }));
  children.push(element("line", {
    class: "team-odds-progress__axis",
    x1: LEFT,
    y1: TOP,
    x2: LEFT,
    y2: TOP + PLOT_H,
  }));
  children.push(element("line", {
    class: "team-odds-progress__axis",
    x1: LEFT,
    y1: TOP + PLOT_H,
    x2: SVG_W - RIGHT,
    y2: TOP + PLOT_H,
  }));

  const ticks = tickIndexes(chart.snapshots.length);
  for (let i = 0; i < ticks.length; i += 1) {
    const index = ticks[i];
    const anchor = i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle";
    children.push(element("text", {
      class: "team-odds-progress__axis-value",
      x: xAt(index, chart.snapshots.length),
      y: SVG_H - 10,
      "text-anchor": anchor,
    }, [titleNode(formatDate(chart.snapshots[index].day, labels.locale)), formatDate(chart.snapshots[index].day, labels.locale, true)]));
  }

  return element("figure", { class: "team-odds-progress" }, [
    element("figcaption", { class: "team-odds-progress__title" }, [
      labels.title,
      ...(selectedZone ? [element("span", { class: "team-odds-progress__selected-zone" }, [
        zoneSwatch(selectedZone),
        selectedZone.name,
      ])] : []),
    ]),
    ...(labels.summary ? [labels.summary] : []),
    element("svg", {
      class: "team-odds-progress__svg",
      viewBox: `0 0 ${SVG_W} ${SVG_H}`,
      role: "group",
      lang: labels.locale,
    "aria-label": labels.title,
    focusable: "false",
  }, children),
  ]);
}

function historyTable(chart, selectedZoneId, labels) {
  const selectedZone = chart.zones.find((zone) => zone.id === selectedZoneId);
  const zones = selectedZone ? [selectedZone] : chart.zones;
  const positions = selectedZone
    ? chart.positions.filter((position) => position.zoneIds.includes(selectedZone.id))
    : chart.positions;
  const header = element("thead", {}, [element("tr", {}, [
    element("th", { scope: "col" }, [labels.dateLabel]),
    element("th", { scope: "col" }, [labels.gameLabel]),
    ...zones.map((zone) => element("th", { scope: "col" }, [zoneSwatch(zone), " ", zone.name])),
    ...positions.map((position) => element("th", { scope: "col" }, [
      `${labels.positionLabel} ${position.position}`,
    ])),
  ])]);
  const rows = chart.snapshots.map((snapshot) => element("tr", {}, [
    element("th", { scope: "row", title: formatDate(snapshot.day, labels.locale) }, [
      formatDate(snapshot.day, labels.locale),
    ]),
    element("td", {}, [gameCell(snapshot.lastGame, labels.gamePrefix, labels.noGameLabel, labels.noGameLabel)]),
    ...zones.map((zone) => element("td", {}, [
      `${numberText(snapshot.zoneValues[zone.id], labels.locale)}%`,
    ])),
    ...positions.map((position) => element("td", {}, [
      `${numberText(snapshot.percentages[String(position.position)], labels.locale)}%`,
    ])),
  ]));
  return element("table", { class: "team-odds-progress__table" }, [
    element("caption", {}, [labels.tableLabel]),
    header,
    element("tbody", {}, rows),
  ]);
}

export default function render(value) {
  const [
    raw,
    title = "",
    locale = "en-GB",
    missing = "",
    zoneId = "*",
    snapshotIndex = "-1",
    gamePrefix = "",
    tableLabel = "",
    positionLabel = "",
    samplingLabel = "",
    omittedLabel = "",
    mode = "graph",
    dateLabel = "",
    gameLabel = "",
    noGameLabel = missing,
  ] = String(value ?? "").split(SEP);
  if (!title) return [];

  let chart;
  try {
    chart = JSON.parse(raw);
  } catch {
    return empty(title, missing);
  }
  if (!validChart(chart)) return empty(title, missing);
  if (chart.snapshots.length === 0) return empty(title, missing);

  const parsedIndex = /^-?\d+$/.test(snapshotIndex) ? Number(snapshotIndex) : -1;
  const labels = {
    title,
    locale,
    missing,
    zoneId,
    gamePrefix,
    gameLabel,
    noGameLabel,
    tableLabel,
    positionLabel,
    samplingLabel,
    dateLabel,
    summary: summary(chart, samplingLabel, omittedLabel),
  };
  if (mode === "table") {
    return [element("figure", { class: "team-odds-progress team-odds-progress--table" }, [
      element("figcaption", { class: "team-odds-progress__title" }, [title]),
      ...(labels.summary ? [labels.summary] : []),
      historyTable(chart, zoneId, labels),
    ])];
  }

  const selected = parsedIndex >= 0 && parsedIndex < chart.snapshots.length
    ? parsedIndex
    : chart.snapshots.length - 1;
  if (mode === "inspector") {
    return [inspector(chart, chart.snapshots[selected], selected, labels)];
  }

  const figure = graph(chart, zoneId, parsedIndex, labels);
  return figure
    ? [figure]
    : empty(title, missing);
}

render;
