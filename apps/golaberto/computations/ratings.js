// golaberto computation ratings (ir: decision-ratings): upstream's SPI ratings.
//
// From the professional archive's played games (championships without a
// category), golaberto-odds.wasm answers what odds-rust's rating endpoints
// did for Rails:
//
// - team_rating: /historic_ratings over the last 7 years, a team's offense,
//   defense and 0–100 SPI per day it was refit on (the chances' powers), as
//   its upsert left them: the day's last snapshot, to six decimals;
// - player_rating: the stats service's player ratings over the last 4*52
//   weeks, against those team ratings, per 90 minutes in f32;
// - rating_eval: /eval per phase, the out-of-sample ranked probability score
//   of the team ratings on its games (UTC days gate the refits).
//
// Upstream reads the wall clock; here "now" is the latest played game, so the
// same lake gives the same ratings. Pronto keeps no current team rating, so
// every fit starts from a zero prior, as upstream's for a team with a NULL one.

export const reads = ["championship", "phase", "game", "team", "player", "player_game", "goal"];

// The professional archive's played games, `utc`: a game's kickoff, else
// its day's midnight. Calendar windows count back as Rails' `- n.years`.
const ARCHIVE = `
  x AS (
    SELECT x.id, x.phase_id, x.home_id, x.away_id,
           CASE x.home_field WHEN 'left' THEN 0 WHEN 'neutral' THEN 1 WHEN 'right' THEN 2
                ELSE error('home_field ' || x.home_field) END AS home_field,
           x.home_score::INTEGER AS home_score, x.away_score::INTEGER AS away_score,
           x.home_aet::INTEGER AS home_aet, x.away_aet::INTEGER AS away_aet,
           coalesce(x.kickoff::TIMESTAMPTZ AT TIME ZONE 'UTC', x.day::DATE::TIMESTAMP) AS utc
    FROM game x JOIN phase p ON p.id = x.phase_id JOIN championship c ON c.id = p.championship_id
    WHERE c.category_id IS NULL AND x.played::BOOLEAN),
  recent AS (SELECT * FROM x WHERE utc > (SELECT max(utc) FROM x) - INTERVAL (4 * 52) WEEK)`;

export const queries = {
  // The archive, chronological, with which games each window holds.
  games: `
    WITH ${ARCHIVE}
    SELECT id::VARCHAR AS id, phase_id::VARCHAR AS phase_id, home_id::VARCHAR AS home_id,
           away_id::VARCHAR AS away_id, home_field, home_score, away_score, home_aet, away_aet,
           epoch(utc)::BIGINT AS moment, strftime(utc, '%Y-%m-%d %H:%M:%S') AS date,
           utc >= (SELECT max(utc) FROM x) - INTERVAL 7 YEAR AS seven_years,
           id IN (SELECT id FROM recent) AS recent
    FROM x ORDER BY moment, id`,
  // Per phase, the games its evaluation scores against: from 4 years before
  // its first game through its last.
  phases: `
    WITH ${ARCHIVE}
    SELECT phase_id::VARCHAR AS id, epoch(min(utc) - INTERVAL 4 YEAR)::BIGINT AS since,
           epoch(max(utc))::BIGINT AS until
    FROM x GROUP BY phase_id ORDER BY 1`,
  // The first day a team rating counts for the player ratings: after the
  // one 4*52+1 weeks before the latest game.
  cutoff: `
    WITH ${ARCHIVE}
    SELECT (max(utc) - INTERVAL (4 * 52 + 1) WEEK)::DATE::VARCHAR AS since FROM x`,
  teams: "SELECT id::VARCHAR AS id FROM team ORDER BY 1",
  players: "SELECT id::VARCHAR AS id FROM player ORDER BY 1",
  // Off the pitch (benched, or never off the mark) is no appearance.
  appearances: `
    WITH ${ARCHIVE}
    SELECT pg.id::VARCHAR AS id, pg.game_id::VARCHAR AS game_id, pg.player_id::VARCHAR AS player_id,
           (CASE WHEN pg.side = 'home' THEN x.home_id ELSE x.away_id END)::VARCHAR AS team_id,
           pg.on_minute::INTEGER AS "on", pg.off_minute::INTEGER AS "off", pg.red::BOOLEAN AS red,
           coalesce(p.position, '') AS position
    FROM player_game pg JOIN player p ON p.id = pg.player_id JOIN recent x ON x.id = pg.game_id
    WHERE pg.off_minute::INTEGER > 0
    ORDER BY pg.id`,
  // A goal counts for the side named, so its scorer's team is that side's
  // unless it is an own goal. One without a minute falls in no interval.
  goals: `
    WITH ${ARCHIVE}
    SELECT q.game_id::VARCHAR AS game_id, q.player_id::VARCHAR AS player_id,
           (CASE WHEN (q.side = 'home') <> q.own_goal::BOOLEAN THEN x.home_id ELSE x.away_id END)::VARCHAR AS team_id,
           q.minute::INTEGER AS "time", q.penalty::BOOLEAN AS penalty, q.own_goal::BOOLEAN AS own_goal
    FROM goal q JOIN recent x ON x.id = q.game_id
    WHERE q.minute IS NOT NULL
    ORDER BY q.id`,
};

const NS = "0b7e1c2a-4d5f-4e6a-9b8c-7d6e5f4a3b2c";
const WASM = "golaberto-odds";
// odds-rust's (ratings.rs).
const HOME_ADV = 0.16133676871779334;
const ADVANTAGE = [HOME_ADV, 0, -HOME_ADV];
// The stats service's positions: dm and am are midfielders to it, as cm.
const POSITION = { g: "g", dc: "dc", dl: "dl", dr: "dr", dm: "cm", cm: "cm", am: "cm", fw: "fw" };

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

