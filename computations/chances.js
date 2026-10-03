// golaberto computation chances (ir: decision-chances): each group's chances.
//
// For every group with games still to play, the request upstream's Rails
// sends odds-rust's /odds (Group#odds) is built from the lake and answered by
// golaberto-odds.wasm: the group's teams in name order with their add_sub and
// bias, every game of the phase a group team plays with Rails' home/away
// powers, the phase's tie-break ladder, the championship's points and the
// group's zones. What comes out is, per team, the chance of each final
// position and of ending inside each zone, and per unplayed game what its
// result can still change. A finished group's chances are its final table:
// 100 at the position it holds.
//
// A position or zone that shows 0 also says whether it can still be reached,
// as upstream's TeamGroup#odds_reachability_for reads odds-rust's per-cell
// status: a finished group's other positions are out of reach.
//
// A team's rank, points and games are its standing row's, the table the
// standings stream ranks by the phase's ladder. A group whose standing does
// not yet rank exactly its members has no current table, so no chances until
// the stream recounts it.
//
// Randomness is the seed alone, so the same lake gives the same chances.

// team_rating is the ratings computation's sink: the powers read it.
export const reads = ["championship", "phase", "stage_group", "team_group", "zone", "team", "game", "team_rating", "standing"];

// Ranked groups and live ones. A team that left a group can keep a stale
// standing row, so only the members' rows are read.
const RANKED = `
  members AS (
    SELECT t.group_id, t.team_id, t.add_sub::INTEGER AS add_sub, t.bias::INTEGER AS bias,
           s.position::INTEGER AS position, s.points::INTEGER AS points, s.played::INTEGER AS played
    FROM team_group t LEFT JOIN standing s ON s.group_id = t.group_id AND s.team_id = t.team_id),
  ranked AS (
    SELECT group_id FROM members GROUP BY group_id
    HAVING count(position) = count(*) AND count(DISTINCT position) = count(*)
       AND min(position) = 1 AND max(position) = count(*)),
  live AS (
    SELECT DISTINCT t.group_id
    FROM team_group t JOIN stage_group g ON g.id = t.group_id
    JOIN game x ON x.phase_id = g.phase_id AND t.team_id IN (x.home_id, x.away_id)
    WHERE NOT x.played::BOOLEAN)`;

