// A small archive as the compute service publishes it: a DuckDB lake whose
// uuid columns are uuids and whose portable-domain columns are text.
//
// Six teams play a double round robin in a 2021 season and in a 2026 one,
// the latter with ten games left; a Sub-20 championship of the same teams is
// outside the professional archive. Every game has full line-ups and its
// goals, so both computations run on it end to end.

import { duckdb, type Reader, readerOf } from "@mecha/compute/main.ts";

export type Row = Record<string, string | null>;

export const TABLES: Record<string, string> = {
  championship: "id UUID, name VARCHAR, category_id UUID, point_win VARCHAR, point_draw VARCHAR, point_loss VARCHAR",
  phase: "id UUID, championship_id UUID, sort VARCHAR, bonus_points VARCHAR, bonus_points_threshold VARCHAR",
  stage_group: "id UUID, phase_id UUID",
  team: "id UUID, name VARCHAR",
  team_group: "id UUID, group_id UUID, team_id UUID, add_sub VARCHAR, bias VARCHAR",
  zone: "id UUID, group_id UUID, first VARCHAR, last VARCHAR, color VARCHAR",
  game: "id UUID, phase_id UUID, day VARCHAR, kickoff VARCHAR, home_id UUID, away_id UUID, home_field VARCHAR, " +
    "played VARCHAR, home_score VARCHAR, away_score VARCHAR, home_aet VARCHAR, away_aet VARCHAR",
  team_rating: "id UUID, team_id UUID, measure_date VARCHAR, offense VARCHAR, defense VARCHAR, rating VARCHAR",
  standing: "id VARCHAR, group_id UUID, team_id UUID, position VARCHAR, points VARCHAR, played VARCHAR",
  player: "id UUID, position VARCHAR",
  player_game: "id UUID, game_id UUID, player_id UUID, side VARCHAR, on_minute VARCHAR, off_minute VARCHAR, red VARCHAR",
  goal: "id UUID, game_id UUID, player_id UUID, side VARCHAR, minute VARCHAR, penalty VARCHAR, own_goal VARCHAR",
};

const NAMES = ["Tigres", "Águias", "Leões", "Corvos", "Botafogo", "Ursos"];
const POSITIONS = ["g", "dr", "dc", "dc", "dl", "dm", "cm", "am", "fw", "fw", null];

export const uid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** mulberry32: a seeded stream, so the world is the same every run. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    integer: (low: number, high: number) => low + Math.floor(next() * (high - low)),
    poisson: (mean: number) => {
      const limit = Math.exp(-mean);
      let k = 0;
      for (let p = next(); p > limit; p *= next()) k += 1;
      return k;
    },
    shuffle: <T>(items: T[]) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    },
  };
}

const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);

/** The rows, by table, and the ids a test asserts on. */
export class World {
  rows: Record<string, Row[]> = Object.fromEntries(Object.keys(TABLES).map((t) => [t, []]));
  teams = NAMES.map((_, i) => uid(1, i + 1));
  players: Record<string, string[]> = {};
  phases: Record<string, string> = {};
  groups: Record<string, string> = {};
  left: string[] = [];
  private rng: ReturnType<typeof random>;

  constructor(seed = 7) {
    this.rng = random(seed);
    // Names out of id order, so a request's name order is visible.
    this.teams.forEach((team, i) => this.rows.team.push({ id: team, name: NAMES[i] }));
    this.teams.forEach((team, t) => {
      this.players[team] = POSITIONS.map((_, k) => uid(2, t * 100 + k + 1));
      this.players[team].forEach((p, k) => this.rows.player.push({ id: p, position: POSITIONS[k] }));
    });
    this.season("2021", "2021-03-07", 30);
    this.season("2026", "2026-04-05", 20);
    this.season("2026-sub20", "2026-04-06", 30, uid(9, 1));
  }

  season(name: string, start: string, played: number, category: string | null = null) {
    const n = this.rows.championship.length + 1;
    const [championship, phase, group] = [uid(3, n), uid(4, n), uid(5, n)];
    this.phases[name] = phase;
    this.groups[name] = group;
    this.rows.championship.push({
      id: championship,
      name,
      category_id: category,
      point_win: "3",
      point_draw: "1",
      point_loss: "0",
    });
    this.rows.phase.push({
      id: phase,
      championship_id: championship,
      sort: "pt,w,gd,gf,name",
      bonus_points: "0",
      bonus_points_threshold: "0",
    });
    this.rows.stage_group.push({ id: group, phase_id: phase });
    this.teams.forEach((team, t) =>
      this.rows.team_group.push({
        id: uid(6, n * 100 + t),
        group_id: group,
        team_id: team,
        add_sub: t === 5 && category === null ? "-3" : "0",
        bias: "0",
      })
    );
    ([[1, 1, "champion"], [1, 2, "qualify"], [5, 6, "relegation"]] as const).forEach(([first, last, color], z) =>
      this.rows.zone.push({ id: uid(7, n * 10 + z), group_id: group, first: `${first}`, last: `${last}`, color })
    );
    const pairs: [number, number][] = [];
    for (let h = 0; h < 6; h++) for (let a = 0; a < 6; a++) if (h !== a) pairs.push([h, a]);
    this.rng.shuffle(pairs);
    pairs.forEach(([h, a], k) => {
      const game = uid(8, n * 1000 + k);
      const day = plusDays(start, 7 * Math.floor(k / 3));
      const row: Row = {
        id: game,
        phase_id: phase,
        day,
        kickoff: k % 2 ? `${day} 19:00:00+00` : null,
        home_id: this.teams[h],
        away_id: this.teams[a],
        home_field: k === 3 ? "neutral" : "left",
        played: "false",
        home_score: null,
        away_score: null,
        home_aet: null,
        away_aet: null,
      };
      this.rows.game.push(row);
      if (k >= played) {
        if (category === null) this.left.push(game);
        return;
      }
      const [hs, as] = [this.rng.poisson(1.6 - 0.15 * h), this.rng.poisson(1.1 - 0.1 * a)];
      Object.assign(row, { played: "true", home_score: `${hs}`, away_score: `${as}` });
      if (k === 5) Object.assign(row, { home_aet: "1", away_aet: "0" });
      this.lineups(game, h, a, k, hs + (k === 5 ? 1 : 0), as);
    });
  }

