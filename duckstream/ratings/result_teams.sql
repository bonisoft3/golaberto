WITH "__duckstream_0" AS (SELECT "id" AS c0 FROM "source_team")
SELECT CAST(result.c0 AS VARCHAR) AS "id" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