// Each sorted by group id: ranked groups, their members, the live groups'
// games with each side's latest rating before kickoff, and their zones.
export const queries = {
  groups: `
    WITH ${RANKED}
    SELECT g.id::VARCHAR AS id, l.group_id IS NOT NULL AS live, p.sort,
           p.bonus_points::INTEGER AS bonus_points, p.bonus_points_threshold::INTEGER AS bonus_points_threshold,
           c.point_win::INTEGER AS win, c.point_draw::INTEGER AS draw, c.point_loss::INTEGER AS loss
    FROM stage_group g JOIN ranked r ON r.group_id = g.id
    JOIN phase p ON p.id = g.phase_id JOIN championship c ON c.id = p.championship_id
    LEFT JOIN live l ON l.group_id = g.id
    ORDER BY 1`,
  // Rails orders a group's team_groups by team name.
  members: `
    WITH ${RANKED}
    SELECT m.group_id::VARCHAR AS group_id, m.team_id::VARCHAR AS team_id, n.name,
           m.add_sub, m.bias, m.position, m.points, m.played
    FROM members m JOIN ranked USING (group_id) JOIN team n ON n.id = m.team_id
    ORDER BY 1, n.name, 2`,
  // A game's moment is its kickoff, else its day's UTC midnight; a rating
  // counts when measured on a day starting before it (Rails' `measure_date <
  // date`). Ratings are read as upstream's FLOAT column holds them, in f32.
  games: `
    WITH ${RANKED},
    x AS (
      SELECT id, phase_id, home_id, away_id, home_field, played::BOOLEAN AS played,
             coalesce(home_score::INTEGER, 0) AS home_score, coalesce(away_score::INTEGER, 0) AS away_score,
             coalesce(epoch(kickoff::TIMESTAMPTZ), epoch(day::DATE)) AS moment
      FROM game),
    r AS (
      SELECT team_id, epoch(measure_date::DATE) AS moment,
             offense::DOUBLE::FLOAT AS offense, defense::DOUBLE::FLOAT AS defense
      FROM team_rating),
    pairs AS (
      SELECT DISTINCT t.group_id, x.*
      FROM team_group t JOIN live USING (group_id) JOIN ranked USING (group_id)
      JOIN stage_group g ON g.id = t.group_id
      JOIN x ON x.phase_id = g.phase_id AND t.team_id IN (x.home_id, x.away_id))
    SELECT pairs.group_id::VARCHAR AS group_id, pairs.id::VARCHAR AS id,
           pairs.home_id::VARCHAR AS home_id, pairs.away_id::VARCHAR AS away_id,
           pairs.home_field, pairs.played, pairs.home_score, pairs.away_score,
           h.offense::DOUBLE AS home_off, h.defense::DOUBLE AS home_def,
           a.offense::DOUBLE AS away_off, a.defense::DOUBLE AS away_def
    FROM pairs
    ASOF LEFT JOIN r h ON h.team_id = pairs.home_id AND pairs.moment > h.moment
    ASOF LEFT JOIN r a ON a.team_id = pairs.away_id AND pairs.moment > a.moment
    ORDER BY 1, pairs.moment, 2`,
  zones: `
    WITH ${RANKED}
    SELECT z.group_id::VARCHAR AS group_id, z.id::VARCHAR AS id, z.first::INTEGER AS first,
           z.last::INTEGER AS last, z.color
    FROM zone z JOIN ranked USING (group_id) ORDER BY 1, 3, 4, 2`,
};

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

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

// The /odds request of a live group, and the request's team and game
// numbers' ids: odds-rust keys both by integers.
const request = (index, group, members, games, zones) => {
  const teams = [...new Set([...members.map((m) => m.team_id), ...games.flatMap((x) => [x.home_id, x.away_id])])].sort();
  const number = Object.fromEntries(teams.map((t, i) => [t, i + 1]));
  return {
    id: index + 1,
    zones: zones.map((z) => ({ position: range(z.first, z.last) })),
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

export const finish = (inputs, outputs) => {
  const teamChance = [];
  const zoneChance = [];
  const positionChance = [];
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
    members.forEach((m, t) => {
      teamChance.push({
        id: uuid5(NS, `${group.id}:${m.team_id}`),
        group_id: group.id,
        team_id: m.team_id,
        team_name: m.name,
        rank: m.position,
        points: m.points,
        played: m.played,
      });
      pct[t].forEach((raw, r) => {
        const p = rounded(raw, 2);
        positionChance.push({
          id: uuid5(NS, `${group.id}:${m.team_id}:${r + 1}`),
          group_id: group.id,
          team_id: m.team_id,
          position: r + 1,
          percent: p,
          band: band(p),
          current: r + 1 === m.position,
          reach: reach(p, pct[t], statuses[t], [r + 1]),
        });
      });
      for (const z of zones) {
        const p = rounded(pct[t].slice(z.first - 1, z.last).reduce((s, x) => s + x, 0), 2);
        zoneChance.push({
          id: uuid5(NS, `${group.id}:${m.team_id}:${z.id}`),
          group_id: group.id,
          team_id: m.team_id,
          zone_id: z.id,
          first: z.first,
          last: z.last,
          color: z.color,
          percent: p,
          band: band(p),
          reach: reach(p, pct[t], statuses[t], range(z.first, z.last)),
        });
      }
    });
  }
  return {
    team_chance: teamChance,
    zone_chance: zoneChance,
    position_chance: positionChance,
    game_importance: Object.entries(importance).map(([id, [home, away]]) => ({ id, home, away })),
  };
};
