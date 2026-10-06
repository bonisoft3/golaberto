-- Original group zones own a color, source-array order and explicit positions.
-- Retained role tokens are normalized once; daily probability history is untouched.
SET lock_timeout='5s';
SET statement_timeout='10min';
BEGIN;
ALTER TABLE zone ADD COLUMN IF NOT EXISTS position portable_int32;
ALTER TABLE zone ADD COLUMN IF NOT EXISTS positions_json portable_string;
ALTER TABLE zone_chance ADD COLUMN IF NOT EXISTS position portable_int32;

CREATE OR REPLACE FUNCTION canonical_zone_color(value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE value WHEN 'champion' THEN '#22bb22' WHEN 'promotion' THEN '#add8e6'
    WHEN 'qualify' THEN '#55dd55' WHEN 'playoff' THEN '#99e699'
    WHEN 'relegation' THEN '#ffb6c1' ELSE lower(value) END
$$;
CREATE OR REPLACE FUNCTION canonical_zone_positions(value text,first_position integer,last_position integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE positions jsonb;
BEGIN
  IF value IS NULL THEN
    SELECT jsonb_agg(p ORDER BY p) INTO positions FROM generate_series(first_position,last_position) p;
  ELSE
    positions:=value::jsonb;
  END IF;
  IF positions IS NULL OR jsonb_typeof(positions)<>'array' OR jsonb_array_length(positions)=0 THEN
    RAISE EXCEPTION 'zone positions must be a nonempty array' USING ERRCODE='check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(positions) p WHERE jsonb_typeof(p)<>'number'
    OR p::text !~ '^[1-9][0-9]*$' OR length(p::text)>10
    OR (p::text)::numeric>2147483647) THEN
    RAISE EXCEPTION 'zone positions must be positive int32 numbers' USING ERRCODE='check_violation';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT p) FROM jsonb_array_elements(positions) p) THEN
    RAISE EXCEPTION 'zone positions must be unique' USING ERRCODE='check_violation';
  END IF;
  RETURN (SELECT jsonb_agg(p::integer ORDER BY p::integer)::text FROM jsonb_array_elements_text(positions) p);
END $$;

-- Drop the old enum checks (and the equivalent generated fresh checks) before
-- normalizing retained values. Reinstall one explicit validated color contract.
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_color_check;
ALTER TABLE zone_chance DROP CONSTRAINT IF EXISTS zone_chance_color_check;
ALTER TABLE standing DROP CONSTRAINT IF EXISTS standing_zone_check;
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_color_hex_check;
ALTER TABLE zone_chance DROP CONSTRAINT IF EXISTS zone_chance_color_hex_check;
ALTER TABLE standing DROP CONSTRAINT IF EXISTS standing_zone_hex_check;

CREATE OR REPLACE FUNCTION normalize_zone_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  NEW.color:=canonical_zone_color(NEW.color);
  NEW.position:=coalesce(NEW.position,0);
  NEW.positions_json:=canonical_zone_positions(NEW.positions_json,NEW.first,NEW.last);
  SELECT min(p::integer),max(p::integer) INTO NEW.first,NEW.last
    FROM jsonb_array_elements_text(NEW.positions_json::jsonb) p;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS normalize_zone_fields ON zone;
CREATE TRIGGER normalize_zone_fields BEFORE INSERT OR UPDATE OF color,position,positions_json,first,last
  ON zone FOR EACH ROW EXECUTE FUNCTION normalize_zone_fields();

-- An older retained schema has no source order. Preserve its deterministic
-- first/last ordering until the importer supplies the original YAML ordinal.
WITH ranked AS (
  SELECT id,(row_number() OVER(PARTITION BY group_id ORDER BY first,last,id)-1)::integer AS ordinal
  FROM zone
)
UPDATE zone z SET position=coalesce(z.position,r.ordinal),positions_json=z.positions_json,color=z.color
FROM ranked r WHERE r.id=z.id AND (z.position IS NULL OR z.positions_json IS NULL OR z.color<>canonical_zone_color(z.color));
ALTER TABLE zone ALTER COLUMN position SET DEFAULT 0;
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_position_check;
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_position_not_null_check;
ALTER TABLE zone ADD CONSTRAINT zone_position_not_null_check CHECK(position IS NOT NULL) NOT VALID;
ALTER TABLE zone ADD CONSTRAINT zone_position_check CHECK(position>=0) NOT VALID;
ALTER TABLE zone ADD CONSTRAINT zone_color_hex_check CHECK(color ~ '^#[0-9a-f]{6}$') NOT VALID;
COMMIT;
BEGIN;
ALTER TABLE zone VALIDATE CONSTRAINT zone_position_not_null_check;
ALTER TABLE zone VALIDATE CONSTRAINT zone_position_check;
ALTER TABLE zone VALIDATE CONSTRAINT zone_color_hex_check;

CREATE OR REPLACE FUNCTION normalize_zone_projection_color() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='standing' THEN
    NEW.zone:=canonical_zone_color(NEW.zone);
  ELSE
    NEW.color:=canonical_zone_color(NEW.color);
    NEW.position:=coalesce(NEW.position,0);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS normalize_standing_zone_color ON standing;
