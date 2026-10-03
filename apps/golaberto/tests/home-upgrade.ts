// Apply the built launch migrator to a retained database with the old home schema.
// This clone has its own database and ledger; the running archive is read only.
import { assert, assertEquals } from "jsr:@std/assert@1";

const decoder = new TextDecoder();
const project = Deno.env.get("COMPOSE_PROJECT_NAME") || "golaberto";
const clone = "golaberto_home_upgrade_check";
const docker = async (...args: string[]) => {
  const result = await new Deno.Command("docker", { args }).output();
  if (!result.success) throw new Error(decoder.decode(result.stderr));
  return decoder.decode(result.stdout).trim();
};
const compose = (...args: string[]) => docker("compose", "-p", project, ...args);

Deno.test("home schema upgrades retained data before readers start and does not rerun", async () => {
  const config = JSON.parse(await compose("config", "--format", "json"));
  const image = config.services["apps_golaberto-migrate"].image;
  assertEquals(config.services["apps_golaberto-crud"].depends_on["apps_golaberto-migrate"].condition, "service_completed_successfully");
  const container = await compose("ps", "-q", "apps_golaberto-database");
  const [info] = JSON.parse(await docker("inspect", container));
  const dataDirectory = await docker("exec", container, "psql", "-U", "postgres", "-d", "golaberto", "-Atqc", "SHOW data_directory");
  assert(info.Mounts.some((mount: { Type: string; Destination: string }) => ["volume", "bind"].includes(mount.Type) && (dataDirectory === mount.Destination || dataDirectory.startsWith(`${mount.Destination}/`))), "the archive data directory must be inside a persistent mount");
  const network = Object.keys(info.NetworkSettings.Networks)[0];
  const host = info.Name.replace(/^\//, "");
  const sql = (db: string, query: string) => docker("exec", container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-Atqc", query);
  await sql("postgres", `CREATE DATABASE ${clone}`);
  try {
    // Leave the migration ledger and version views out of the retained schema.
    const schemas = (await sql("golaberto", "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%' ORDER BY nspname")).split("\n").filter(Boolean);
    await docker("exec", container, "bash", "-o", "pipefail", "-c", `pg_dump -U postgres -d golaberto --no-owner | psql -U postgres -d ${clone} -v ON_ERROR_STOP=1 >/dev/null`);
    // Remove only the clone's ledger, hooks and version views to model the old deployment.
    for (const name of [...schemas, "pgroll"]) {
      await sql(clone, `DROP SCHEMA IF EXISTS "${name.replaceAll('"', '""')}" CASCADE`);
    }
    await sql(clone, "DROP TRIGGER IF EXISTS sync_matches_game_card_update ON game_card; DROP TRIGGER IF EXISTS sync_matches_game_card_delete ON game_card; DROP FUNCTION IF EXISTS sync_matches_game_card(); DROP FUNCTION IF EXISTS refresh_matches_games(); DROP FUNCTION IF EXISTS copy_matches_game_cards(uuid[]); DROP TABLE IF EXISTS matches_game_card; DROP INDEX IF EXISTS game_card_matches_upcoming_idx, game_card_matches_results_idx");
    await sql(clone, "DROP TRIGGER IF EXISTS sync_home_game_card_insert ON game_card; DROP TRIGGER IF EXISTS sync_home_game_card_update ON game_card; DROP TRIGGER IF EXISTS sync_home_game_card_delete ON game_card; DROP FUNCTION IF EXISTS sync_home_game_card(); DROP FUNCTION IF EXISTS copy_home_game_cards(uuid[]); ALTER TABLE IF EXISTS home_game_card DROP COLUMN IF EXISTS home_highlighted; DROP TABLE IF EXISTS home_game_card; DROP INDEX IF EXISTS team_rating_home_latest_idx, game_card_home_kickoff_idx, game_card_home_upcoming_idx, game_card_home_recent_idx");
    await sql(clone, "DROP FUNCTION refresh_home_games(); DROP FUNCTION IF EXISTS home_game_order(timestamptz); DROP FUNCTION IF EXISTS home_game_selection(timestamptz); ALTER TABLE game_card DROP COLUMN home_upcoming_rank, DROP COLUMN home_recent_rank, DROP COLUMN home_upcoming_group, DROP COLUMN home_recent_group; UPDATE championship SET name = 'Preserved homepage upgrade' WHERE id = '02000000-0000-4000-8000-000000000001'");
    const count = await sql(clone, "SELECT count(*) FROM game_card");
    await sql(clone, "ALTER TABLE game_card DROP COLUMN show_country, DROP COLUMN home_country, DROP COLUMN away_country; ALTER TABLE team_game DROP COLUMN show_country, DROP COLUMN opponent_country; UPDATE championship SET show_country=true WHERE id=(SELECT championship_id FROM game_card ORDER BY id LIMIT 1)");
    const migrate = () => docker("run", "--rm", "--network", network, "-e", `DATABASE_URL=postgres://postgres:postgres@${host}:5432/${clone}?sslmode=disable`, image);
    await migrate();
    assertEquals(await sql(clone, "SELECT name FROM championship WHERE id = '02000000-0000-4000-8000-000000000001'"), "Preserved homepage upgrade");
    assertEquals(await sql(clone, "SELECT count(*) FROM game_card"), count);
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '013_home_games' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '014_home_championships' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '015_home_performance' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '016_matches_performance' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_attribute WHERE attrelid = 'game_card'::regclass AND attname IN ('home_upcoming_group', 'home_recent_group') AND atttypid = 'portable_bool'::regtype"), "2", "retained data uses the same grouping field domains as a fresh generated schema");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='017_game_countries' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM game_card g JOIN championship c ON c.id=g.championship_id JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id WHERE (g.show_country,g.home_country,g.away_country) IS DISTINCT FROM (c.show_country,h.country,a.country)"), "0", "migration 017 remains compatible before the normalized upgrade");
    assert(Number(await sql(clone, "SELECT count(*) FROM game_card WHERE show_country")) > 0);
    assertEquals(await sql(clone, "SELECT count(*) FROM team_game t JOIN game_card g ON g.id=t.game_id WHERE (t.show_country,t.opponent_country) IS DISTINCT FROM (g.show_country,CASE WHEN t.side='home' THEN g.away_country ELSE g.home_country END)"), "0");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='019_normalized_game_flags' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='020_home_reference_order' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='021_home_highlights' AND done"), "1");
    // Existing stale metadata must never trigger a bounded-copy rewrite.
    await sql(clone, "UPDATE home_game_card SET show_country=NOT show_country, home_country='Retired'; UPDATE matches_game_card SET show_country=NOT show_country, home_country='Retired'");
    const versions = () => sql(clone, "SELECT md5(string_agg(id::text||':'||txid::text, ',' ORDER BY id)) FROM (SELECT id,txid FROM home_game_card UNION ALL SELECT id,txid FROM matches_game_card) rows");
    const beforeCopy = await versions();
    await sql(clone, "SELECT copy_home_game_cards(array_agg(id)) FROM home_game_card; SELECT copy_matches_game_cards(array_agg(id)) FROM matches_game_card");
    assertEquals(await versions(), beforeCopy, "retired country metadata does not cause copy rewrites");
    await sql(clone, "SELECT refresh_home_games()");
    assert(Number(await sql(clone, "SELECT count(*) FROM game_card WHERE home_upcoming_rank > 0")) > 0, "the upgraded fixture feed populates");
    assert(Number(await sql(clone, "SELECT count(*) FROM game_card WHERE home_recent_rank > 0")) > 0, "the upgraded results feed populates");
    assertEquals(await sql(clone, "SELECT count(*) FROM game_card WHERE home_upcoming_rank > 0 OR home_recent_rank > 0"), await sql(clone, "SELECT count(*) FROM home_game_order(now())"));
    assertEquals(await sql(clone, "SELECT count(*) FROM home_game_card"), await sql(clone, "SELECT count(*) FROM game_card WHERE home_upcoming_rank > 0 OR home_recent_rank > 0"));
    assertEquals(await sql(clone, "SELECT count(*) FROM home_game_card h JOIN game_card g USING(id) WHERE (to_jsonb(h)-ARRAY['txid','day','day_display','show_country','home_country','away_country','home_highlighted']) IS DISTINCT FROM (to_jsonb(g)-ARRAY['txid','day','day_display','show_country','home_country','away_country'])"), "0");
    assertEquals(await sql(clone, "SELECT count(*) FROM home_game_card WHERE day IS DISTINCT FROM (kickoff AT TIME ZONE 'America/Sao_Paulo')::date"), "0", "projected day follows local kickoff date");
    await sql(clone, `DO $$ DECLARE picked home_game_card; BEGIN
      SELECT * INTO picked FROM home_game_card LIMIT 1;
      UPDATE game_card SET kickoff=NULL WHERE id=picked.id;
      IF EXISTS (SELECT 1 FROM home_game_card WHERE id=picked.id) THEN RAISE EXCEPTION 'upgraded projection retained an unknown kickoff'; END IF;
      UPDATE game_card SET kickoff=picked.kickoff WHERE id=picked.id;
    END $$`);
    await sql(clone, "SELECT refresh_home_games()");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_publication_tables WHERE pubname='electric_publication_default' AND tablename='home_game_card'"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND tablename='home_game_card'"), "0");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_attribute WHERE attrelid='home_game_card'::regclass AND attname='home_highlighted' AND atttypid='portable_bool'::regtype AND attnotnull"), "1", "the destination highlight uses the portable bool domain and is required");
    assertEquals(await sql(clone, "SELECT count(*) FROM home_game_card WHERE home_highlighted"), await sql(clone, "SELECT count(*) FROM home_game_selection(now()) WHERE highlighted"));
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_attribute h JOIN pg_attribute g ON g.attrelid='game_card'::regclass AND h.attname=g.attname WHERE h.attrelid='home_game_card'::regclass AND h.attnum>0 AND NOT h.attisdropped AND h.atttypid<>g.atttypid"), "0");
    await sql(clone, "SELECT refresh_matches_games()");
    assertEquals(await sql(clone, "SELECT count(*) FROM matches_game_card"), "80");
    assertEquals(await sql(clone, "SELECT count(*) FROM matches_game_card h JOIN game_card g USING(id) WHERE (to_jsonb(h)-ARRAY['txid','show_country','home_country','away_country']) IS DISTINCT FROM (to_jsonb(g)-ARRAY['txid','show_country','home_country','away_country'])"), "0");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_publication_tables WHERE pubname='electric_publication_default' AND tablename='matches_game_card'"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_publication_tables WHERE pubname='golaberto_cdc' AND tablename='matches_game_card'"), "0");
    assertEquals(await sql(clone, "SELECT count(*) FROM pg_attribute h JOIN pg_attribute g ON g.attrelid='game_card'::regclass AND h.attname=g.attname WHERE h.attrelid='matches_game_card'::regclass AND h.attnum>0 AND NOT h.attisdropped AND h.atttypid<>g.atttypid"), "0");
    assertEquals(await sql(clone, "SELECT has_function_privilege('anon','home_game_selection(timestamptz)','EXECUTE') OR has_function_privilege('app_user','home_game_selection(timestamptz)','EXECUTE') OR NOT has_function_privilege('service','home_game_selection(timestamptz)','EXECUTE')"), "f");
    await migrate();
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '013_home_games' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '014_home_championships' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '015_home_performance' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name = '016_matches_performance' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='020_home_reference_order' AND done"), "1");
    assertEquals(await sql(clone, "SELECT count(*) FROM pgroll.migrations WHERE name='021_home_highlights' AND done"), "1", "the new migration is recorded once on replay");
  } finally {
    await sql("postgres", `DROP DATABASE ${clone} WITH (FORCE)`);
  }
});

