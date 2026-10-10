export default function render(value) {
  const [encoded, headings, label, filename] = String(value ?? "").split("\u001f");
  const rows = JSON.parse(encoded);
  const columns = JSON.parse(headings);
  if (!Array.isArray(rows) || rows.length > 40 || !Array.isArray(columns) || columns.length !== 20) throw new Error("Invalid player CSV page");
  if (!rows.length) return [];
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite player CSV value");
      return String(value);
    }
    if (typeof value !== "string") throw new Error("Invalid player CSV cell");
    const text = /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? `'${value}` : value;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [columns, ...rows].map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error("Invalid player CSV columns");
    return row.map(cell).join(",");
  });
  return [{ tag: "a", attrs: {
    class: "btn-quiet player-csv-export",
    href: `data:text/csv;charset=utf-8,${encodeURIComponent("\uFEFF" + lines.join("\r\n") + "\r\n")}`,
    download: filename,
  }, children: [label] }];
}

render;
