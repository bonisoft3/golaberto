// All fixtures and retained-upgrade probes roll back on an explicit check stack.
import { assert } from "jsr:@std/assert@1";

const project = Deno.env.get("COMPOSE_PROJECT_NAME") ?? "";
if (!/(?:check|test)/i.test(project) || project.toLowerCase() === "golaberto") {
  throw new Error("public-addresses requires a disposable check/test COMPOSE_PROJECT_NAME");
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

Deno.test("public addresses survive collisions, edits, imports, deletion and retained migration replay", async () => {
  const upgrade = (await Deno.readTextFile(new URL("../services/database/sql/032_public_addresses.sql", import.meta.url)))
    .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
  const [team, away, collision, literal, championship, youth, category, phase, group, game, player, stadium, referee,
    blank, uuidName, removed, replacement] = Array.from({ length: 17 }, () => crypto.randomUUID());
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const [retainedA, retainedB, retainedLiteral] = Array.from({ length: 3 }, () => crypto.randomUUID());
  await psql(`BEGIN;
    ${upgrade}
    INSERT INTO team(id,name,country) VALUES
      ('${team}','São Tomé ${tag}','Brasil'),('${away}','Vitória ${tag}','Brasil'),
      ('${literal}','Sao Tome ${tag} 2','Brasil'),('${collision}','SÃO TOMÉ ${tag}','Brasil'),
      ('${blank}','⚽','Brasil'),('${uuidName}','${uuidName}','Brasil'),
      ('${removed}','Removível ${tag}','Brasil');
    INSERT INTO category(id,name) VALUES ('${category}','Sub-20 ${tag}');
    INSERT INTO championship(id,name,region_name,begins,ends) VALUES
      ('${championship}','Série A ${tag}','Brasil','2026-01-01','2026-12-31');
    INSERT INTO championship(id,name,region_name,begins,ends,category_id) VALUES
      ('${youth}','Série A ${tag}','Brasil','2026-01-01','2026-12-31','${category}');
    INSERT INTO phase(id,championship_id,name) VALUES ('${phase}','${championship}','Primeira fase');
    INSERT INTO stage_group(id,phase_id,name) VALUES ('${group}','${phase}','Grupo Á');
    INSERT INTO game(id,phase_id,day,home_id,away_id) VALUES
      ('${game}','${phase}','2026-10-04','${team}','${away}');
    INSERT INTO player(id,name) VALUES ('${player}','João ${tag}');
    INSERT INTO stadium(id,name) VALUES ('${stadium}','Mineirão ${tag}');
    INSERT INTO referee(id,name) VALUES ('${referee}','José ${tag}');
    CREATE TEMP TABLE expected_addresses(id text PRIMARY KEY,slug text);
    INSERT INTO expected_addresses VALUES
      ('team:${team}','sao-tome-${tag}'),('team:${collision}','sao-tome-${tag}-3'),
      ('championship:${championship}','brasil-serie-a-${tag}-2026'),
      ('championship:${youth}','brasil-serie-a-${tag}-2026-sub-20-${tag}'),
      ('group:${group}','brasil-serie-a-${tag}-2026-primeira-fase-grupo-a'),
      ('game:${game}','2026-10-04-sao-tome-${tag}-vitoria-${tag}'),
      ('player:${player}','joao-${tag}'),('stadium:${stadium}','mineirao-${tag}'),
      ('referee:${referee}','jose-${tag}'),('team:${uuidName}','team-${uuidName}');
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM expected_addresses e LEFT JOIN public_address a USING(id)
        WHERE a.slug IS DISTINCT FROM e.slug) THEN RAISE EXCEPTION 'readable source addresses differ'; END IF;
      IF public_address_base('Straße Ægir Œuvre Þór Øst Łódź Đorđe ı') <> 'strasse-aegir-oeuvre-thor-ost-lodz-dorde-i'
        OR public_address_base(U&'Sa\\0303o') <> 'sao'
        OR (SELECT slug FROM public_address WHERE id='team:${blank}') !~ '^team(-[0-9]+)?$'
        THEN RAISE EXCEPTION 'accent folding or safe fallback failed'; END IF;
    END $$;
    CREATE TEMP TABLE addresses_before AS SELECT id,slug,ctid::text AS row_version FROM public_address;
    UPDATE team SET name='Changed ${tag}' WHERE id='${team}';
    UPDATE championship SET name='Changed championship ${tag}',begins='2025-01-01' WHERE id='${championship}';
    UPDATE game SET day='2026-10-05' WHERE id='${game}';
    INSERT INTO player(id,name) VALUES ('${player}','Imported new name ${tag}')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name;
    DELETE FROM team WHERE id='${removed}';
    INSERT INTO team(id,name,country) VALUES ('${replacement}','Removível ${tag}','Brasil');
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM addresses_before b LEFT JOIN public_address a USING(id)
        WHERE a.slug IS DISTINCT FROM b.slug OR a.ctid::text IS DISTINCT FROM b.row_version)
        THEN RAISE EXCEPTION 'edit/import/deletion rewrote a durable allocation'; END IF;
      IF (SELECT slug FROM public_address WHERE id='team:${replacement}') <> 'removivel-${tag}-2'
        THEN RAISE EXCEPTION 'a removed address was reassigned'; END IF;
      IF has_table_privilege('app_user','public_address','INSERT')
        OR has_table_privilege('app_user','public_address','UPDATE')
        OR has_table_privilege('app_user','public_address','DELETE')
        OR has_table_privilege('anon','public_address','INSERT')
        OR has_function_privilege('app_user','allocate_public_address(text,uuid,text)','EXECUTE')
        OR has_function_privilege('anon','stamp_public_address()','EXECUTE')
        THEN RAISE EXCEPTION 'public readers can mutate public addresses'; END IF;
    END $$;
    SET LOCAL ROLE app_user;
    -- Exercise the same request hook as PostgREST: the tenancy floor denies
    -- reads until the request has acquired its public scope, even for app_user.
    SET LOCAL request.jwt.claims='{"sub":"${crypto.randomUUID()}","guest":true,"role":"app_user"}';
    SELECT app_pre_request();
    DO $$ BEGIN
      IF (SELECT count(*) FROM public_address WHERE id='team:${team}') <> 1
        THEN RAISE EXCEPTION 'guest reader cannot resolve a public address'; END IF;
      BEGIN
        DELETE FROM public_address WHERE id='team:${team}';
        RAISE EXCEPTION 'reader deleted an address';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$;
    RESET ROLE;
    -- Simulate records retained from before allocation existed. Backfill only
    -- those mappings; unrelated established reservations must keep their rows.
    DELETE FROM public_address WHERE id IN ('stadium:${stadium}','referee:${referee}');
    DELETE FROM public_address_backfill WHERE version='032';
    ALTER TABLE team DISABLE TRIGGER public_address_stamp;
    INSERT INTO team(id,name,country) VALUES
      ('${retainedA}','Retained ${tag}','Brasil'),('${retainedB}','Retained ${tag}','Brasil'),
      ('${retainedLiteral}','Retained ${tag} 2','Brasil');
    ALTER TABLE team ENABLE TRIGGER public_address_stamp;
    CREATE TEMP TABLE source_before AS SELECT id,to_jsonb(t) AS value,ctid::text AS row_version
      FROM team t WHERE id IN ('${team}','${away}','${collision}');
    ${upgrade}
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM public_address WHERE id='stadium:${stadium}' AND slug='mineirao-${tag}')
        OR NOT EXISTS(SELECT 1 FROM public_address WHERE id='referee:${referee}' AND slug='jose-${tag}')
        OR (SELECT array_agg(slug::text ORDER BY slug) FROM public_address
          WHERE record_id IN ('${retainedA}','${retainedB}','${retainedLiteral}'))
          IS DISTINCT FROM ARRAY['retained-${tag}','retained-${tag}-2','retained-${tag}-3']
        OR EXISTS(SELECT 1 FROM source_before b JOIN team t USING(id)
          WHERE to_jsonb(t) IS DISTINCT FROM b.value OR t.ctid::text IS DISTINCT FROM b.row_version)
        THEN RAISE EXCEPTION 'retained backfill omitted addresses or rewrote source rows'; END IF;
    END $$;
    CREATE TEMP TABLE addresses_once AS SELECT id,slug,ctid::text AS row_version FROM public_address;
    ${upgrade}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM addresses_once b FULL JOIN public_address a USING(id)
        WHERE a.slug IS DISTINCT FROM b.slug OR a.ctid::text IS DISTINCT FROM b.row_version)
        THEN RAISE EXCEPTION 'replayed migration rewrote registry rows'; END IF;
    END $$;
    ROLLBACK;
  `);
});
