export default function render(value) {
  const [encoded, unknown, beforeLabel, afterLabel, ...labelled] = String(value)
    .split("\u001f");
  const changes = JSON.parse(encoded);
  if (!changes || Array.isArray(changes) || typeof changes !== "object") {
    throw new Error("Invalid game history");
  }
  const fields = [
    "phase_id",
    "round",
    "day",
    "kickoff",
    "home_id",
    "away_id",
    "home_field",
    "played",
    "home_score",
    "away_score",
    "home_aet",
    "away_aet",
    "home_pen",
    "away_pen",
    "stadium_id",
    "referee_id",
    "attendance",
  ];
  // One message per label, in field order, then the home ground's three values
  // and yes/no: a catalog entry holding JSON braces is an ICU argument the
  // message compiler refuses.
  if (labelled.length !== fields.length + 5) throw new Error("Invalid game history labels");
  const labels = Object.fromEntries(fields.map((field, i) => [field, labelled[i]]));
  const [homeAdvantage, neutral, awayAdvantage, yes, no] = labelled.slice(fields.length);
  const coded = {
    home_field: { left: homeAdvantage, neutral, right: awayAdvantage },
    played: { true: yes, false: no },
  };
  const display = (field, value) => {
    if (value === null) return unknown;
    const words = coded[field];
    if (!words) return String(value);
    if (!Object.hasOwn(words, String(value))) throw new Error("Invalid game history value");
    return words[String(value)];
  };
  return [{
    tag: "div",
    attrs: { class: "community-diff" },
    children: Object.entries(changes).map(([field, change]) => {
      if (
        !fields.includes(field) || typeof labels[field] !== "string" ||
        !change ||
        !Object.hasOwn(change, "before") || !Object.hasOwn(change, "after") ||
        [change.before, change.after].some((v) =>
          v !== null && !["string", "number", "boolean"].includes(typeof v)
        )
      ) {
        throw new Error("Invalid game history field");
      }
      return {
        tag: "div",
        children: [{
          tag: "strong",
          attrs: { class: "community-diff__field" },
          children: [labels[field]],
        }, {
          tag: "div",
          attrs: { class: "community-diff__values" },
          children: [
            {
              tag: "span",
              attrs: { class: "community-before" },
              children: [`${beforeLabel}: ${display(field, change.before)}`],
            },
            {
              tag: "span",
              attrs: { class: "community-after" },
              children: [`${afterLabel}: ${display(field, change.after)}`],
            },
          ],
        }],
      };
    }),
  }];
}

render;
