(_state, event) => (typeof event.value === "string" ? event.value : "").replaceAll("ı", "i").replaceAll("þ", "th").replaceAll("Þ", "th")
