export default function render(value) {
  const text = String(value ?? "");
  const separator = text.indexOf("|");
  const flag = text.slice(0, separator);
  if (separator < 0 || !["true", "false"].includes(flag)) throw new Error(`Invalid player event: ${text}`);
  return [flag === "true" ? ` · ${text.slice(separator + 1)}` : ""];
}

render;
