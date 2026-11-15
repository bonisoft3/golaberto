WITH "__duckstream_0" AS (SELECT t.c0 AS c0 FROM (SELECT "id" AS c0, "position" AS c1 FROM "source_player") t)
SELECT CAST(result.c0 AS VARCHAR) AS "id" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
