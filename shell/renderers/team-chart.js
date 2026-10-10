// Team history chart. The value is unit-separated: JSON, localized title, page
// locale, empty-state text, metric, a date range with its invalid-range text,
// and the combined chart's points and position labels. Geometry is SVG data;
// node creation, URL filtering, and text escaping remain owned by the terminal.
const SEP = "\u001f";
const SVG_W = 640;
const SVG_H = 320;
const LEFT = 52;
const RIGHT = 14;
const TOP = 18;
const BOTTOM = 38;
const PLOT_W = SVG_W - LEFT - RIGHT;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function localHref(value) {
  if (typeof value !== "string" || value[0] !== "/" || value[1] === "/") {
    return null;
  }
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  return value;
}

function numberText(value, locale) {
  const text = String(Math.round(value * 100) / 100);
  return /^(pt|es|it|de|fr)/i.test(locale) ? text.replace(".", ",") : text;
}

function isoDate(value) {
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    ? time
    : NaN;
}

function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function pointDescription(series, point, locale, labels, validPosition) {
  const x = point.label === undefined
    ? numberText(point.x, locale)
    : String(point.label);
  const values = labels
    ? [
      ...(finite(point.y) ? [`${labels[0]}: ${numberText(point.y, locale)}`] : []),
      ...(validPosition(point.position) ? [`${labels[1]}: ${numberText(point.position, locale)}`] : []),
    ].join(", ")
    : numberText(point.y, locale);
  return `${series.label}: ${x}, ${values}`;
}

function emptyChart(title, message = "") {
  return [element("div", { class: "team-chart team-chart--empty" }, [
    element("h3", { class: "team-chart__title" }, [title]),
    ...(message ? [element("p", {}, [message])] : []),
  ])];
}

