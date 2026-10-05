// Current finishing odds and one optional historical table, as safe nodes.
const SEP = "\u001f";
const LEFT = 52;
const WIDTH = 574;
const TOP = 16;
const HEIGHT = 160;

function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function validPosition(value) {
  return Number.isInteger(value) && value > 0;
}

function validProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100.5;
}

function positionsFrom(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const seen = new Set();
  for (const item of value) {
    if (!item || !validPosition(item.position) || seen.has(item.position) || !validProbability(item.percent)) return null;
    seen.add(item.position);
  }
  return [...value].sort((a, b) => a.position - b.position);
}

function percentText(value, locale) {
  // Keep small nonzero probabilities distinguishable from mathematical zero.
  const text = value > 0 && value < 0.01
    ? value.toExponential(2).replace(/\.?(0+)e/, "e")
    : String(Math.round(value * 100) / 100);
  return `${/^(pt|es|it|de|fr)([-_]|$)/i.test(locale) ? text.replace(".", ",") : text}%`;
}

function dateText(day, locale) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [year, month, date] = day.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || date < 1 || date > days[month - 1]) return "";
  return /^(en-us|en-ca)([-_]|$)/i.test(locale)
    ? `${month}/${date}/${year}`
    : `${String(date).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

function zoneContains(zone, position) {
  if (zone.positions_json === null || zone.positions_json === undefined) {
    return validPosition(zone.first) && validPosition(zone.last) && position >= zone.first && position <= zone.last;
  }
  const positions = typeof zone.positions_json === "string" ? parse(zone.positions_json) : zone.positions_json;
  return Array.isArray(positions) && positions.every(validPosition) && positions.includes(position);
}

function sourceZones(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(zone => zone && typeof zone.name === "string").sort((a, b) => {
    const order = (Number.isFinite(a.position) ? a.position : 0) - (Number.isFinite(b.position) ? b.position : 0);
    if (order) return order;
    const aId = String(a.id ?? ""), bId = String(b.id ?? "");
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

function selectedPosition(positions, raw) {
  const value = Number(raw);
  if (raw !== "" && Number.isFinite(value) && value > 0) {
    return positions.reduce((best, item) => Math.abs(item.position - value) < Math.abs(best.position - value) ? item : best);
  }
  return positions.find(item => item.current === true) ?? positions.reduce((best, item) => item.percent > best.percent ? item : best);
}

function reachText(item, labels) {
  if (item.percent !== 0) return "";
  return item.reach === "impossible" ? labels.impossible
    : item.reach === "reachable" ? labels.reachable
    : item.reach === "undecided" ? labels.undecided : "";
}

function description(item, zone, labels) {
  return [ `${labels.position} ${item.position}`, percentText(item.percent, labels.locale), zone?.name,
    item.current === true ? labels.currentPosition : "", reachText(item, labels),
  ].filter(Boolean).join(" · ");
}

function empty(labels, message, mode) {
  const note = element("p", { class: "position-odds__note" }, [message]);
  return mode === "graph"
    ? [element("figure", { class: "position-odds position-odds--empty" }, [element("figcaption", {}, [labels.title]), note])]
    : [note];
}

function table(positions, caption, labels) {
  return [element("table", { class: "position-odds__table" }, [
    element("caption", {}, [caption]),
    element("thead", {}, [element("tr", {}, [
      element("th", { scope: "col" }, [labels.position]),
      element("th", { scope: "col" }, [labels.probability]),
    ])]),
    element("tbody", {}, positions.map(item => element("tr", {}, [
      element("th", { scope: "row" }, [String(item.position)]),
      element("td", {}, [percentText(item.percent, labels.locale), ...(reachText(item, labels) ? [" · ", reachText(item, labels)] : [])]),
    ]))),
  ])];
}

export default function render(value) {
  const [raw, historyRaw, title = "", locale = "en-GB", missing = "", positionNumber = "", snapshotIndex = "",
    tableMode = "current", mode = "graph", position = "Position", probability = "Probability", currentPosition = "Current position",
    date = "Date", currentOdds = "Current odds", historicalSnapshot = "Historical snapshot", impossible = "Impossible",
    reachable = "Reachable", undecided = "Undecided", noHistory = "No history"] = String(value ?? "").split(SEP);
  const labels = { title, locale, position, probability, currentPosition, impossible, reachable, undecided };
  if (mode === "table" && tableMode === "history") {
    const history = parse(historyRaw);
    const snapshots = history?.snapshots;
    if (!Array.isArray(snapshots) || !snapshots.length) return empty(labels, noHistory, mode);
    const requested = Number(snapshotIndex);
    const index = snapshotIndex !== "" && Number.isInteger(requested) && requested >= 0
      ? Math.min(requested, snapshots.length - 1) : snapshots.length - 1;
    const snapshot = snapshots[index];
    const day = dateText(snapshot?.day, locale);
    const percentages = snapshot?.percentages;
    const historyPositions = Array.isArray(history.positions) ? history.positions : [];
    const positions = positionsFrom(historyPositions.map(item => ({ position: item?.position, percent: percentages?.[String(item?.position)] })));
    if (!day || !positions) return empty(labels, noHistory, mode);
    return table(positions, `${historicalSnapshot} · ${date}: ${day}`, labels);
  }

  const chart = parse(raw);
  const positions = positionsFrom(chart?.positions);
  if (!positions) return empty(labels, missing, mode);
  if (mode === "table") return table(positions, currentOdds, labels);
  const zones = sourceZones(chart.zones);
  const zoneFor = item => zones.find(zone => zoneContains(zone, item.position));
  const selected = selectedPosition(positions, positionNumber);
  if (mode === "inspector") return [element("div", { class: "position-odds__inspector" }, [
    element("strong", {}, [`${position} ${selected.position}`]),
    element("span", {}, [percentText(selected.percent, locale)]),
    ...(zoneFor(selected) ? [element("span", { class: "position-odds__zone-name" }, [zoneFor(selected).name])] : []),
    ...(selected.current === true ? [element("span", {}, [currentPosition])] : []),
    ...(reachText(selected, labels) ? [element("span", {}, [reachText(selected, labels)])] : []),
  ])];

  const slot = WIDTH / positions.length;
  const bottom = TOP + HEIGHT;
  const nodes = [element("title", {}, [title])];
  for (let index = 0; index < positions.length; index += 1) {
    const zone = zoneFor(positions[index]);
    if (zone && typeof zone.color === "string" && /^#[0-9a-f]{6}$/i.test(zone.color)) {
      nodes.push(element("rect", { class: "position-odds__band", x: LEFT + index * slot, y: TOP, width: slot, height: HEIGHT, fill: zone.color }, [element("title", {}, [zone.name])]));
    }
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = TOP + HEIGHT * tick / 4;
    nodes.push(element("line", { class: "position-odds__grid", x1: LEFT, x2: LEFT + WIDTH, y1: y, y2: y }));
    nodes.push(element("text", { class: "position-odds__axis-value", x: LEFT - 8, y: y + 4, "text-anchor": "end" }, [`${100 - tick * 25}%`]));
  }
  for (let index = 0; index < positions.length; index += 1) {
    const item = positions[index];
    const x = LEFT + (index + 0.5) * slot;
    const height = item.percent / 100 * HEIGHT;
    const text = description(item, zoneFor(item), labels);
    nodes.push(element("rect", { class: `position-odds__bar${item === selected ? " position-odds__bar--selected" : ""}`, x: x - slot * 0.31, y: bottom - height, width: slot * 0.62, height, title: text }, [element("title", {}, [text])]));
    nodes.push(element("text", { class: `position-odds__axis-value position-odds__tick${index % 2 === 1 && index !== positions.length - 1 ? " position-odds__tick--dense" : ""}`, x, y: bottom + 19, "text-anchor": "middle" }, [String(item.position)]));
    if (item.current === true) nodes.push(element("line", { class: "position-odds__current", x1: x, x2: x, y1: TOP, y2: bottom, "aria-label": `${currentPosition}: ${item.position}` }, [element("title", {}, [`${currentPosition}: ${item.position}`])]));
  }
  return [element("figure", { class: "position-odds" }, [
    element("figcaption", { class: "position-odds__title" }, [title]),
    element("svg", { class: "position-odds__svg", viewBox: "0 0 640 220", role: "img", lang: locale, "aria-label": title }, nodes),
    ...positions.filter(item => item.current === true).map(item => element("p", { class: "position-odds__current-label" }, [`${currentPosition}: ${item.position}`])),
  ])];
}

render;
