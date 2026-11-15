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
           z.last::INTEGER AS last, z.positions, z.color
    FROM zone z JOIN ranked USING (group_id) ORDER BY 1, 3, 4, 2`,
};