Deno.test("archive volume survives compose down and relaunch", async () => {
  const probe = `${project}-storage-probe`;
  const stack = (...args: string[]) => docker("compose", "-p", probe, ...args);
  const start = () => stack("up", "--no-deps", "--no-build", "--wait", "apps_golaberto-database");
  const sql = (query: string) => stack("exec", "-T", "apps_golaberto-database", "psql", "-U", "postgres", "-d", "golaberto", "-v", "ON_ERROR_STOP=1", "-Atqc", query);
  const volume = async () => {
    const [info] = JSON.parse(await docker("inspect", await stack("ps", "-q", "apps_golaberto-database")));
    return info.Mounts.find((mount: { Destination: string }) => mount.Destination === "/var/lib/postgresql")?.Name;
  };
  try {
    await start();
    const before = await volume();
    assertEquals(before, `${probe}_golaberto-archive`, "archive uses a project-scoped named volume");
    const count = await sql("SELECT count(*) FROM game");
    await sql("UPDATE championship SET name='Persistent archive sentinel' WHERE id='02000000-0000-4000-8000-000000000001'");
    await stack("down", "--remove-orphans");
    await start();
    assertEquals(await volume(), before);
    assertEquals(await sql("SELECT name FROM championship WHERE id='02000000-0000-4000-8000-000000000001'"), "Persistent archive sentinel");
    assertEquals(await sql("SELECT count(*) FROM game"), count);
  } finally {
    await stack("down", "-v", "--remove-orphans");
  }
});
