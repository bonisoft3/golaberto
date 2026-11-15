const cmp = (a, b) => {
  if (a === b) return 0;
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
};
const nullable = (a, b, first) =>
  a === b
    ? 0
    : a === null
    ? (first ? -1 : 1)
    : b === null
    ? (first ? 1 : -1)
    : cmp(a, b);
const byGame = (a, b) =>
  nullable(a.day, b.day, false) || nullable(a.kickoff, b.kickoff, true) ||
  cmp(a.id, b.id);
export const retainForm = (forms, rows) => {
  for (const row of rows) {
    const key = row.group_id + ":" + row.team_id;
    const recent = forms[key] ?? [];
    recent.push(row);
    recent.sort(byGame);
    forms[key] = recent.slice(-5);
  }
  return forms;
};
const integer = (value) => {
  if (!Number.isSafeInteger(value)) {
    throw new Error("invalid standings integer");
  }
  return BigInt(value);
};
const roundedRatio = (numerator, denominator) => {
  const negative = numerator < 0n;
  const value = negative ? -numerator : numerator;
  const rounded = (value * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
};
// PostgreSQL numeric division selects a base-10000 significant-digit scale
// before ROUND applies the ladder's six decimal places (numeric.c select_div_scale).
const goalAverage = (gf, ga) => {
  if (ga === 0n) return gf > 0n ? (1000n + gf) * 1000000n : 0n;
  const leading = (value) => {
    let weight = 0;
    while (value >= 10000n) {
      value /= 10000n;
      weight++;
    }
    return { value, weight };
  };
  const left = leading(gf), right = leading(ga);
  const weight = left.weight - right.weight -
    (left.value <= right.value ? 1 : 0);
  const scale = Math.max(7, 16 - weight * 4);
  const quotient = roundedRatio(
    gf * 10000000n * 10n ** BigInt(scale),
    ga * 10000000n + 1n,
  );
  return roundedRatio(quotient, 10n ** BigInt(scale - 6));
};
const ladder = (row, members) =>
  row.sort.split(",").map((key) => {
    if (key === "name") return row.team_name;
    const fields = {
      pt: "points",
      w: "wins",
      gd: "goal_diff",
      gf: "goals_for",
      g_away: "goals_away",
      gp: "goals_pen",
      g_aet: "goals_aet",
      bias: "bias",
    };
    let value;
    if (key === "g_average") {
      const gf = integer(row.goals_for), ga = integer(row.goals_against);
      value = goalAverage(gf, ga);
    } else if (key === "head") {
      value = integer(
        members.length <= 2 ||
          members.every((member) => member.points === row.points)
          ? 0
          : row.head_points,
      ) * 1000000n;
    } else if (fields[key]) value = integer(row[fields[key]]) * 1000000n;
    else return "";
    return String(9000000000000n - value);
  });
const byLadder = (a, b) => {
  for (let i = 0; i < Math.min(a.keys.length, b.keys.length); i++) {
    const order = cmp(a.keys[i], b.keys[i]);
    if (order) return order;
  }
  return a.keys.length - b.keys.length || cmp(a.row.team_id, b.row.team_id);
};
export const rankGroup = (members, zones, forms) => {
  const ranked = members.map((row) => ({ row, keys: ladder(row, members) }))
    .sort(byLadder);
  return ranked.map(({ row }, index) => {
    const position = index + 1;
    const matching = zones.filter((zone) =>
      (zone.positions ?? "") !== ""
        ? zone.positions.split(",").includes(String(position))
        : position >= zone.first && position <= zone.last
    )
      .sort((a, b) => a.last - a.first - (b.last - b.first) || cmp(a.id, b.id));
    const id = row.group_id + ":" + row.team_id;
    const form = (forms[id] ?? []).map((item) => item.result);
    const padded = Array(5 - form.length).fill("").concat(form);
    return {
      id,
      group_id: row.group_id,
      team_id: row.team_id,
      team_name: row.team_name,
      position,
      points: row.points,
      played: row.played,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      goals_for: row.goals_for,
      goals_against: row.goals_against,
      goal_diff: row.goal_diff,
      form1: padded[0],
      form2: padded[1],
      form3: padded[2],
      form4: padded[3],
      form5: padded[4],
      zone: matching[0]?.color ?? "",
    };
  });
};
export const plan = () => [];
export const finish = (inputs) => {
  const forms = retainForm({}, inputs.form);
  const members = new Map(), zones = new Map();
  for (const row of inputs.members) {
    if (!members.has(row.group_id)) members.set(row.group_id, []);
    members.get(row.group_id).push(row);
  }
  for (const row of inputs.zones) {
    if (!zones.has(row.group_id)) zones.set(row.group_id, []);
    zones.get(row.group_id).push(row);
  }
  return {
    standing: inputs.groups.flatMap((group) =>
      rankGroup(members.get(group.id) ?? [], zones.get(group.id) ?? [], forms)
    ),
  };
};