// Text ids ↔ the positive integers the rating code keys on, in id order.
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

const numbers = (inputs) => ({
  teams: numbering(inputs.teams.map((t) => t.id), "team"),
  phases: numbering(inputs.games.map((g) => g.phase_id), "phase"),
});

// Games as the team-rating requests carry them: goals per 90 minutes, extra
// time counting as a third of a game.
const teamGames = (games, { teams, phases }) =>
  games.map((g) => {
    const length = g.home_aet === null ? 1 : 4 / 3;
    return {
      phase_id: phases.number(g.phase_id),
      home_id: teams.number(g.home_id),
      away_id: teams.number(g.away_id),
      home_score: (g.home_score + (g.home_aet ?? 0)) / length,
      away_score: (g.away_score + (g.away_aet ?? 0)) / length,
      timestamp: g.moment,
      length,
      advantage: ADVANTAGE[g.home_field],
    };
  });

const ratingsRequest = (games, ids, phasesToEval) => ({
  games: teamGames(games, ids),
  ratings: Array.from({ length: ids.teams.size }, (_, i) => ({ id: i + 1, offense: 0, defense: 0, team: 0 })),
  phases_to_eval: phasesToEval,
});

// What the historical_ratings upsert left: the last row per team and day,
// each value to six decimals, by team and day.
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

// The stats service's player-rating rows over the recent games.
const playersRequest = (inputs, history, { teams }) => {
  const recent = inputs.games.filter((g) => g.recent);
  const games = numbering(recent.map((g) => g.id), "game");
  const people = numbering(inputs.players.map((p) => p.id), "player");
  const appearances = numbering(inputs.appearances.map((a) => a.id), "appearance");
  const playing = new Set(recent.flatMap((g) => [teams.number(g.home_id), teams.number(g.away_id)]));
  const since = inputs.cutoff[0].since;
  return {
    games: recent.map((g) => ({
      id: games.number(g.id),
      home_id: teams.number(g.home_id),
      away_id: teams.number(g.away_id),
      date: g.date,
      home_field: g.home_field,
      home_aet: g.home_aet,
    })),
    goals: inputs.goals.map((q) => ({
      game_id: games.number(q.game_id),
      player_id: people.number(q.player_id),
      team_id: teams.number(q.team_id),
      time: q.time,
      penalty: q.penalty,
      own_goal: q.own_goal,
    })),
    appearances: inputs.appearances.map((a) => ({
      id: appearances.number(a.id),
      game_id: games.number(a.game_id),
      player_id: people.number(a.player_id),
      team_id: teams.number(a.team_id),
      on: a.on,
      off: a.off,
      red: a.red,
      position: a.position === "" ? "" : POSITION[a.position],
    })),
    historical_ratings: history
      .filter((r) => playing.has(r.team_id) && r.measure_date > since)
      .map((r) => ({ team_id: r.team_id, measure_date: r.measure_date, off_rating: r.off_rating, def_rating: r.def_rating })),
    now: recent.reduce((n, g) => Math.max(n, g.moment), 0),
  };
};

const f32 = Math.fround;
const E = f32(Math.E);

// The `players` update, per 90 minutes in f32 as the stats service did.
const normalized = (totals, people) => {
  const { player_id, player_off, player_def, player_minutes } = totals;
  return player_id.map((p, i) => {
    const [off, deff, minutes] = [f32(player_off[i]), f32(player_def[i]), f32(player_minutes[i])];
    const squash = f32(1 / f32(1 + f32(E ** f32(-f32(minutes - 2000) / 400))));
    const per90 = [off, deff].map((x) => f32(f32(x / minutes) * 90));
    const rating = f32(f32(f32(f32(off + deff) / minutes) * 90) * squash);
    if (![...per90, rating].every(Number.isFinite)) throw new RangeError(`player ${people.id(p)}: a non-finite rating`);
    return { id: people.id(p), rating };
  });
};

export const plan = (inputs, seed, outputs) => {
  if (inputs.games.length === 0) return [];
  const ids = numbers(inputs);
  const jobs = [
    { wasm: WASM, input: { op: "historic", request: ratingsRequest(inputs.games.filter((g) => g.seven_years), ids, []) } },
    ...inputs.phases.map((p) => ({
      wasm: WASM,
      input: {
        op: "eval",
        request: ratingsRequest(inputs.games.filter((g) => g.moment > p.since && g.moment <= p.until), ids, [
          ids.phases.number(p.id),
        ]),
      },
    })),
  ];
  // The player ratings read the team ratings the historic job answers.
  if (outputs.length === 0 || !inputs.games.some((g) => g.recent)) return jobs;
  return [
    ...jobs,
    { wasm: WASM, input: { op: "player_ratings", request: playersRequest(inputs, persisted(outputs[0]), ids) } },
  ];
};

export const finish = (inputs, outputs) => {
  if (inputs.games.length === 0) return { team_rating: [], player_rating: [], rating_eval: [] };
  const { teams } = numbers(inputs);
  const people = numbering(inputs.players.map((p) => p.id), "player");
  const recent = inputs.games.some((g) => g.recent);
  return {
    team_rating: persisted(outputs[0]).map((r) => ({
      id: uuid5(NS, `${teams.id(r.team_id)}:${r.measure_date}`),
      team_id: teams.id(r.team_id),
      measure_date: r.measure_date,
      offense: r.off_rating,
      defense: r.def_rating,
      rating: r.rating,
    })),
    player_rating: recent ? normalized(outputs[outputs.length - 1], people) : [],
    rating_eval: inputs.phases.map((p, i) => ({ id: p.id, rps: outputs[i + 1].rps })),
  };
};