CREATE TRIGGER normalize_standing_zone_color BEFORE INSERT OR UPDATE OF zone ON standing
  FOR EACH ROW EXECUTE FUNCTION normalize_zone_projection_color();
DROP TRIGGER IF EXISTS normalize_zone_chance_color ON zone_chance;
CREATE TRIGGER normalize_zone_chance_color BEFORE INSERT OR UPDATE OF color,position ON zone_chance
  FOR EACH ROW EXECUTE FUNCTION normalize_zone_projection_color();
UPDATE zone_chance c SET color=z.color,position=z.position FROM zone z
  WHERE z.id=c.zone_id AND (c.color,c.position) IS DISTINCT FROM (z.color,z.position);
UPDATE standing s SET zone=coalesce((SELECT z.color FROM zone z WHERE z.group_id=s.group_id
    AND z.positions_json::jsonb @> jsonb_build_array(s.position) ORDER BY z.position,z.id LIMIT 1),'')
  WHERE s.zone IS DISTINCT FROM coalesce((SELECT z.color FROM zone z WHERE z.group_id=s.group_id
    AND z.positions_json::jsonb @> jsonb_build_array(s.position) ORDER BY z.position,z.id LIMIT 1),'');
ALTER TABLE zone_chance ALTER COLUMN position SET DEFAULT 0;
ALTER TABLE zone_chance DROP CONSTRAINT IF EXISTS zone_chance_position_check;
ALTER TABLE zone_chance DROP CONSTRAINT IF EXISTS zone_chance_position_not_null_check;
ALTER TABLE zone_chance ADD CONSTRAINT zone_chance_position_not_null_check CHECK(position IS NOT NULL) NOT VALID;
ALTER TABLE zone_chance ADD CONSTRAINT zone_chance_position_check CHECK(position>=0) NOT VALID;
ALTER TABLE zone_chance ADD CONSTRAINT zone_chance_color_hex_check CHECK(color ~ '^#[0-9a-f]{6}$') NOT VALID;
ALTER TABLE standing ADD CONSTRAINT standing_zone_hex_check CHECK(zone='' OR zone ~ '^#[0-9a-f]{6}$') NOT VALID;
COMMIT;
BEGIN;
ALTER TABLE zone_chance VALIDATE CONSTRAINT zone_chance_position_not_null_check;
ALTER TABLE zone_chance VALIDATE CONSTRAINT zone_chance_position_check;
ALTER TABLE zone_chance VALIDATE CONSTRAINT zone_chance_color_hex_check;
ALTER TABLE standing VALIDATE CONSTRAINT standing_zone_hex_check;

-- Repaint existing materialized rows without recomputing probabilities or
-- standings scores. The ordinary source pipelines still own numeric results.
CREATE OR REPLACE FUNCTION refresh_zone_projection_colors() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP<>'DELETE' THEN
    UPDATE zone_chance SET color=NEW.color,position=NEW.position
      WHERE zone_id=NEW.id AND (color,position) IS DISTINCT FROM (NEW.color,NEW.position);
  END IF;
  UPDATE standing s SET zone=coalesce((SELECT z.color FROM zone z WHERE z.group_id=s.group_id
      AND z.positions_json::jsonb @> jsonb_build_array(s.position) ORDER BY z.position,z.id LIMIT 1),'')
    WHERE ((TG_OP<>'INSERT' AND s.group_id=OLD.group_id) OR (TG_OP<>'DELETE' AND s.group_id=NEW.group_id))
      AND s.zone IS DISTINCT FROM coalesce((SELECT z.color FROM zone z WHERE z.group_id=s.group_id
        AND z.positions_json::jsonb @> jsonb_build_array(s.position) ORDER BY z.position,z.id LIMIT 1),'');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zone_projection_colors_insert_delete ON zone;
CREATE TRIGGER zone_projection_colors_insert_delete AFTER INSERT OR DELETE ON zone
  FOR EACH ROW EXECUTE FUNCTION refresh_zone_projection_colors();
DROP TRIGGER IF EXISTS zone_projection_colors_update ON zone;
CREATE TRIGGER zone_projection_colors_update AFTER UPDATE ON zone FOR EACH ROW
  WHEN ((OLD.group_id,OLD.color,OLD.position,OLD.positions_json) IS DISTINCT FROM (NEW.group_id,NEW.color,NEW.position,NEW.positions_json))
  EXECUTE FUNCTION refresh_zone_projection_colors();

