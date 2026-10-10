const invalid = (value) => {
  throw new Error(`Invalid kickoff instant: ${value}`);
};

const instant = (value, offset) => {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) invalid(value);
  const local = new Date(epoch + offset * 60000).toISOString();
  if (local.slice(0, 19) !== value.slice(0, 19)) invalid(value);
  return epoch;
};

const format = (value) => {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  const found =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
      .exec(
        text,
      );
  if (found === null) throw new Error(`Invalid kickoff instant: ${text}`);
  const zone = found[8];
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) invalid(text);
  const offset = zone === "Z" ? 0 : (zone[0] === "+" ? 1 : -1) *
    (offsetHour * 60 + offsetMinute);
  const normalized = `${text.slice(0, 10)}T${text.slice(11)}`;
  const utc = new Date(instant(normalized, offset)).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith("0000-")) invalid(text);
  const fraction = (found[7] ?? "").slice(1).replace(/0+$/, "");
  if (fraction.length > 3) invalid(text);
  return `${utc.slice(0, 19)}${fraction === "" ? "" : `.${fraction}`}`;
};

const parse = (text) => {
  const value = String(text).trim();
  if (value === "") return null;
  const found =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(
      value,
    );
  if (found === null || value.startsWith("0000-")) invalid(text);
  const complete = found[6] === undefined ? `${value}:00Z` : `${value}Z`;
  instant(complete, 0);
  return complete;
};

({ format, parse });
