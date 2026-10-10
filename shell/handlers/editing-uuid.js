({
  format: (value) => value ?? "",
  parse: (text) => {
    const value = text.trim();
    if (value === "") return null;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new Error(`Invalid reference: ${text}`);
    }
    return value.toLowerCase();
  },
});
