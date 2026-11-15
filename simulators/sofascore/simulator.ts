// The sofascore bridge's local stand-in: tools/sofascore-fetch's HTTP contract
// (POST /fetch {id, path}, GET /healthz), answering SofaScore's paths for one
// simulated league (season.json) clocked against now, so a launched app sees a
// season under way, plus the end-to-end test's scripted answers (cases.json)
// on their own paths. It reaches nothing outside the stack.
type Hop = { status: number; url: string };
type Answer = { status: number; body: unknown; headers?: Record<string, string>; redirects?: Hop[]; error?: string };
type Player = { id: number; name: string; position: string };
type Team = { id: number; name: string; players: Player[] };
type Season = {
  uniqueTournament: { id: number; name: string };
  season: { id: number; year: string };
  tournament: { id: number; name: string };
  teams: Team[];
};

const BASE = "https://www.sofascore.com/api/v1/";
const here = (file: string) => new URL(`./${file}`, import.meta.url);
const season: Season = JSON.parse(await Deno.readTextFile(here("season.json")));
const cases: Record<string, Answer> = JSON.parse(await Deno.readTextFile(here("cases.json")));

const WEEK = 7 * 24 * 3600;
const MATCH = 2 * 3600;
const ROUNDS = 2 * (season.teams.length - 1);
const PER_ROUND = season.teams.length / 2;
// The season is always under way: its round 1 kicked off nine weeks before
// the current week's Sunday 19:00 UTC.
function opening(now: number): number {
  const day = Math.floor(now / 86400);
  const sunday = (day - ((day + 4) % 7)) * 86400 + 19 * 3600;
  return sunday - 9 * WEEK;
}

// The circle method, reversed for the second half.
function fixtures(round: number): [Team, Team][] {
  const n = season.teams.length;
  const leg = (round - 1) % (n - 1);
  const rest = season.teams.slice(1);
  const rotated = rest.slice(leg).concat(rest.slice(0, leg));
  const order = [season.teams[0], ...rotated];
  const pairs: [Team, Team][] = [];
  for (let i = 0; i < n / 2; i++) {
    const a = order[i], b = order[n - 1 - i];
    const homeFirst = (i + leg) % 2 === 0;
    pairs.push(homeFirst ? [a, b] : [b, a]);
  }
  return round > n - 1 ? pairs.map(([h, a]) => [a, h]) : pairs;
}

// A deterministic draw per event, so every answer about one match agrees.
function draw(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) % 1000) / 1000;
}
const goals = (r: () => number) => [0, 0, 1, 1, 1, 2, 2, 3, 4][Math.floor(r() * 9)];

const eventId = (round: number, index: number) => season.tournament.id * 1000 + round * 10 + index;
function located(id: number): { round: number; index: number } | undefined {
  const rest = id - season.tournament.id * 1000;
  const round = Math.floor(rest / 10), index = rest % 10;
  return round >= 1 && round <= ROUNDS && index < PER_ROUND ? { round, index } : undefined;
}

type Goal = { minute: number; home: boolean; scorer: Player };
function match(round: number, index: number, now: number) {
  const [home, away] = fixtures(round)[index];
  const start = opening(now) + (round - 1) * WEEK + (index % 3) * 2 * 3600;
  const r = draw(eventId(round, index));
  const final = [goals(r), goals(r)];
  const scored: Goal[] = [];
  for (const [side, team] of [[0, home], [1, away]] as const) {
    for (let g = 0; g < final[side]; g++) {
      scored.push({ minute: 1 + Math.floor(r() * 90), home: side === 0, scorer: team.players[5 + Math.floor(r() * 6)] });
    }
  }
  scored.sort((a, b) => a.minute - b.minute);
  const elapsed = Math.floor((now - start) / 60);
  const state = now < start ? "notstarted" : now < start + MATCH ? "inprogress" : "finished";
  const minute = state === "finished" ? 90 : Math.max(0, Math.min(90, elapsed - (elapsed > 45 ? 15 : 0)));
  const seen = state === "notstarted" ? [] : scored.filter((g) => g.minute <= minute);
  return { home, away, start, state, scored: seen, minute };
}

function event(round: number, index: number, now: number) {
  const m = match(round, index, now);
  const score = (home: boolean) => {
    const current = m.scored.filter((g) => g.home === home).length;
    return m.state === "notstarted" ? {} : { current, display: current, normaltime: current };
  };
  return {
    id: eventId(round, index),
    tournament: { id: season.tournament.id, name: season.tournament.name, uniqueTournament: { id: season.uniqueTournament.id, name: season.uniqueTournament.name } },
    season: { id: season.season.id, year: season.season.year },
    roundInfo: { round },
    status: { type: m.state, description: m.state === "inprogress" ? `${m.minute}'` : m.state === "finished" ? "Ended" : "Not started" },
    homeTeam: { id: m.home.id, name: m.home.name },
    awayTeam: { id: m.away.id, name: m.away.name },
    homeScore: score(true),
    awayScore: score(false),
    startTimestamp: m.start,
  };
}

