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
