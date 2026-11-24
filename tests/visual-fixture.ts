// Hold check-visual until bootstrap computations and downstream drains finish
// replacing live tables; otherwise mid-crawl publications expire Electric shape
// handles (HTTP 409) and mutate visible rows during capture.
const base = Deno.env.get("APP_URL")?.replace(/\/$/, "");
if (!base) throw new Error("APP_URL is required");

const authResponse = await fetch(`${base}/auth/guest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const authBody = await authResponse.text();
if (!authResponse.ok) {
  throw new Error(`/auth/guest: ${authResponse.status} ${authBody}`);
}
const { token } = JSON.parse(authBody) as { token: string };

async function count(table: string, filter: Record<string, string> = {}): Promise<number> {
  const params = new URLSearchParams({ select: "id", limit: "1", ...filter });
  const response = await fetch(`${base}/crud/${table}?${params}`, {
    headers: {
      authorization: `Bearer ${token}`,
      prefer: "count=exact",
    },
  });
  const body = await response.text();
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`/crud/${table}: ${response.status} ${body}`);
  }
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  if (!Number.isSafeInteger(total)) {
    throw new Error(`/crud/${table}: missing exact count (${response.headers.get("content-range")})`);
  }
  return total;
}

async function distinctRatedTeams(): Promise<number> {
  const response = await fetch(`${base}/crud/team_rating?select=team_id&limit=1000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`/crud/team_rating: ${response.status} ${body}`);
  const rows = JSON.parse(body) as Array<{ team_id: string }>;
  return new Set(rows.map((row) => row.team_id)).size;
}

const minimums: ReadonlyArray<readonly [string, number]> = [
  ["standing", 82],
  ["team_rating", 64],
  ["player_rating", 725],
  ["team_chance", 82],
  ["zone_chance", 300],
  ["position_chance", 1604],
  ["game_importance", 513],
  ["game_card", 1522],
  ["team_game", 3044],
  ["player_stat", 1227],
];

const deadline = Date.now() + 300_000;
let previous = "";
let stable = 0;

while (true) {
  const sinkCounts = await Promise.all(minimums.map(([table]) => count(table)));
  const sinksReady = sinkCounts.every((actual, i) => actual >= minimums[i][1]);

  let drainSnapshot = "";
  let drainsReady = false;
  if (sinksReady) {
    const positionChances = sinkCounts[5];
    const zoneChances = sinkCounts[4];
    const [
      ratedTeams,
      ratedDirectory,
      ratingChartsAll,
      ratingChartsPopulated,
      computedOddsHistory,
      oddsChartsTotal,
      oddsChartsPopulated,
      matchesCards,
      teamChampionships,
      playerStatsMinutes,
      playerStatsGoalsPer90,
      rostersMinutes,
      rostersGoalsPer90,
      rosterTotalsMinutes,
      rosterTotalsGoalsPer90,
    ] = await Promise.all([
      distinctRatedTeams(),
      count("team_directory", { rating: "not.is.null" }),
      count("team_rating_chart", { period: "eq.all", series_json: 'like.*"x":*' }),
      count("team_rating_chart", { series_json: 'like.*"x":*' }),
      count("team_odds_history", { source: "eq.computed" }),
      count("team_odds_chart"),
      count("team_odds_chart", { series_json: 'like.*"x":*' }),
      count("matches_game_card"),
      count("team_championship"),
      count("player_stat", { minutes: "gt.0" }),
      count("player_stat", { goals_per90: "not.is.null" }),
      count("team_roster", { minutes: "gt.0" }),
      count("team_roster", { goals_per90: "not.is.null" }),
      count("team_roster_total", { minutes: "gt.0" }),
      count("team_roster_total", { goals_per90: "not.is.null" }),
    ]);
    drainsReady = ratedTeams > 0 &&
      ratedDirectory === ratedTeams &&
      ratingChartsAll === ratedTeams &&
      computedOddsHistory >= positionChances &&
      oddsChartsTotal >= zoneChances &&
      oddsChartsPopulated > 0 &&
      matchesCards > 0 &&
      teamChampionships > 0 &&
      playerStatsMinutes > 0 &&
      playerStatsGoalsPer90 === playerStatsMinutes &&
      rostersMinutes > 0 &&
      rostersGoalsPer90 === rostersMinutes &&
      rosterTotalsMinutes > 0 &&
      rosterTotalsGoalsPer90 === rosterTotalsMinutes;
    drainSnapshot = [
      ratedTeams,
      ratedDirectory,
      ratingChartsAll,
      ratingChartsPopulated,
      computedOddsHistory,
      oddsChartsTotal,
      oddsChartsPopulated,
      matchesCards,
      teamChampionships,
      playerStatsMinutes,
      playerStatsGoalsPer90,
      rostersMinutes,
      rostersGoalsPer90,
      rosterTotalsMinutes,
      rosterTotalsGoalsPer90,
    ].join("|");
  }

  const state = `${sinkCounts.join("|")}#${drainSnapshot}`;
  if (sinksReady && drainsReady) {
    stable = state === previous ? stable + 1 : 1;
    if (stable >= 5) {
      console.log(`visual-fixture: settled (${state})`);
      break;
    }
  } else {
    stable = 0;
    if (state !== previous) {
      console.log(`visual-fixture: waiting (${state})`);
    }
  }
  previous = state;
  if (Date.now() >= deadline) {
    throw new Error(`visual-fixture bootstrap timed out: ${state}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
