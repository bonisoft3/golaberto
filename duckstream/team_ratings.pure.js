const NS = "0b7e1c2a-4d5f-4e6a-9b8c-7d6e5f4a3b2c";
const WASM = "golaberto-odds";
const HOME_ADV = 0.16133676871779334;
const ADVANTAGE = [HOME_ADV, 0, -HOME_ADV];

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

const uuid5 = (ns, name) => {
  const b = sha1([...ns.replaceAll("-", "").match(/../g).map((x) => parseInt(x, 16)), ...utf8(name)]).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const rounded = (x, digits) => {
  const [whole, fraction] = Math.abs(x).toFixed(100).split(".");
  const kept = Number(whole + fraction.slice(0, digits));
  const rest = fraction.slice(digits);
  const half = "5".padEnd(rest.length, "0");
  const n = (kept + (rest > half || (rest === half && kept % 2 === 1) ? 1 : 0)) / 10 ** digits;
  return x < 0 ? -n : n;
};

const numbering = (ids, what) => {
  const sorted = [...new Set(ids)].sort();
  const of = Object.fromEntries(sorted.map((id, i) => [id, i + 1]));
  return {
    number: (id) => {
      const n = of[id];
      if (n === undefined) throw new RangeError(`${what} ${id} is outside its table`);
      return n;
    },
    id: (n) => sorted[n - 1],
    size: sorted.length,
  };
};

const teamGames = (games, teams) =>
  games.map((g) => {
    const length = g.home_aet === null ? 1 : 4 / 3;
    return {
      phase_id: 0,
      home_id: teams.number(g.home_id),
      away_id: teams.number(g.away_id),
      home_score: (g.home_score + (g.home_aet ?? 0)) / length,
      away_score: (g.away_score + (g.away_aet ?? 0)) / length,
      timestamp: g.moment,
      length,
      advantage: ADVANTAGE[g.home_field],
    };
  });

const persisted = (rows) => {
  const last = {};
  for (const row of rows) last[`${row.team_id}:${row.measure_date}`] = row;
  return Object.values(last)
    .sort((a, b) => a.team_id - b.team_id || (a.measure_date < b.measure_date ? -1 : 1))
    .map((r) => ({
      team_id: r.team_id,
      measure_date: r.measure_date,
      off_rating: rounded(r.off_rating, 6),
      def_rating: rounded(r.def_rating, 6),
      rating: rounded(r.rating, 6),
    }));
};

export const plan = (inputs) => {
  if (inputs.games.length === 0) return [];
  const teams = numbering(inputs.teams.map((t) => t.id), "team");
  return [{
    wasm: WASM,
    input: {
      op: "historic",
      request: {
        games: teamGames(inputs.games, teams),
        ratings: Array.from({ length: teams.size }, (_, i) => ({ id: i + 1, offense: 0, defense: 0, team: 0 })),
        phases_to_eval: [],
      },
    },
  }];
};

export const finish = (inputs, outputs) => {
  if (inputs.games.length === 0) return { team_rating: [] };
  const teams = numbering(inputs.teams.map((t) => t.id), "team");
  return {
    team_rating: persisted(outputs[0]).map((r) => ({
      id: uuid5(NS, `${teams.id(r.team_id)}:${r.measure_date}`),
      team_id: teams.id(r.team_id),
      measure_date: r.measure_date,
      offense: r.off_rating,
      defense: r.def_rating,
      rating: r.rating,
    })),
  };
};
