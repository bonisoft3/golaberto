import { query } from "./db.ts";

// Resolving route fixtures before the asynchronous bootstrap misses deep routes;
// photographing a partial projection measures bootstrap layout shifts instead.
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
SELECT (SELECT count(*) FROM expected), (SELECT count(*) FROM missing), (SELECT count(*) FROM extra)`;

const deadline = Date.now() + 300_000;
let last = "";
while (true) {
  const state = await query(readiness);
  const [expected, missing, extra] = state.split("|").map(Number);
  if (expected > 0 && missing === 0 && extra === 0) {
    console.log(`visual-ready: ${expected} player-stat fixture scopes ready`);
    break;
  }
  if (state !== last) {
    console.log(`visual-ready: ${missing}/${expected} player-stat fixture scopes missing; ${extra} extra`);
    last = state;
  }
  if (Date.now() >= deadline) throw new Error(`player-stat fixture bootstrap timed out: ${state}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