function lineups(round: number, index: number, now: number) {
  const m = match(round, index, now);
  const side = (team: Team) => ({
    players: team.players.map((p, i) => ({ player: { id: p.id, name: p.name }, position: p.position, substitute: i >= 11 })),
  });
  return { confirmed: true, home: side(m.home), away: side(m.away) };
}

function incidents(round: number, index: number, now: number) {
  const m = match(round, index, now);
  const r = draw(eventId(round, index) + 7);
  const list: Record<string, unknown>[] = m.scored.map((g, i) => ({
    id: eventId(round, index) * 100 + i,
    incidentType: "goal",
    incidentClass: "regular",
    isHome: g.home,
    time: g.minute,
    player: { id: g.scorer.id, name: g.scorer.name },
  }));
  if (m.minute >= 60) {
    for (const [home, team] of [[true, m.home], [false, m.away]] as const) {
      const out = team.players[6 + Math.floor(r() * 4)], into = team.players[13 + Math.floor(r() * 3)];
      list.push({ id: eventId(round, index) * 100 + 50 + (home ? 0 : 1), incidentType: "substitution", isHome: home, time: 60 + Math.floor(r() * 25), playerIn: { id: into.id, name: into.name }, playerOut: { id: out.id, name: out.name } });
    }
  }
  if (m.minute >= 30) {
    const home = r() < 0.5, booked = (home ? m.home : m.away).players[1 + Math.floor(r() * 8)];
    list.push({ id: eventId(round, index) * 100 + 60, incidentType: "card", incidentClass: "yellow", isHome: home, time: 30 + Math.floor(r() * (m.minute - 29)), player: { id: booked.id, name: booked.name } });
  }
  if (m.state === "finished") list.push({ id: eventId(round, index) * 100 + 99, incidentType: "period", text: "FT", time: 90 });
  return { incidents: list.sort((a, b) => (b.time as number) - (a.time as number)) };
}

function simulated(path: string, now: number): Answer | undefined {
  const t = `unique-tournament/${season.uniqueTournament.id}/season/${season.season.id}`;
  const current = Math.min(ROUNDS, Math.max(1, Math.floor((now - opening(now)) / WEEK) + 1));
  if (path === `${t}/rounds`) {
    return { status: 200, body: { currentRound: { round: current }, rounds: Array.from({ length: ROUNDS }, (_, i) => ({ round: i + 1 })) } };
  }
  const round = path.match(new RegExp(`^${t}/events/round/(\\d+)$`));
  if (round) {
    const n = Number(round[1]);
    if (n < 1 || n > ROUNDS) return { status: 404, body: { error: { code: 404, message: "Not Found" } } };
    return { status: 200, body: { events: Array.from({ length: PER_ROUND }, (_, i) => event(n, i, now)) } };
  }
  const detail = path.match(/^event\/(\d+)(?:\/(lineups|incidents))?$/);
  const at = detail ? located(Number(detail[1])) : undefined;
  if (detail && at) {
    const body = detail[2] === "lineups" ? lineups(at.round, at.index, now)
      : detail[2] === "incidents" ? incidents(at.round, at.index, now)
      : { event: event(at.round, at.index, now) };
    return { status: 200, body };
  }
  return undefined;
}

function answer(id: unknown, path: string, now: number) {
  // A scripted case is a contract with a test: one it lacks is a failure.
  const scripted = path.startsWith("e2e/") ? cases[path] : undefined;
  if (path.startsWith("e2e/") && scripted === undefined) throw new Error(`no scripted case for ${path}`);
  const r = scripted ?? simulated(path, now) ?? { status: 404, body: { error: { code: 404, message: "Not Found" } } };
  const redirects = r.redirects ?? [];
  return {
    id,
    status: r.status,
    headers: r.headers ?? { "content-type": "application/json" },
    body: typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    final_url: redirects.at(-1)?.url ?? new URL(path, BASE).href,
    redirects,
    requests: 1 + redirects.length,
    elapsed_ms: 0,
    error: r.error ?? null,
  };
}

const listen = Deno.args[0]?.match(/^(.+):(\d+)$/);
if (!listen) throw new Error("usage: simulator.ts <host>:<port>");
Deno.serve({ hostname: listen[1], port: Number(listen[2]) }, async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/healthz" && request.method === "GET") return Response.json({});
  if (pathname !== "/fetch") return Response.json({ error: "unknown path" }, { status: 404 });
  if (request.method !== "POST") return Response.json({ error: "only POST /fetch" }, { status: 405 });
  const { id, path } = await request.json();
  return Response.json(answer(id ?? null, path, Math.floor(Date.now() / 1000)));
});