CREATE OR REPLACE FUNCTION build_team_odds_progress(target_group uuid,target_team uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH members AS (
    SELECT count(*)::integer AS n FROM team_group WHERE group_id=target_group
  ), zones AS (
    SELECT id,name,color,first,last,position,positions_json::jsonb AS positions FROM zone WHERE group_id=target_group
  ), daily AS (
    SELECT h.recorded_on,min(h.captured_at) AS captured_at,min(h.source::text) AS source,
      jsonb_object_agg(h.position::text,h.percent ORDER BY h.position) AS percentages,
      -- A 0.05 percentage-point tolerance admits rounding only; values are never
      -- normalized, clamped, filled or combined across different captures.
      count(*)=m.n AND min(h.position)=1 AND max(h.position)=m.n
        AND count(DISTINCT h.position)=m.n
        AND bool_and(h.percent BETWEEN 0 AND 100)
        AND abs(sum(h.percent::numeric)-100)<=0.05
        AND count(DISTINCT h.source)=1
        AND (count(h.captured_at)=0 OR
          (count(h.captured_at)=count(*) AND count(DISTINCT h.captured_at)=1)) AS complete
    FROM team_odds_history h CROSS JOIN members m
    WHERE h.group_id=target_group AND h.team_id=target_team
    GROUP BY h.recorded_on,m.n
  ), ordered AS (
    SELECT *,row_number() OVER(ORDER BY recorded_on) AS rn,count(*) OVER() AS n
    FROM daily WHERE complete
  ), picked AS (
    -- Retain a maximum of 360 shared dates including both endpoints. Sampling
    -- selects whole snapshots, so every position and hover value stays aligned.
    SELECT o.* FROM ordered o WHERE n<=360 OR rn IN (
      SELECT 1+floor(k::numeric*(o.n-1)/359)::bigint FROM generate_series(0,359) k
    )
  ), snapshots AS (
    SELECT d.recorded_on,jsonb_build_object('day',d.recorded_on::text,
      'capturedAt',CASE WHEN d.captured_at IS NULL THEN NULL ELSE
        to_char(d.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'source',d.source,'percentages',d.percentages,'lastGame',g.value,
      'zoneValues',coalesce((SELECT jsonb_object_agg(z.id::text,
        (SELECT coalesce(sum((d.percentages->>p::text)::numeric),0)
          FROM jsonb_array_elements_text(z.positions) p WHERE p::integer BETWEEN 1 AND m.n))
        FROM zones z),'{}'::jsonb)) AS value
    FROM picked d CROSS JOIN members m
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id',g.id,'homeName',h.name,'awayName',a.name,
        'homeScore',g.home_score,'awayScore',g.away_score) AS value
      FROM stage_group sg JOIN game g ON g.phase_id=sg.phase_id
        JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
      WHERE sg.id=target_group AND g.played AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND (g.home_id=target_team OR g.away_id=target_team)
        AND CASE WHEN d.captured_at IS NULL THEN
          CASE WHEN g.kickoff IS NULL THEN g.day<=d.recorded_on
            ELSE g.kickoff < ((d.recorded_on+1)::timestamp AT TIME ZONE 'UTC') END
          ELSE CASE WHEN g.kickoff IS NULL THEN g.day < (d.captured_at AT TIME ZONE 'UTC')::date
            ELSE g.kickoff<=d.captured_at END END
      -- Unknown kickoff is eligible only before a known capture's UTC day;
      -- imported date-only snapshots use the end of their recorded UTC day.
      ORDER BY g.day DESC,g.kickoff DESC NULLS LAST,g.id DESC LIMIT 1
    ) g ON true
  )
  SELECT jsonb_build_object('version',1,'kind','odds-progress','positionCount',m.n,
    'sourceCount',(SELECT count(*) FROM daily),
    'retainedCount',(SELECT count(*) FROM picked),
    'omittedCount',(SELECT count(*) FROM daily WHERE NOT complete),
    'zones',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'color',color,
      'first',first,'last',last,'position',position,'positions',positions) ORDER BY position,id) FROM zones),'[]'::jsonb),
    'positions',coalesce((SELECT jsonb_agg(jsonb_build_object('position',p,
      'color',coalesce((SELECT color::text FROM zones WHERE positions @> jsonb_build_array(p) ORDER BY position,id LIMIT 1),'#d3d3d3'),
      'zoneIds',coalesce((SELECT jsonb_agg(id ORDER BY position,id) FROM zones WHERE positions @> jsonb_build_array(p)),'[]'::jsonb))
      ORDER BY p DESC) FROM generate_series(1,m.n) p),'[]'::jsonb),
    'snapshots',coalesce((SELECT jsonb_agg(value ORDER BY recorded_on) FROM snapshots),'[]'::jsonb))
  FROM members m
$$;

REVOKE ALL ON FUNCTION canonical_zone_color(text),canonical_zone_positions(text,integer,integer),
  normalize_zone_fields(),normalize_zone_projection_color(),refresh_zone_projection_colors() FROM PUBLIC,anon,app_user;
GRANT EXECUTE ON FUNCTION canonical_zone_color(text),canonical_zone_positions(text,integer,integer) TO service;
-- Queue only groups having source snapshots. The existing bounded drain owns
-- projection materialization; this upgrade never rewrites historical vectors.
INSERT INTO team_odds_chart_dirty(group_id,revision)
SELECT group_id,nextval('team_odds_chart_revision_seq') FROM (SELECT DISTINCT group_id FROM team_odds_history) groups
ON CONFLICT(group_id) DO UPDATE SET revision=EXCLUDED.revision;
NOTIFY pgrst, 'reload schema';
COMMIT;
