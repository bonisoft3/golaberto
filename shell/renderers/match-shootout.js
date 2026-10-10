export default function render(value) {
  const [home, away, label] = String(value ?? "").split("|");
  if (home === "" && away === "") return [];
  if (!/^\d+$/.test(home) || !/^\d+$/.test(away)) throw new Error(`Invalid shootout score: ${value}`);
  return [{ tag: "small", attrs: { class: "shootout", title: label }, children: [
    { tag: "span", attrs: { class: "visually-hidden" }, children: [`${label}: `] },
    `(${home}–${away})`,
  ] }];
}

render;
