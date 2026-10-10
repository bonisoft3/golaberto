(_state, event) => {
  const value = event.value?.trim() ?? "";
  if (value === "") return 0;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid minimum minutes: ${value}`);
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes > 1000000) throw new Error(`Minimum minutes out of range: ${value}`);
  return minutes;
}
