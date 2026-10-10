export default function render(value) {
  const [normal, extra, label] = String(value ?? "").split("|");
  if (normal === "") return [""];
  if (!/^\d+$/.test(normal) || (extra !== "" && !/^\d+$/.test(extra))) throw new Error(`Invalid match score: ${value}`);
  const score = String(Number(normal) + Number(extra || 0));
  return extra === "" ? [score] : [{ tag: "abbr", attrs: { title: label }, children: [score] }];
}

render;
