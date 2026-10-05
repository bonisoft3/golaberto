"""Prepare a reviewable restoration of public zone metadata from exported YAML.

Input is parsed groups-yaml.ndjson ([legacy group ID, zone array]). Only matching
legacy-imported rows are changed; independently named/colored editor rows stay.
Redundant interval fragments are consolidated into their original zone's row.
Probability history is never written. The tool only emits transactional SQL.
"""
import argparse
import json
from pathlib import Path
from refresh_archive import literal, uid
from zone_values import color, positions

LEGACY_COLORS = ['#22bb22', '#55dd55', '#99e699', '#add8e6', '#ffb6c1']


def prepare(rows):
    zones, fragments = [], []
    for group, definitions in rows:
        for ordinal, zone in enumerate(definitions or []):
            places = positions(zone)
            paint = color(zone['color'])
            name = zone['name'][:60]
            identifier = uid(5, group * 10000 + ordinal * 100)
            spans = []
            for place in places:
                if spans and place == spans[-1][1] + 1:
                    spans[-1][1] = place
                else:
                    spans.append([place, place])
            zones.append((identifier, uid(4, group), name, paint, min(places), max(places), ordinal, json.dumps(places), spans[0][1]))
            for index, (first, last) in enumerate(spans[1:], 1):
                fragments.append((uid(5, group * 10000 + ordinal * 100 + index), identifier, name, first, last))
    statements = ['\\set ON_ERROR_STOP on', "SET lock_timeout='5s';", "SET statement_timeout='10min';", 'BEGIN;',
                  "SELECT pg_advisory_xact_lock(hashtext('golaberto-public-zone-restore'));",
                  'CREATE TEMP TABLE source_zone(id uuid,group_id uuid,name text,color text,first integer,last integer,position integer,positions_json text,initial_last integer) ON COMMIT DROP;',
                  'CREATE TEMP TABLE source_fragment(id uuid,parent_id uuid,name text,first integer,last integer) ON COMMIT DROP;',
                  'CREATE TEMP TABLE restorable_zone(id uuid PRIMARY KEY,rebuild_chance boolean NOT NULL) ON COMMIT DROP;',
                  'CREATE TEMP TABLE restored_zone_chance(id uuid PRIMARY KEY,first integer,last integer,position integer,color text,percent numeric,band integer,reach text) ON COMMIT DROP;']
    for table, values in [('source_zone', zones), ('source_fragment', fragments)]:
        for offset in range(0, len(values), 500):
            batch = values[offset:offset + 500]
            statements.append(f'INSERT INTO {table} VALUES\n' + ',\n'.join('(' + ','.join(map(literal, row)) + ')' for row in batch) + ';')
    compatible = ','.join(map(literal, LEGACY_COLORS))
    statements += [f"""
-- Source rows remain locked while compatibility and derived values are decided.
DO $$ BEGIN
  PERFORM 1 FROM zone z WHERE EXISTS(SELECT 1 FROM source_zone s WHERE s.id=z.id)
    OR EXISTS(SELECT 1 FROM source_fragment f WHERE f.id=z.id) FOR UPDATE;
END $$;
TRUNCATE restorable_zone,restored_zone_chance;
INSERT INTO restorable_zone(id,rebuild_chance)
SELECT s.id,EXISTS(SELECT 1 FROM source_fragment f WHERE f.parent_id=s.id)
FROM source_zone s JOIN zone z ON z.id=s.id
WHERE z.group_id=s.group_id AND z.name=s.name
  AND (z.color IN ({compatible}) OR z.color=s.color)
  AND z.first=s.first AND z.last IN(s.initial_last,s.last)
  AND (z.positions_json::jsonb=s.positions_json::jsonb OR z.positions_json::jsonb=
    (SELECT jsonb_agg(p ORDER BY p) FROM generate_series(s.first,s.initial_last) p))
  AND NOT EXISTS (
    SELECT 1 FROM source_fragment f LEFT JOIN zone fragment ON fragment.id=f.id
    WHERE f.parent_id=s.id AND (
      -- Absent fragments are normal on replay of an already consolidated row.
      (fragment.id IS NULL AND z.positions_json::jsonb<>s.positions_json::jsonb)
      OR (fragment.id IS NOT NULL AND (
        fragment.group_id=s.group_id AND fragment.name=f.name
        AND fragment.first=f.first AND fragment.last=f.last
        AND (fragment.color IN ({compatible}) OR fragment.color=s.color)
        AND fragment.positions_json::jsonb=
          (SELECT jsonb_agg(p ORDER BY p) FROM generate_series(f.first,f.last) p)
      ) IS NOT TRUE)
    )
  );
UPDATE zone z SET color=s.color,position=s.position,positions_json=s.positions_json,first=s.first,last=s.last
FROM source_zone s,restorable_zone eligible WHERE z.id=s.id AND eligible.id=s.id
  AND (z.color,z.position,z.positions_json::jsonb) IS DISTINCT FROM (s.color,s.position,s.positions_json::jsonb);
DELETE FROM zone z USING source_fragment f,restorable_zone eligible
WHERE z.id=f.id AND eligible.id=f.parent_id;

-- A fragment's current chance cannot survive a widened membership. Rebuild
-- existing parent cells only from complete current position vectors. Missing
-- vectors remove the stale cell; normal odds computation can repopulate it.
WITH vectors AS (
  SELECT c.id,z.first,z.last,z.position,z.color,m.n,
    count(pc.id)=m.n AND count(DISTINCT pc.position)=m.n
      AND min(pc.position)=1 AND max(pc.position)=m.n
      AND bool_and(pc.percent BETWEEN 0 AND 100.5)
      AND abs(sum(pc.percent::numeric)-100)<=greatest(0.05,m.n*0.005) AS complete,
    sum(CASE WHEN z.positions_json::jsonb @> jsonb_build_array(pc.position)
      THEN pc.percent::numeric ELSE 0 END) AS probability,
    bool_or(z.positions_json::jsonb @> jsonb_build_array(pc.position) AND pc.percent>0) AS any_positive,
    count(*) FILTER(WHERE z.positions_json::jsonb @> jsonb_build_array(pc.position))=jsonb_array_length(z.positions_json::jsonb)
      AND bool_and(CASE WHEN z.positions_json::jsonb @> jsonb_build_array(pc.position)
        THEN pc.reach='impossible' ELSE true END) AS all_impossible,
    bool_or(z.positions_json::jsonb @> jsonb_build_array(pc.position) AND pc.reach='reachable') AS any_reachable
  FROM zone_chance c JOIN restorable_zone eligible ON eligible.id=c.zone_id AND eligible.rebuild_chance JOIN zone z ON z.id=c.zone_id
    CROSS JOIN LATERAL(SELECT count(*)::integer AS n FROM team_group WHERE group_id=c.group_id) m
    LEFT JOIN position_chance pc ON pc.group_id=c.group_id AND pc.team_id=c.team_id
  GROUP BY c.id,z.id,m.n
), rounded AS (
  SELECT *,round(probability,2) AS shown FROM vectors WHERE complete
)
INSERT INTO restored_zone_chance(id,first,last,position,color,percent,band,reach)
SELECT id,first,last,position,color,shown,
  CASE WHEN shown<0.5 THEN 0 WHEN shown<5 THEN 1 WHEN shown<20 THEN 2 WHEN shown<50 THEN 3 ELSE 4 END,
  CASE WHEN shown<>0 THEN '' WHEN any_positive THEN 'reachable'
    WHEN all_impossible THEN 'impossible' WHEN any_reachable THEN 'reachable' ELSE 'undecided' END
FROM rounded;
UPDATE zone_chance c SET first=r.first,last=r.last,position=r.position,color=r.color,
  percent=r.percent,band=r.band,reach=r.reach
FROM restored_zone_chance r WHERE r.id=c.id
  AND (c.first,c.last,c.position,c.color,c.percent,c.band,c.reach)
    IS DISTINCT FROM (r.first,r.last,r.position,r.color,r.percent,r.band,r.reach);
DELETE FROM zone_chance c USING restorable_zone eligible WHERE c.zone_id=eligible.id AND eligible.rebuild_chance
  AND NOT EXISTS(SELECT 1 FROM restored_zone_chance r WHERE r.id=c.id);
SELECT count(*) AS restored_source_zones FROM zone z JOIN source_zone s ON z.id=s.id
  WHERE (z.color,z.position,z.positions_json::jsonb)=(s.color,s.position,s.positions_json::jsonb);
""", 'COMMIT;']
    return '\n'.join(statements)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_text(prepare(json.loads(line) for line in args.source.read_text().splitlines()))
