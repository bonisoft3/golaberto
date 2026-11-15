const NS = "6f1c5d2e-9a3b-4c7d-8e1f-2a4b6c8d0e1f";
// odds-rust's ratings constants (ratings.rs).
const AVG_BASE = 1.3350257653834494;
const HOME_ADV = 0.16133676871779334;
const SCALE = AVG_BASE * 0.424 + 0.548;
const ADVANTAGE = { left: HOME_ADV, neutral: 0, right: -HOME_ADV };

const sha1 = (bytes) => {
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  const bits = bytes.length * 8;
  padded.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let at = 0; at < padded.length; at += 64) {
    const w = [];
    for (let i = 0; i < 16; i += 1) {
      const j = at + 4 * i;
      w.push((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]);
    }
    for (let i = 16; i < 80; i += 1) w.push(rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1));
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i += 1) {
      const [f, k] = i < 20
        ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40
        ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60
        ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [a, b, c, d, e] = [t, a, rotl(b, 30), c, d];
    }
    h = h.map((x, i) => (x + [a, b, c, d, e][i]) | 0);
  }
  return h.flatMap((x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
};

const utf8 = (text) => [...unescape(encodeURIComponent(text))].map((c) => c.charCodeAt(0));

// RFC 4122's name-based uuid, as Python's uuid.uuid5.
const uuid5 = (ns, name) => {
  const b = sha1([...ns.replaceAll("-", "").match(/../g).map((x) => parseInt(x, 16)), ...utf8(name)]).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// A group's odds seed: the computation's seed and the group's id, hashed to
// an integer JSON carries exactly.
const groupSeed = (seed, group) => {
  const h = sha1(utf8(`${seed}:${group}`));
  return h.slice(1, 7).reduce((n, x) => n * 256 + x, h[0] & 0x1f);
};

// `x` to `digits` decimals as Python's round: its exact binary value, ties
// to even.
const rounded = (x, digits) => {
  const [whole, fraction] = Math.abs(x).toFixed(100).split(".");
  const kept = Number(whole + fraction.slice(0, digits));
  const rest = fraction.slice(digits);
  const half = "5".padEnd(rest.length, "0");
  const n = (kept + (rest > half || (rest === half && kept % 2 === 1) ? 1 : 0)) / 10 ** digits;
  return x < 0 ? -n : n;
};

// The heat a position's chance is drawn with: 0 unlikely … 4 likely.
const band = (p) => (p < 0.5 ? 0 : p < 5 ? 1 : p < 20 ? 2 : p < 50 ? 3 : 4);

// odds-rust's public status of one final position: proved out of reach, shown
// reachable (an estimate or a witness season), or neither.
const STATUSES = ["impossible", "reachable", "undecided"];

// Whether a cell over `positions` that shows `shown` can still be reached, as
// TeamGroup.reachability_for: empty when it shows more than 0.
const reach = (shown, pct, statuses, positions) => {
  if (shown !== 0) return "";
  if (positions.some((r) => pct[r - 1] > 0)) return "reachable";
  const selected = positions.map((r) => statuses[r - 1]);
  if (selected.every((s) => s === "impossible")) return "impossible";
  return selected.includes("reachable") ? "reachable" : "undecided";
};

// Each side's expected goals, as Rails' Game#home_power/#away_power: unlike
// the ratings' own power, the scale term is floored at 0.25 and the away
// side's advantage is negated. A team without a rating leaves the game
// without either power.
const powers = (game) => {
  const { home_off, home_def, away_off, away_def } = game;
  if ([home_off, home_def, away_off, away_def].includes(null)) return [null, null];
  const advantage = ADVANTAGE[game.home_field];
  const side = (offense, defense) =>
    Math.min(Math.max((offense - AVG_BASE) / SCALE * Math.max(0.25, defense * 0.424 + 0.548) + defense, 0.01), 10);
  return [side(home_off, away_def + advantage), side(away_off, home_def - advantage)];
};

const byGroup = (rows) => {
  const out = {};
  for (const row of rows) (out[row.group_id] ??= []).push(row);
  return out;
};

// A zone starting past the current membership holds no position yet.
const range = (first, last) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);

const zonePositions = (zone, memberCount) => {
  if (zone.positions === undefined || zone.positions === null || zone.positions === "") return range(zone.first, Math.min(zone.last, memberCount));
  const positions = zone.positions.split(",").map(Number);
  if (
    positions.some((position, index) => !Number.isInteger(position) || position < 1 || position > 1000 ||
      (index > 0 && position <= positions[index - 1]))
  ) throw new RangeError(`zone ${zone.id}: positions are not a canonical positive set`);
  return positions.filter((position) => position <= memberCount);
};

// The /odds request of a live group, and the request's team and game
// numbers' ids: odds-rust keys both by integers.
const request = (index, group, members, games, zones) => {
  const teams = [...new Set([...members.map((m) => m.team_id), ...games.flatMap((x) => [x.home_id, x.away_id])])].sort();
  const number = Object.fromEntries(teams.map((t, i) => [t, i + 1]));
  return {
    id: index + 1,
    zones: zones.map((z) => ({ position: zonePositions(z, members.length) })),
    phase: {
      sort: group.sort,
      bonus_points: group.bonus_points,
      bonus_points_threshold: group.bonus_points_threshold,
      championship: { point_win: group.win, point_draw: group.draw, point_loss: group.loss },
    },
    team_groups: members.map((m) => ({ team_id: number[m.team_id], add_sub: m.add_sub, bias: m.bias })),
    games: games.map((x, i) => {
      const [home_power, away_power] = powers(x);
      return {
        id: i + 1,
        home_id: number[x.home_id],
        away_id: number[x.away_id],
        home_score: x.home_score,
        away_score: x.away_score,
        home_power,
        away_power,
        played: x.played,
      };
    }),
  };
};

// Per ranked group, in id order: its members, its zones, and for a live one
// its /odds request.
const groups = (inputs) => {
  const members = byGroup(inputs.members);
  const games = byGroup(inputs.games);
  const zones = byGroup(inputs.zones);
  return inputs.groups.map((group, index) => ({
    group,
    members: members[group.id],
    zones: zones[group.id] ?? [],
    games: games[group.id] ?? [],
    request: group.live ? request(index, group, members[group.id], games[group.id] ?? [], zones[group.id] ?? []) : null,
  }));
};

export const plan = (inputs, seed) =>
  groups(inputs).filter((g) => g.request !== null).map((g) => ({
    wasm: "golaberto-odds",
    input: { op: "odds", request: g.request, seed: groupSeed(seed, g.group.id) },
  }));

/** @param {((sink: string, row: Record<string, unknown>) => boolean | void) | undefined} [emit] */
export const finish = (inputs, outputs, emit = undefined) => {
  const teamChance = [];
  const zoneChance = [];
  const positionChance = [];
  const collected = { team_chance: teamChance, zone_chance: zoneChance, position_chance: positionChance, game_importance: [] };
  const write = emit ?? ((sink, row) => { collected[sink].push(row); });
  const importance = {};
  let answered = 0;
  for (const { group, members, zones, games, request } of groups(inputs)) {
    const n = members.length;
    // Each member's chance of each final position, in percent; a finished
    // group's is its table.
    let pct = members.map((m) => range(1, n).map((r) => (r === m.position ? 100 : 0)));
    let statuses = members.map((m) => range(1, n).map((r) => (r === m.position ? "reachable" : "impossible")));
    if (request !== null) {
      const response = outputs[answered];
      answered += 1;
      pct = request.team_groups.map((t) => response.team_odds[t.team_id].Pos);
      statuses = request.team_groups.map((t) =>
        range(0, n - 1).map((r) => {
          const status = response.rare_position_estimates[t.team_id][r].reachability;
          if (!STATUSES.includes(status)) throw new RangeError(`group ${group.id}: team ${t.team_id} at ${r + 1} has no reachability`);
          return status;
        })
      );
      // A game between two groups answers one side in each: keep both.
      for (const [number, sides] of Object.entries(response.game_importance)) {
        const id = games[Number(number) - 1].id;
        const before = importance[id] ?? [null, null];
        importance[id] = before.map((b, s) => (sides[s] === null ? b : sides[s]));
      }
    }
    for (const [t, m] of members.entries()) {
      if (write("team_chance", {
        id: uuid5(NS, `${group.id}:${m.team_id}`),
        group_id: group.id,
        team_id: m.team_id,
        team_name: m.name,
        rank: m.position,
        points: m.points,
        played: m.played,
      }) === false) return collected;
      for (const [r, raw] of pct[t].entries()) {
        const p = rounded(raw, 2);
        if (write("position_chance", {
          id: uuid5(NS, `${group.id}:${m.team_id}:${r + 1}`),
          group_id: group.id,
          team_id: m.team_id,
          position: r + 1,
          percent: p,
          band: band(p),
          current: r + 1 === m.position,
          reach: reach(p, pct[t], statuses[t], [r + 1]),
        }) === false) return collected;
      }
      for (const z of zones) {
        const selected = zonePositions(z, n);
        const p = rounded(selected.reduce((sum, position) => {
          const value = pct[t][position - 1];
          if (value === undefined) throw new RangeError(`zone ${z.id}: position ${position} is missing from group ${group.id}`);
          return sum + value;
        }, 0), 2);
        if (write("zone_chance", {
          id: uuid5(NS, `${group.id}:${m.team_id}:${z.id}`),
          group_id: group.id,
          team_id: m.team_id,
          zone_id: z.id,
          first: z.first,
          last: z.last,
          color: z.color,
          percent: p,
          band: band(p),
          reach: reach(p, pct[t], statuses[t], selected),
        }) === false) return collected;
      }
    }
  }
  for (const [id, [home, away]] of Object.entries(importance)) {
    if (write("game_importance", { id, home, away }) === false) return collected;
  }
  return collected;
};
