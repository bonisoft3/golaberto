(_state, event) => {
  const value = event.value?.trim() ?? "";
  if (value === "") return "*";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid archive date: ${value}`);
  let year = Number(value.slice(0, 4));
  let month = Number(value.slice(5, 7));
  let day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > months[month - 1]) {
    throw new Error(`Invalid archive date: ${value}`);
  }
  const previousYear = year - 1;
  // The proleptic Gregorian calendar starts on Monday, 0001-01-01.
  let elapsed = 365 * previousYear + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100) + Math.floor(previousYear / 400) + day - 1;
  for (let index = 0; index < month - 1; index += 1) elapsed += months[index];
  day -= elapsed % 7;
  if (day < 1) {
    month -= 1;
    if (month === 0) {
      year -= 1;
      month = 12;
    }
    day += months[month - 1];
  }
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0")
    + "-" + String(day).padStart(2, "0");
}
