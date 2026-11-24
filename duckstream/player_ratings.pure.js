const WASM = "golaberto-odds";
const POSITION = { g: "g", dc: "dc", dl: "dl", dr: "dr", dm: "cm", cm: "cm", am: "cm", fw: "fw" };

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

const historyRows = (rows, teams, since) => {
  const byKey = {};
  for (const r of rows) {
    if (r.measure_date <= since) continue;
    const teamId = teams.number(r.team_id);
    byKey[`${teamId}:${r.measure_date}`] = {
      team_id: teamId,
      measure_date: r.measure_date,
      off_rating: r.offense,
      def_rating: r.defense,
    };
  }
  return Object.values(byKey)
    .sort((a, b) => a.team_id - b.team_id || (a.measure_date < b.measure_date ? -1 : 1));
};

const playersRequest = (inputs) => {
  const teams = numbering(inputs.teams.map((t) => t.id), "team");
  const games = numbering(inputs.games.map((g) => g.id), "game");
  const people = numbering(inputs.players.map((p) => p.id), "player");
  const appearances = numbering(inputs.appearances.map((a) => a.id), "appearance");
  const playing = new Set(inputs.games.flatMap((g) => [teams.number(g.home_id), teams.number(g.away_id)]));
  const since = inputs.cutoff[0].since;
  return {
    games: inputs.games.map((g) => ({
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
    historical_ratings: historyRows(inputs.team_ratings, teams, since).filter((r) => playing.has(r.team_id)),
    now: inputs.games.reduce((n, g) => Math.max(n, g.moment), 0),
  };
};

const f32 = Math.fround;
const E = f32(Math.E);

const normalized = (totals, people) => {
  const { player_id, player_off, player_def, player_minutes } = totals;
  return player_id.map((p, i) => {
    const [off, deff, minutes] = [f32(player_off[i]), f32(player_def[i]), f32(player_minutes[i])];
    const squash = f32(1 / f32(1 + f32(E ** f32(-f32(minutes - 2000) / 400))));
    const per90 = [off, deff].map((x) => f32(f32(x / minutes) * 90));
    const rating = f32(f32(f32(f32(off + deff) / minutes) * 90) * squash);
    if (![...per90, rating].every(Number.isFinite)) throw new RangeError(`player ${people.id(p)}: a non-finite rating`);
    return { id: people.id(p), rating, off_rating: per90[0], def_rating: per90[1] };
  });
};

export const plan = (inputs) => {
  if (inputs.games.length === 0) return [];
  return [{
    wasm: WASM,
    select: ["player_id", "player_off", "player_def", "player_minutes"],
    input: { op: "player_ratings", request: playersRequest(inputs) },
  }];
};

export const finish = (inputs, outputs) => {
  if (inputs.games.length === 0) return { player_rating: [] };
  const people = numbering(inputs.players.map((p) => p.id), "player");
  return {
    player_rating: normalized(outputs[0], people),
  };
};
