# Brings up GolAberto with the full legacy archive in its own Compose project,
# resuming at the first step not yet done: restore the MySQL dump, import it
# into an empty database, then launch the stack. A database already imported
# elsewhere arrives instead as a pg_dump of it. docs/archive-import.md says what
# each step guards; this is the one way to run them.
#
#   ARCHIVE_PATH=/path/to/production-2026-10-06.sql.gz ./saytw --script tools/archive.nu up
#   ARCHIVE_DUMP=/path/to/golaberto.dump ./saytw --script tools/archive.nu up
#   ./saytw --script tools/archive.nu stop
#   ./saytw --script tools/archive.nu -- compose ps --format json
#
# ARCHIVE_PATH         the legacy MySQL dump; required until the source is restored.
# ARCHIVE_DUMP         instead, `pg_dump -Fc` of an imported database whose
#                      migrations are this checkout's.
# ARCHIVE_PROJECT      the Compose project, also the image tag (golaberto-archive).
# CADDY_TLS_HOST_PORT  the HTTPS port (8543).
# ARCHIVE_OUTPUT       private import artifacts, outside the repository
#                      (<cache>/golaberto-archive/<project>).
use tools.nu [run-docker run-docker-compose run-mise]

const app = path self | path dirname | path dirname
const profile = "tools/archive/production-2026-10-06"

def settings []: nothing -> record {
  let project = $env.ARCHIVE_PROJECT? | default "golaberto-archive"
  let port = $env.CADDY_TLS_HOST_PORT? | default "8543"
  let home = $env.HOME? | default ($env.USERPROFILE? | default "")
  let cache = $env.XDG_CACHE_HOME? | default ($env.LOCALAPPDATA? | default ($home | path join ".cache")) | path join "golaberto-archive"
  {
    project: $project
    cache: $cache
    output: ($env.ARCHIVE_OUTPUT? | default ($cache | path join $project))
    source: $"($project)-source"
    # The archive overlay builds its database from the dedicated tag; the empty
    # compose mode takes the pinned published platform images.
    env: {
      BAYT_IMAGE_TAG: $project
      MONOREPO_COMPOSE_MODE: ""
      CADDY_TLS_HOST_PORT: $port
      ORIGIN: ($env.ORIGIN? | default $"https://localhost:($port)")
    }
  }
}

def --wrapped archive-compose [s: record, ...args] {
  with-env $s.env {
    run-docker-compose -p $s.project -f .bayt/compose.launch.closure.yaml -f tools/archive/compose.preserve.yaml ...$args
  }
}

def step [what: string] { print $"\n== ($what)" }

def sql [target: string, query: string]: nothing -> string {
  run-docker exec $target psql -X -v ON_ERROR_STOP=1 -U postgres -d golaberto -Atc $query | str trim
}

# The importer's tools, in a venv of their pinned requirements.
def python [s: record]: nothing -> string {
  let venv = $s.cache | path join "venv"
  let bin = if $nu.os-info.name == "windows" { $venv | path join "Scripts" "python.exe" } else { $venv | path join "bin" "python" }
  if not ($bin | path exists) {
    let found = which python3 python | get -o 0.path
    if $found == null { error make {msg: "tools/archive.nu needs Python 3.11 or newer on PATH"} }
    ^$found -c "import sys; sys.exit(sys.version_info < (3, 11))"
    ^$found -m venv $venv
    ^$bin -m pip install --quiet --disable-pip-version-check -r tools/archive/requirements.txt
  }
  $bin
}

