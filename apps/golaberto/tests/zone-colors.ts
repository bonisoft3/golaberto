// The additive upgrade and its retained-data fixture run in one rolled-back
// transaction on an explicitly disposable check stack.
import { assert } from "jsr:@std/assert@1";
const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("zone-colors requires a disposable check/test COMPOSE_PROJECT_NAME");
}
const psql = async (sql: string) => {
  const process = new Deno.Command("docker", {
    args: ["compose", "-p", project, "exec", "-T", "apps_golaberto-database",
      "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-qAt"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await process.output();
  assert(result.success, new TextDecoder().decode(result.stderr));
};
Deno.test("arbitrary zone colors, explicit membership and source order survive retained upgrade",async()=>{
  const upgrade=(await Deno.readTextFile(new URL("../services/database/sql/031_zone_colors.sql",import.meta.url)))
    .replace(/^BEGIN;$/m,"").replace(/^COMMIT;$/m,"");
  const [a,b,c,champ,phase,group,wide,narrow,legacy,chance]=Array.from({length:10},()=>crypto.randomUUID());
  await psql(`BEGIN;
    ${upgrade}
    INSERT INTO team(id,name,country) VALUES ('${a}','Colors A','Brasil'),('${b}','Colors B','Brasil'),('${c}','Colors C','Brasil');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES ('${champ}','Zone colors','Brasil','2026-01-01','2026-12-31');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${champ}','Colors phase');
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Colors group');
    INSERT INTO team_group(group_id,team_id) VALUES ('${group}','${a}'),('${group}','${b}'),('${group}','${c}');
    INSERT INTO zone(id,group_id,name,color,first,last,position,positions_json) VALUES
      ('${wide}','${group}','Custom noncontiguous','#A1B2C3',1,3,0,'[3,1]'),
      ('${narrow}','${group}','Custom overlap','#123456',1,1,1,'[1]');
    INSERT INTO standing(id,group_id,team_id,team_name,position,points,played,wins,draws,losses,goals_for,goals_against,goal_diff,form1,form2,form3,form4,form5,zone)
      VALUES ('${group}:${a}','${group}','${a}','Colors A',1,0,0,0,0,0,0,0,0,'','','','','','#a1b2c3');
    INSERT INTO zone_chance(id,group_id,team_id,zone_id,first,last,percent,color,band,reach,position)
      VALUES ('${chance}','${group}','${a}','${wide}',1,3,70,'#a1b2c3',2,'',0);
    INSERT INTO team_odds_history(id,group_id,team_id,recorded_on,captured_at,position,percent,source)
      SELECT '${group}:${a}:2026-01-01:'||p,'${group}','${a}','2026-01-01','2026-01-01 12:00Z',p,
        CASE p WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END,'imported' FROM generate_series(1,3) p;
    DO $$ DECLARE payload jsonb; BEGIN
      payload:=build_team_odds_progress('${group}','${a}');
      IF payload#>>'{zones,0,id}' IS DISTINCT FROM '${wide}'
        OR payload#>>'{positions,2,color}' IS DISTINCT FROM '#a1b2c3'
        OR payload#>>'{positions,1,color}' IS DISTINCT FROM '#d3d3d3'
        OR payload#>'{positions,1,zoneIds}' IS DISTINCT FROM '[]'::jsonb
        OR payload#>>'{snapshots,0,zoneValues,${wide}}' IS DISTINCT FROM '70'
        OR payload#>>'{snapshots,0,zoneValues,${narrow}}' IS DISTINCT FROM '10'
        OR (SELECT positions_json::jsonb FROM zone WHERE id='${wide}') IS DISTINCT FROM '[1,3]'::jsonb
      THEN RAISE EXCEPTION 'arbitrary colors, explicit positions or first-source precedence lost'; END IF;
    END $$;
    UPDATE zone SET color='#FfAa33',position=2 WHERE id='${wide}';
    DO $$ BEGIN
      IF (SELECT color FROM zone_chance WHERE id='${chance}') IS DISTINCT FROM '#ffaa33'
        OR (SELECT position FROM zone_chance WHERE id='${chance}') IS DISTINCT FROM 2
        OR (SELECT zone FROM standing WHERE id='${group}:${a}') IS DISTINCT FROM '#123456'
        OR NOT EXISTS(SELECT 1 FROM team_odds_chart_dirty WHERE group_id='${group}')
      THEN RAISE EXCEPTION 'source color/order change failed to refresh projections'; END IF;
    END $$;
    -- Recreate the field shape of a retained role-based zone without touching
    -- existing fixture rows. The upgrade must normalize it and preserve history.
    INSERT INTO zone(id,group_id,name,color,first,last) VALUES ('${legacy}','${group}','Legacy','relegation',2,2);
    DROP TRIGGER normalize_zone_fields ON zone;
    DROP TRIGGER zone_projection_colors_update ON zone;
    ALTER TABLE zone DROP CONSTRAINT zone_color_hex_check;
    ALTER TABLE zone ALTER COLUMN position DROP NOT NULL;
    UPDATE zone SET color='relegation',position=NULL,positions_json=NULL WHERE id='${legacy}';
    CREATE TEMP TABLE zone_history_before AS SELECT md5(string_agg(to_jsonb(h)::text,'' ORDER BY id)) AS hash
      FROM team_odds_history h WHERE group_id='${group}';
    ${upgrade}
    CREATE TEMP TABLE colors_once AS SELECT id,ctid::text AS row_version,color,position,positions_json FROM zone WHERE group_id='${group}';
    ${upgrade}
    DO $$ BEGIN
      IF (SELECT color FROM zone WHERE id='${legacy}') IS DISTINCT FROM '#ffb6c1'
        OR (SELECT positions_json::jsonb FROM zone WHERE id='${legacy}') IS DISTINCT FROM '[2]'::jsonb
        OR (SELECT position FROM zone WHERE id='${legacy}') IS NULL
        OR EXISTS(SELECT 1 FROM colors_once c JOIN zone z USING(id) WHERE c.row_version<>z.ctid::text)
        OR (SELECT hash FROM zone_history_before) IS DISTINCT FROM
          (SELECT md5(string_agg(to_jsonb(h)::text,'' ORDER BY id)) FROM team_odds_history h WHERE group_id='${group}')
      THEN RAISE EXCEPTION 'retained upgrade was lossy or replay rewrote source rows'; END IF;
    END $$;
    -- Invalid CSS-like input is never stored or forwarded to renderers.
    DO $$ DECLARE bad text; BEGIN
      FOREACH bad IN ARRAY ARRAY['red','#fff','#12345g','url(https://example.test/a)','#123456;display:none'] LOOP
        BEGIN
          UPDATE zone SET color=bad WHERE id='${wide}';
          RAISE EXCEPTION 'invalid color was accepted: %',bad;
        EXCEPTION WHEN check_violation THEN NULL;
        END;
      END LOOP;
      FOREACH bad IN ARRAY ARRAY['[]','[0]','[-1]','[1,1]','[1.5]','["1"]','[1,2147483648]'] LOOP
        BEGIN
          UPDATE zone SET positions_json=bad WHERE id='${wide}';
          RAISE EXCEPTION 'invalid position list was accepted: %',bad;
        EXCEPTION WHEN check_violation OR invalid_text_representation THEN NULL;
        END;
      END LOOP;
    END $$;
    ROLLBACK;
  `);
});
