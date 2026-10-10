({
  format: (value) => value ?? "",
  parse: (text) => {
    const value = text.trim();
    if (value === "") return null;
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`Invalid whole number: ${text}`);
    }
    const number = Number(value);
    if (
      !Number.isSafeInteger(number) || number < -2147483648 ||
      number > 2147483647
    ) {
      throw new Error(`Invalid whole number: ${text}`);
    }
    return number;
  },
});
