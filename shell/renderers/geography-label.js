export default function render(value) {
  const text = String(value ?? "");
  const split = text.indexOf("|");
  if (split < 0) return [text];
  const name = text.slice(0, split);
  const encoded = text.slice(split + 1);
  const labels = Object.fromEntries(JSON.parse(encoded.slice(encoded.indexOf("[["), encoded.lastIndexOf("]]") + 2)));
  const dash = name.indexOf(" - ");
  const geography = dash < 0 ? name : name.slice(0, dash);
  return [(Object.hasOwn(labels, geography) ? labels[geography] : geography) + (dash < 0 ? "" : name.slice(dash))];
}

render;
