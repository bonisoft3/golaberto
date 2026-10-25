// Weekday names use civil-date arithmetic without a clock or Date in the cage.
export default function render(value) {
  const [day, names] = String(value ?? "").split("|");
  if (!day) return [];
  // Out-of-range month or day parts name no weekday; a day past its month's
  // end rolls into the next month.
  const [, m, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(day) ?? [];
  const valid = m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const weekday = valid ? (names ?? "").split(",")[weekdayOf(day)] : undefined;
  return [weekday ? weekday + ", " : ""];
}

// Days since 1970-01-01 of a proleptic Gregorian y-m-d (Hinnant's
// days_from_civil), then the week: the epoch fell on a Thursday.
function weekdayOf(day) {
  const [y0, m, d] = day.split("-").map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const days = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  return (((days + 4) % 7) + 7) % 7;
}

render;
