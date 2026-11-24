WITH "sides" AS (SELECT id,phase_id,day,kickoff,played,fixture_available,home_id AS team_id,away_id AS opponent_id,
 CAST('home' AS VARCHAR) AS side,home_score AS gf,away_score AS ga FROM source_game
 UNION ALL
 SELECT id,phase_id,day,kickoff,played,fixture_available,away_id AS team_id,home_id AS opponent_id,
 CAST('away' AS VARCHAR) AS side,away_score AS gf,home_score AS ga FROM source_game)
SELECT CAST(result."id" AS VARCHAR) AS "id", CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."game_id" AS VARCHAR) AS "game_id", CAST(result."side" AS VARCHAR) AS "side", CAST(result."opponent_id" AS VARCHAR) AS "opponent_id", CAST(result."opponent_name" AS VARCHAR) AS "opponent_name", CAST(result."championship_id" AS VARCHAR) AS "championship_id", CAST(result."championship_name" AS VARCHAR) AS "championship_name", CAST(result."day" AS VARCHAR) AS "day", CAST(result."kickoff" AS VARCHAR) AS "kickoff", CAST(result."played" AS BOOLEAN) AS "played", CAST(result."goals_for" AS INTEGER) AS "goals_for", CAST(result."goals_against" AS INTEGER) AS "goals_against", CAST(result."result" AS VARCHAR) AS "result", CAST(result."category_id" AS VARCHAR) AS "category_id", CAST(result."phase_key" AS VARCHAR) AS "phase_key", CAST(result."category_key" AS VARCHAR) AS "category_key", CAST(result."fixture_available" AS BOOLEAN) AS "fixture_available" FROM (SELECT g.team_id || ':' || g.id AS id,g.team_id,g.id AS game_id,g.side,g.opponent_id,
 opponent.name AS opponent_name,p.championship_id,c.full_name AS championship_name,g.day,g.kickoff,g.played,
 g.gf AS goals_for,g.ga AS goals_against,
 CAST(CASE WHEN NOT g.played THEN '' WHEN g.gf>g.ga THEN 'w' WHEN g.gf<g.ga THEN 'l' ELSE 'd' END AS VARCHAR) AS result,
 c.category_id,p.id AS phase_key,COALESCE(c.category_id,'professional') AS category_key,g.fixture_available
 FROM sides g JOIN source_phase p ON p.id=g.phase_id JOIN source_championship c ON c.id=p.championship_id
 JOIN source_team opponent ON opponent.id=g.opponent_id) result;
