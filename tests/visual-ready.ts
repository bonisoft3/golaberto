import { query } from "./db.ts";

// Resolving route fixtures before the asynchronous bootstrap misses deep routes;
// photographing while computations or downstream drains still rewrite live
// tables expires Electric shape handles (HTTP 409) and shifts layout mid-capture,
// and holds the locks the constraints check's migration replays take.
const readiness = `WITH expected AS (
  SELECT p.championship_id,
    CASE a.side WHEN 'home' THEN g.home_id ELSE g.away_id END AS team_id,
    a.player_id
  FROM player_game a JOIN game g ON g.id=a.game_id JOIN phase p ON p.id=g.phase_id
  UNION
  SELECT p.championship_id,
    CASE WHEN (a.side='home')<>a.own_goal THEN g.home_id ELSE g.away_id END,
    a.player_id
  FROM goal a JOIN game g ON g.id=a.game_id JOIN phase p ON p.id=g.phase_id
), actual AS (
  SELECT championship_id,team_id,player_id FROM player_stat
), missing AS (
  SELECT * FROM expected EXCEPT SELECT * FROM actual
), extra AS (
  SELECT * FROM actual EXCEPT SELECT * FROM expected
)
SELECT
  (SELECT count(*) FROM expected),
  (SELECT count(*) FROM missing),
  (SELECT count(*) FROM extra),
  (SELECT CASE WHEN count(*) = 6 AND bool_and(completed = requested AND completed > 0 AND claimed IS NULL) THEN 1 ELSE 0 END FROM compute.batch),
  (SELECT count(*) FROM durex.work WHERE settled_at IS NULL),
  (
    (SELECT count(*) FROM player_metric_dirty) +
    (SELECT count(*) FROM team_roster_total_dirty) +
    (SELECT count(*) FROM team_rating_chart_dirty) +
    (SELECT count(*) FROM team_odds_chart_dirty) +
    (SELECT count(*) FROM team_profile_dirty)
  )`;

const deadline = Date.now() + 300_000;
let last = "";
let stable = 0;
while (true) {
  const state = await query(readiness);
  const [expected, missing, extra, batchesReady, unsettledWork, dirtyRows] = state.split("|").map(Number);
  if (expected > 0 && missing === 0 && extra === 0 && batchesReady === 1 && unsettledWork === 0 && dirtyRows === 0) {
    stable++;
    if (stable >= 3) {
      console.log(`visual-ready: ${expected} player-stat fixture scopes and 6 computations settled`);
      break;
    }
  } else {
    stable = 0;
    if (state !== last) {
      console.log(`visual-ready: waiting (${state})`);
      last = state;
    }
  }
  if (Date.now() >= deadline) throw new Error(`visual-ready bootstrap timed out: ${state}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