def "main up" [] {
  cd $app
  let s = settings
  let py = python $s
  let dump = $env.ARCHIVE_DUMP? | default ""
  if $dump != "" {
    if not ($dump | path exists) { error make {msg: $"ARCHIVE_DUMP names no file: ($dump)"} }
    if (open --raw $dump | bytes at 0..4 | decode utf-8) != "PGDMP" {
      error make {msg: "ARCHIVE_DUMP must be pg_dump's custom format (pg_dump -Fc)"}
    }
  }
  # A project with no target volume is new: nothing of it may exist yet.
  let volume = $"($s.project)_archive-postgres"
  if (run-docker volume ls -q --filter $"name=^($volume)$" | str trim) == "" {
    step "checks"
    with-env ($s.env | merge {ARCHIVE_WORKFLOW_COMPOSE_TEST: "1"}) { ^$py -m unittest discover -s tools -p "*archive*test.py" }
    ^$py tools/archive_workflow.py check-project --project $s.project
    if ($s.output | path exists) {
      error make {msg: $"($s.output) holds another import's artifacts; move it away for a new project"}
    }
  }
  if not (".certs/localhost.pem" | path exists) {
    step "local certificate"
    mkdir .certs
    run-mise exec -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost 127.0.0.1 "::1"
    run-mise exec -- mkcert -install
  }
  step "images"
  with-env $s.env { run-docker-compose -p $s.project -f .bayt/compose.launch.closure.yaml build golaberto-database }
  archive-compose $s build --with-dependencies golaberto-launch
  step "database"
  archive-compose $s up -d --no-build --wait golaberto-database
  let target = archive-compose $s ps -q golaberto-database | str trim
  if $target == "" { error make {msg: "the database container did not start"} }
  # The archive lives on the project's volume only if the volume is the data
  # directory: a cluster on the container's writable layer is lost with the
  # container, the first time an image change recreates it.
  let pgdata = sql $target "SHOW data_directory"
  let mounted = run-docker inspect -f "{{range .Mounts}}{{.Name}}={{.Destination}}\n{{end}}" $target | lines
  if $"($volume)=($pgdata)" not-in $mounted {
    error make {msg: $"($volume) is not mounted at the data directory ($pgdata); the overlay's volume path is stale"}
  }
  # Nothing else starts before the import: one guest makes the target nonempty.
  if (sql $target "SELECT count(*) > 0 FROM game") == "f" {
    step "migrations"
    archive-compose $s run --rm --no-deps golaberto-migrate
    if $dump != "" {
      restore-dump $py $target $dump
    } else {
      import $s $py $target
    }
    sql $target "ANALYZE" | ignore
  }
  step "launch"
  # A service whose image this run rebuilt is recreated on it; the archive is
  # on the volume, not in any container.
  archive-compose $s up -d --no-build golaberto-launch
  print $"GolAberto with the archive: ($s.env.ORIGIN) \(derived pages fill in as the projections finish)"
}

# The application's rows from a dump whose migrations are these: the tables
# and sequences of every schema but pgroll's, whose ledger is the target's own.
# A table the migrations do not make is no part of the archive (the auth
# service creates its own credential store at runtime) and is named as left
# out. The migrations seed rows (geography, clocks, RLS exemptions) the dump
# holds too, so the tables are emptied in the same transaction as the restore.
# Triggers stay off so the restore enqueues nothing the projections would
# replay.
def restore-dump [py: string, target: string, dump: string] {
  ^$py tools/archive_workflow.py check-dump --dump $dump --target $target
  step "restore the pg_dump"
  let ours = sql $target "SELECT c.relkind::text || '|' || n.nspname || '.' || c.relname || '|' || format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'S') AND n.nspname NOT IN ('pgroll', 'information_schema') AND n.nspname !~ '^pg_'" | lines | split column "|" kind name quoted
  let tables = $ours | where kind == "r"
  let sequences = $ours | where kind == "S" | get name
  # Copied in rather than piped: a pipe through the tool runners carries no stdin.
  run-docker cp $dump $"($target):/tmp/archive.dump"
  let entries = run-docker exec $target pg_restore -l /tmp/archive.dump | lines | each { |line|
    let m = $line | parse -r '^\d+; \d+ \d+ (?<kind>TABLE DATA|SEQUENCE SET) (?<schema>\S+) (?<name>\S+) '
    if ($m | is-empty) { null } else { $m | first | update name ($m.0.schema + "." + $m.0.name) | insert line $line }
  } | compact
  let wanted = $entries | where { |e| $e.name in (if $e.kind == "TABLE DATA" { $tables.name } else { $sequences }) } | get line
  let left_out = $entries | where { |e| $e.kind == "TABLE DATA" and $e.schema != "pgroll" and $e.name not-in $tables.name } | get name
  if ($left_out | is-not-empty) {
    print -e $"left out, not made by these migrations: ($left_out | str join ', ')"
  }
  let list = mktemp -t archive.XXXXXX.list
  $wanted | str join (char nl) | save -f $list
  run-docker cp $list $"($target):/tmp/archive.list"
  rm $list
  # The dump becomes SQL first, so one that cannot be read fails before
  # anything is emptied; psql then runs the TRUNCATE and the rows as one
  # transaction.
  let script = "set -e; trap 'rm -f /tmp/archive.dump /tmp/archive.list /tmp/archive.sql' EXIT; pg_restore -f /tmp/archive.sql --data-only --disable-triggers -L /tmp/archive.list /tmp/archive.dump; psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U postgres -d golaberto -c 'TRUNCATE " + ($tables.quoted | str join ", ") + "' -f /tmp/archive.sql >/dev/null"
  run-docker exec $target bash -c $script
}

