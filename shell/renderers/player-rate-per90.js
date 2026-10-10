export default function render(value) {
  const [numerator, denominator, locale] = String(value ?? "").split("|");
  if (numerator === "" || denominator === "") return [""];
  const total = Number(numerator);
  const minutes = Number(denominator);
  if (!Number.isFinite(total) || !Number.isFinite(minutes) || minutes < 0) throw new Error(`Invalid player rate: ${value}`);
  if (minutes === 0) return [""];
  const text = String(Math.round(total * 90 / minutes * 100) / 100);
  return [/^(pt|es|it|de|fr)/i.test(locale) ? text.replace(".", ",") : text];
}

render;
