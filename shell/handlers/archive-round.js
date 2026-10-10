(_state, event) => {
  const value = event.value?.trim() ?? "";
  if (value === "") return "*";
  if (!/^\d+$/.test(value)) throw new Error(`Invalid archive round: ${value}`);
  const round = Number(value);
  if (!Number.isSafeInteger(round) || round < 1 || round > 2147483647) {
    throw new Error(`Invalid archive round: ${value}`);
  }
  return String(round);
}