export default function render(value) {
  const [
    raw,
    title = "",
    locale = "en-GB",
    missing = "",
    metric = "",
    selectionFrom = "",
    selectionTo = "",
    invalidLabel = "",
    pointsLabel = "",
    positionLabel = "",
  ] = String(value ?? "").split(SEP);
  if (!raw || !title) return [];

  let chart;
  try {
    chart = JSON.parse(raw);
  } catch {
    return emptyChart(title, missing);
  }
  if (
    !chart || (chart.kind !== "line" && chart.kind !== "bars") ||
    !Array.isArray(chart.series)
  ) {
    return emptyChart(title, missing);
  }

  const positions = chart.kind === "line" && metric === "position";
  let selectionInvalid = false;
  let dateFrom = null;
  let dateTo = null;
  if (metric === "date") {
    dateFrom = isoDate(selectionFrom);
    dateTo = isoDate(selectionTo);
    selectionInvalid = Number.isNaN(dateFrom) || Number.isNaN(dateTo) ||
      (dateFrom !== null && dateTo !== null && dateFrom > dateTo);
  }
  const combined = chart.kind === "line" && metric === "combined";
  const inverted = positions || (!combined && chart.invert === true);
  const groupSize = Number.isInteger(chart.groupSize) && chart.groupSize >= 1
    ? chart.groupSize : null;
  const validPosition = (position) => Number.isInteger(position) && position >= 1 &&
    (groupSize === null || position <= groupSize);
  const right = combined ? 52 : RIGHT;
  const top = combined ? 34 : TOP;
  const plotWidth = SVG_W - LEFT - right;
  const plotHeight = SVG_H - top - BOTTOM;
  const series = chart.series.map((entry) => ({
    label: typeof entry?.label === "string" ? entry.label : "",
    points: Array.isArray(entry?.points)
      ? entry.points.map((point) =>
        positions ? { ...point, y: point?.position } : point
      )
        .filter((point) => finite(point?.x) && (combined || finite(point?.y)))
        .filter((point) =>
          metric !== "date" || selectionInvalid ||
          ((dateFrom === null || point.x >= dateFrom) &&
            (dateTo === null || point.x < dateTo + 86400000))
        )
      : [],
  })).filter((entry) => entry.points.some((point) => finite(point.y) || (combined && validPosition(point.position))));
  const points = series.flatMap((entry) => entry.points);
  if (points.length === 0) return emptyChart(title, missing);

  let xMin = Math.min(...points.map((point) => point.x));
  let xMax = Math.max(...points.map((point) => point.x));
  const firstX = xMin;
  const lastX = xMax;
  const values = points.filter((point) => finite(point.y)).map((point) => point.y);
  const rankMax = groupSize ?? Math.max(1, ...points.filter((point) => validPosition(point.position)).map((point) => point.position));
  const rankAt = (position) => top + (rankMax === 1 ? 0 : (position - 1) / (rankMax - 1)) * plotHeight;
  let yMin = finite(chart.yMin)
    ? chart.yMin
    : combined ? Math.min(0, ...values) : Math.min(...values);
  let yMax = finite(chart.yMax)
    ? chart.yMax
    : combined ? Math.max(1, ...values) : Math.max(...values);
  if (combined && !finite(chart.yMin) && !finite(chart.yMax)) {
    yMin = Math.floor(yMin);
    yMax = yMin + 4 * Math.max(1, Math.ceil((yMax - yMin) / 4));
  }
  if (chart.kind === "bars") {
    yMin = Math.min(0, yMin);
    yMax = Math.max(0, yMax);
  }
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  if (yMax < yMin) return emptyChart(title, missing);
  const xAt = (x) => LEFT + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const xLabel = (x) => {
    for (const point of points) {
      if (point.x === x && typeof point.label === "string") {
        return String(point.label);
      }
    }
    return numberText(x, locale);
  };
  const yAt = (y) =>
    top +
    (inverted
      ? ((y - yMin) / (yMax - yMin)) * plotHeight
      : (1 - (y - yMin) / (yMax - yMin)) * plotHeight);

  const children = [element("title", {}, [title])];
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = top + plotHeight * tick / 4;
    const valueAt = inverted
      ? yMin + (yMax - yMin) * tick / 4
      : yMax - (yMax - yMin) * tick / 4;
    children.push(element("line", {
      class: "team-chart__grid",
      x1: LEFT,
      y1: y,
      x2: SVG_W - right,
      y2: y,
    }));
    children.push(element("text", {
      class: "team-chart__axis-value",
      x: LEFT - 8,
      y: y + 4,
      "text-anchor": "end",
    }, [numberText(valueAt, locale)]));
  }
  children.push(element("line", {
    class: "team-chart__axis",
    x1: LEFT,
    y1: top,
    x2: LEFT,
    y2: top + plotHeight,
  }));
  children.push(element("line", {
    class: "team-chart__axis",
    x1: LEFT,
    y1: top + plotHeight,
    x2: SVG_W - right,
    y2: top + plotHeight,
  }));
  children.push(element("text", {
    class: "team-chart__axis-value",
    x: LEFT,
    y: SVG_H - 10,
    "text-anchor": "start",
  }, [xLabel(firstX)]));
  children.push(element("text", {
    class: "team-chart__axis-value",
    x: SVG_W - right,
    y: SVG_H - 10,
    "text-anchor": "end",
  }, [xLabel(lastX)]));

  if (combined) {
    children.push(element("line", {
      class: "team-chart__axis team-chart__axis--position",
      x1: SVG_W - right, x2: SVG_W - right, y1: top, y2: top + plotHeight,
    }));
    const ranks = [];
    for (let tick = 0; tick <= 4; tick += 1) {
      const rank = 1 + Math.round((rankMax - 1) * tick / 4);
      if (!ranks.includes(rank)) ranks.push(rank);
    }
    for (const rank of ranks) {
      children.push(element("text", {
        class: "team-chart__axis-value team-chart__axis-value--position",
        x: SVG_W - right + 8, y: rankAt(rank) + 4, "text-anchor": "start",
      }, [numberText(rank, locale)]));
    }
    children.push(element("text", {
      class: "team-chart__axis-value team-chart__axis-label team-chart__axis-label--points",
      x: LEFT, y: 16, "text-anchor": "start",
    }, [pointsLabel]));
    children.push(element("text", {
      class: "team-chart__axis-value team-chart__axis-label team-chart__axis-label--position",
      x: SVG_W - right, y: 16, "text-anchor": "end",
    }, [positionLabel]));
  }

  for (let si = 0; si < series.length; si += 1) {
    const entry = series[si];
    const groupClass = `team-chart__series team-chart__series--${si + 1}`;
    const marks = [];
    if (combined) {
      for (const dimension of ["points", "position"]) {
        const ordinate = (point) => dimension === "points" ? point.y : point.position;
        const valid = (point) => dimension === "points" ? finite(point.y) : validPosition(point.position);
        const at = dimension === "points" ? yAt : rankAt;
        let segment = [];
        const finishSegment = () => {
          if (segment.length > 1) marks.push(element("polyline", {
            class: `team-chart__line team-chart__line--${dimension}`,
            points: segment.map((point) => `${xAt(point.x)},${at(ordinate(point))}`).join(" "),
          }));
          segment = [];
        };
        for (const point of entry.points) {
          if (valid(point)) segment.push(point);
          else finishSegment();
        }
        finishSegment();
        for (const point of entry.points.filter(valid)) {
          const accessible = pointDescription(entry, point, locale, [pointsLabel, positionLabel], validPosition);
          const marker = element("circle", {
            class: `team-chart__point team-chart__point--${dimension}`,
            cx: xAt(point.x), cy: at(ordinate(point)), r: 4, title: accessible,
          }, [element("title", {}, [accessible])]);
          const href = localHref(point.href);
          marks.push(href ? element("a", {
            class: "team-chart__link", href, tabindex: 0,
            "aria-label": accessible, title: accessible,
          }, [marker]) : marker);
        }
      }
      children.push(element("g", { class: groupClass, "aria-label": entry.label }, marks));
      continue;
    }
    if (chart.kind === "line" && entry.points.length > 1) {
      marks.push(element("polyline", {
        class: "team-chart__line",
        points: entry.points.map((point) => `${xAt(point.x)},${yAt(point.y)}`)
          .join(" "),
      }));
    }
    const spacing = entry.points.length > 1
      ? Math.min(
        ...entry.points.slice(1).map((point, index) =>
          Math.abs(xAt(point.x) - xAt(entry.points[index].x))
        ).filter((n) => n > 0),
      )
      : PLOT_W;
    const barWidth = Math.max(
      2,
      Math.min(28, (Number.isFinite(spacing) ? spacing : 24) * 0.62),
    );
    for (const point of entry.points) {
      const accessible = pointDescription(entry, point, locale);
      const x = xAt(point.x);
      const y = yAt(point.y);
      const marker = chart.kind === "bars"
        ? element("rect", {
          class: "team-chart__bar",
          x: x - barWidth / 2,
          y: Math.min(y, yAt(0)),
          width: barWidth,
          height: Math.max(1, Math.abs(yAt(0) - y)),
          title: accessible,
        }, [element("title", {}, [accessible])])
        : element("circle", {
          class: "team-chart__point",
          cx: x,
          cy: y,
          r: 4,
          title: accessible,
        }, [element("title", {}, [accessible])]);
      const href = localHref(point.href);
      marks.push(
        href
          ? element("a", {
            class: "team-chart__link",
            href,
            tabindex: 0,
            "aria-label": accessible,
            title: accessible,
          }, [marker])
          : marker,
      );
    }
    children.push(
      element("g", { class: groupClass, "aria-label": entry.label }, marks),
    );
  }

  const feedback = selectionInvalid ? invalidLabel : null;

  return [element("figure", { class: combined ? "team-chart team-chart--combined" : "team-chart" }, [
    element("figcaption", { class: "team-chart__title" }, [title]),
    element("svg", {
      class: "team-chart__svg",
      viewBox: `0 0 ${SVG_W} ${SVG_H}`,
      role: "group",
      lang: locale,
      "aria-label": title,
    }, children),
    element(
      "ul",
      { class: "team-chart__legend" },
      series.map((item, index) =>
        element("li", { class: `team-chart__legend--${index + 1}` }, [
          item.label,
        ])
      ),
    ),
    ...(feedback
      ? [element("p", {
        class: `team-chart__selection${
          selectionInvalid ? " team-chart__selection--invalid" : ""
        }`,
      }, [feedback])]
      : []),
    ...(combined ? [element("ul", { class: "team-chart__legend team-chart__metric-legend" }, [
      element("li", { class: "team-chart__metric--points" }, [pointsLabel]),
      element("li", { class: "team-chart__metric--position" }, [positionLabel]),
    ])] : []),
  ])];
}

render;