  lineups(game: string, h: number, a: number, k: number, homeGoals: number, awayGoals: number) {
    for (const [side, t] of [["home", h], ["away", a]] as const) {
      this.players[this.teams[t]].forEach((p, j) => {
        const red = side === "away" && j === 3 && k === 7;
        this.rows.player_game.push({
          id: uid(10, this.rows.player_game.length + 1),
          game_id: game,
          player_id: p,
          side,
          on_minute: "0",
          off_minute: red ? "70" : "90",
          red: red ? "true" : "false",
        });
      });
    }
    for (const [side, t, goals] of [["home", h, homeGoals], ["away", a, awayGoals]] as const) {
      for (let q = 0; q < goals; q++) {
        const own = k === 2 && q === 0;
        const scorerTeam = own ? (side === "home" ? a : h) : t;
        const scorer = this.players[this.teams[scorerTeam]][this.rng.integer(5, 10)];
        const minute = k === 4 && q === 0 ? null : `${this.rng.integer(1, 91)}`;
        this.rows.goal.push({
          id: uid(11, this.rows.goal.length + 1),
          game_id: game,
          player_id: scorer,
          side,
          minute,
          penalty: k === 6 && q === 0 && !own ? "true" : "false",
          own_goal: own ? "true" : "false",
        });
      }
    }
  }

  /** The standings stream's rows for these games, ranked by the phases'
   * ladder (pt,w,gd,gf,name). */
  standing(): Row[] {
    const names = Object.fromEntries(this.rows.team.map((t) => [t.id, t.name!]));
    const rows: Row[] = [];
    for (const { id: group, phase_id: phase } of this.rows.stage_group) {
      const table: Record<string, { pt: number; w: number; gd: number; gf: number; played: number }> = {};
      for (const m of this.rows.team_group.filter((m) => m.group_id === group)) {
        table[m.team_id!] = { pt: Number(m.add_sub), w: 0, gd: 0, gf: 0, played: 0 };
      }
      for (const g of this.rows.game.filter((g) => g.phase_id === phase && g.played === "true")) {
        for (const [team, own, other] of [[g.home_id, g.home_score, g.away_score], [g.away_id, g.away_score, g.home_score]]) {
          const c = table[team!];
          if (c === undefined) continue;
          const [o, x] = [Number(own), Number(other)];
          c.pt += o > x ? 3 : o === x ? 1 : 0;
          c.w += o > x ? 1 : 0;
          c.gd += o - x;
          c.gf += o;
          c.played += 1;
        }
      }
      const order = Object.keys(table).sort((s, t) => {
        const [a, b] = [table[s], table[t]];
        return b.pt - a.pt || b.w - a.w || b.gd - a.gd || b.gf - a.gf || (names[s] < names[t] ? -1 : 1);
      });
      order.forEach((t, i) =>
        rows.push({
          id: `${group}:${t}`,
          group_id: group,
          team_id: t,
          position: `${i + 1}`,
          points: `${table[t].pt}`,
          played: `${table[t].played}`,
        })
      );
    }
    return rows;
  }

  /** An in-memory lake of these rows, plus `extra` rows by table; the
   * standing is these games' unless `extra` names it. */
  async lake(extra: Record<string, Row[]> = {}): Promise<Reader> {
    const con = await (await duckdb()).connect();
    for (const [table, columns] of Object.entries(TABLES)) {
      await con.run(`CREATE TABLE ${table} (${columns})`);
      const names = columns.split(", ").map((c) => c.split(" ")[0]);
      const rows = table === "standing" ? extra.standing ?? this.standing() : [...this.rows[table], ...(extra[table] ?? [])];
      if (rows.length === 0) continue;
      const tuple = `(${names.map(() => "?").join(", ")})`;
      await con.run(
        `INSERT INTO ${table} VALUES ${rows.map(() => tuple).join(", ")}`,
        rows.flatMap((r) => names.map((c) => r[c] ?? null)),
      );
    }
    return readerOf(con);
  }
}
