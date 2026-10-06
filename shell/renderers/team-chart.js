// Team history chart. The value is JSON, a unit separator, a localized title,
// another unit separator, and the page locale. Geometry is SVG data; node
// creation, URL filtering, and text escaping remain owned by the terminal.
const SEP = "\u001f";
const SVG_W = 640;
const SVG_H = 320;
const LEFT = 52;
const RIGHT = 14;
const TOP = 18;
const BOTTOM = 38;
const PLOT_W = SVG_W - LEFT - RIGHT;
const PLOT_H = SVG_H - TOP - BOTTOM;

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

function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function pointDescription(series, point, locale) {
  const x = point.label === undefined
    ? numberText(point.x, locale)
    : String(point.label);
  return `${series.label}: ${x}, ${numberText(point.y, locale)}`;
}

function emptyChart(title, message = "") {
  return [element("div", { class: "team-chart team-chart--empty" }, [
    element("h3", { class: "team-chart__title" }, [title]),
    ...(message ? [element("p", {}, [message])] : []),
  ])];
}

export default function render(value) {
  const [raw, title = "", locale = "en-GB", missing = "", metric = ""] = String(value ?? "").split(SEP);
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
  const series = chart.series.map((entry) => ({
    label: typeof entry?.label === "string" ? entry.label : "",
    points: Array.isArray(entry?.points)
      ? entry.points.map((point) => positions ? {...point, y: point?.position} : point)
        .filter((point) => finite(point?.x) && finite(point?.y))
      : [],
  })).filter((entry) => entry.points.length > 0);
  const points = series.flatMap((entry) => entry.points);
  if (points.length === 0) return emptyChart(title, missing);

  let xMin = Math.min(...points.map((point) => point.x));
  let xMax = Math.max(...points.map((point) => point.x));
  const firstX = xMin;
  const lastX = xMax;
  let yMin = finite(chart.yMin)
    ? chart.yMin
    : Math.min(...points.map((point) => point.y));
  let yMax = finite(chart.yMax)
    ? chart.yMax
    : Math.max(...points.map((point) => point.y));
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
  const xAt = (x) => LEFT + ((x - xMin) / (xMax - xMin)) * PLOT_W;
  const xLabel = (x) => {
    for (const point of points) {
      if (point.x === x && typeof point.label === "string") {
        return String(point.label);
      }
    }
    return numberText(x, locale);
  };
  const yAt = (y) =>
    TOP +
    (positions || chart.invert === true
      ? ((y - yMin) / (yMax - yMin)) * PLOT_H
      : (1 - (y - yMin) / (yMax - yMin)) * PLOT_H);

  const children = [element("title", {}, [title])];
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = TOP + PLOT_H * tick / 4;
    const valueAt = chart.invert === true
      ? yMin + (yMax - yMin) * tick / 4
      : yMax - (yMax - yMin) * tick / 4;
    children.push(element("line", {
      class: "team-chart__grid",
      x1: LEFT,
      y1: y,
      x2: SVG_W - RIGHT,
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
    y1: TOP,
    x2: LEFT,
    y2: TOP + PLOT_H,
  }));
  children.push(element("line", {
    class: "team-chart__axis",
    x1: LEFT,
    y1: TOP + PLOT_H,
    x2: SVG_W - RIGHT,
    y2: TOP + PLOT_H,
  }));
  children.push(element("text", {
    class: "team-chart__axis-value",
    x: LEFT,
    y: SVG_H - 10,
    "text-anchor": "start",
  }, [xLabel(firstX)]));
  children.push(element("text", {
    class: "team-chart__axis-value",
    x: SVG_W - RIGHT,
    y: SVG_H - 10,
    "text-anchor": "end",
  }, [xLabel(lastX)]));

  for (let si = 0; si < series.length; si += 1) {
    const entry = series[si];
    const groupClass = `team-chart__series team-chart__series--${si + 1}`;
    const marks = [];
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

  return [element("figure", { class: "team-chart" }, [
    element("figcaption", { class: "team-chart__title" }, [title]),
    element("svg", {
      class: "team-chart__svg",
      viewBox: `0 0 ${SVG_W} ${SVG_H}`,
      role: "group",
      lang: locale,
      "aria-label": title,
    }, children),
    element("ul", {class:"team-chart__legend"}, series.map((item,index) => element("li", {class:`team-chart__legend--${index+1}`}, [item.label]))),
  ])];
}

render;
