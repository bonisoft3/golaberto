export default function render(value) {
  const text = String(value ?? "");
  const separator = text.indexOf("|");
  if (separator < 0) throw new Error("Player position labels are missing");
  const position = text.slice(0, separator);
  const labels = text.slice(separator + 1).split("|");
  const index = ["g", "dr", "dc", "dl", "dm", "cm", "am", "fw"].indexOf(position);
  if (labels.length !== 8) throw new Error("Invalid player position labels");
  if (position === "") return [""];
  if (index < 0) throw new Error(`Unknown player position: ${position}`);
  return [labels[index]];
}

render;
