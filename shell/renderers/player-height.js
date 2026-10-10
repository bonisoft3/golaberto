export default function render(value) {
  const text = String(value ?? "");
  const separator = text.indexOf("|");
  if (separator < 0) throw new Error("Player height unit is missing");
  const height = text.slice(0, separator);
  if (height === "") return [""];
  if (!Number.isFinite(Number(height)) || Number(height) <= 0) throw new Error(`Invalid player height: ${height}`);
  return [`${height} ${text.slice(separator + 1)}`];
}

render;
