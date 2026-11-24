WITH "archive" AS (SELECT x.* FROM source_game x
 JOIN source_team h ON h.id=x.home_id
 JOIN source_team a ON a.id=x.away_id
 JOIN source_phase p ON p.id=x.phase_id
 JOIN source_championship c ON c.id=p.championship_id
 WHERE c.category_id IS NULL AND x.played),
"statistics_window" AS (SELECT date_trunc('month', make_timestamp((CASE WHEN (MAX(utc)) IS NULL OR isfinite(MAX(utc)) THEN epoch_us(MAX(utc)) ELSE error('finite TIMESTAMP required') END))) AS anchor FROM archive),
"boundary" AS (SELECT anchor + INTERVAL '-7 YEAR' AS seven_years FROM statistics_window)
SELECT CAST(result."id" AS VARCHAR) AS "id", CAST(result."home_id" AS VARCHAR) AS "home_id", CAST(result."away_id" AS VARCHAR) AS "away_id", CAST(result."home_field" AS INTEGER) AS "home_field", CAST(result."home_score" AS INTEGER) AS "home_score", CAST(result."away_score" AS INTEGER) AS "away_score", CAST(result."home_aet" AS INTEGER) AS "home_aet", CAST(result."away_aet" AS INTEGER) AS "away_aet", CAST(result."moment" AS BIGINT) AS "moment", CAST(result."date" AS VARCHAR) AS "date" FROM (SELECT x.id,x.home_id,x.away_id,x.home_field,x.home_score,x.away_score,x.home_aet,x.away_aet,
 x.moment,x."date"
 FROM archive x CROSS JOIN boundary b WHERE x.utc>=b.seven_years) result;
