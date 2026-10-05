// A validated zone color as a decorative SVG swatch.
function element(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

export default function render(value) {
  const color = String(value ?? "");
  if (!/^#[0-9a-f]{6}$/.test(color)) return [];
  return [element("svg", {
    class: "team-zone-color",
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
    fill: color,
  })])];
}

render;
