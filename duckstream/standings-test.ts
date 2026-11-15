// The SQL text and row order the standings tests compare DuckDB's rows by.
export const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export const literal = (value: unknown) =>
  value == null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
export const canonical = (rows: any[]) =>
  rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])),
    )
  ).sort();
