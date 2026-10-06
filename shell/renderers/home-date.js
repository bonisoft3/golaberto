// A civil date already grouped in Brasília; UTC arithmetic preserves that day
// without consulting the reader’s zone or clock. Names come from the catalogue.
export default function render(value) {
  const [day, names] = String(value ?? "").split("|");
  if (!day) return [];
  const weekday = (names ?? "").split(",")[new Date(day + "T00:00:00Z").getUTCDay()];
  const date = day.split("-").reverse().join("/");
  return [weekday ? weekday + ", " + date : date];
}

render;