def import [s: record, py: string, target: string] {
  if (run-docker ps -a -q --filter $"name=^($s.source)$" | str trim) != "" {
    ^$py tools/archive_workflow.py source-ready --project $s.project --provenance $"($profile).provenance.json"
  } else {
    let archive = $env.ARCHIVE_PATH? | default ""
    if $archive == "" { error make {msg: "set ARCHIVE_PATH to the legacy dump until the source is restored"} }
    step "restore the dump"
    ^$py tools/archive_workflow.py restore-source --project $s.project --archive $archive --provenance $"($profile).provenance.json"
  }
  # The manifest is the import's last file: without it the output is a failed
  # build, which is inspected rather than reused or removed here.
  if not ($s.output | path join "manifest.json" | path exists) {
    if ($s.output | path exists) {
      error make {msg: $"($s.output) holds a failed import's partial output; inspect it, then remove it to build again"}
    }
    step "build the import"
    with-env ($s.env | merge {ARCHIVE_IMPORT_TEST_TARGET_CONTAINER: $target, ARCHIVE_WORKFLOW_COMPOSE_TEST: "1"}) {
      ^$py -m unittest discover -s tools -p "*archive*test.py"
    }
    mkdir ($s.output | path dirname)
    # Staging the importer marked complete is re-verified against the source
    # rather than staged again; an unmarked one is a failed staging.
    let staged = sql $target "SELECT CASE WHEN to_regnamespace('legacy') IS NULL THEN 'none' ELSE coalesce(obj_description(to_regnamespace('legacy'), 'pg_namespace'), 'partial') END"
    let reuse = match $staged {
      "none" => []
      "staged" => ["--reuse-staging"]
      _ => { error make {msg: "the target's legacy schema is a failed staging; inspect it, then DROP SCHEMA legacy CASCADE to stage again"} }
    }
    (^$py tools/import_archive.py --source-container $s.source --source-database GolAberto_production
      --target-container $target --target-database golaberto
      --expected-counts $"($profile).counts.json" --corrections $"($profile).corrections.json"
      --defer-projections ...$reuse $s.output)
  }
  step "apply the import"
  run-docker cp ($s.output | path join "apply.sql") $"($target):/tmp/apply.sql"
  run-docker exec $target bash -c "set -e; trap 'rm -f /tmp/apply.sql' EXIT; psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d golaberto -f /tmp/apply.sql"
}

def "main stop" [] {
  cd $app
  archive-compose (settings) stop
}

def --wrapped "main compose" [...args] {
  cd $app
  archive-compose (settings) ...$args
}

def main [] {
  print "usage: ./saytw --script tools/archive.nu [up|stop|-- compose …]"
  exit 2
}
