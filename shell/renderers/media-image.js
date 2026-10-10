(value) => {
  const parts = String(value ?? "").split("|");
  const key = parts[0];
  if (!key) return [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,12}$/.test(key)) throw new Error("Invalid media key");
  const size = parts[1] === "thumb" ? 15 : 100;
  return [{tag: "img", attrs: {src: "/blobs/mecha-objects/" + key + "/" + (size === 15 ? "thumb" : "medium") + ".png", alt: "", width: size, height: size, loading: "lazy"}}];
};
