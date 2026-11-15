BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10min';
WITH normalized AS (
 SELECT team_id,measure_date,id,
   offense::double precision::real::double precision AS offense,
   defense::double precision::real::double precision AS defense
 FROM team_rating
), steps AS (
 SELECT *,row_number() OVER w AS n,
   lag(offense) OVER w AS previous_offense,lag(defense) OVER w AS previous_defense
 FROM normalized WINDOW w AS (PARTITION BY team_id ORDER BY measure_date,id)
)
SELECT jsonb_build_object(
 'rating_rows',count(*),
 'rating_change_points',count(*) FILTER(WHERE n=1 OR
   ROW(offense,defense) IS DISTINCT FROM ROW(previous_offense,previous_defense))
) AS change_point_measurement FROM steps;
ROLLBACK;
