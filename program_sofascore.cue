@extern(embed)
package golaberto

import (
	bayt "github.com/bonisoft3/bayt/core:bayt"
	"github.com/bonisoft3/pronto"
	"strings"
)

_sofaSync:         string @embed(file="services/database/sql/052_sofascore_sync.sql", type=text)
_sofaApply:        string @embed(file="services/database/sql/053_sofascore_apply.sql", type=text)
_sofaAvailability: string @embed(file="services/database/sql/054_fixture_availability.sql", type=text)
_sofaScope:        string @embed(file="services/database/sql/056_sofascore_event_scope.sql", type=text)
_sofaParse:        string @embed(file="services/database/sql/057_sofascore_parse_rejection.sql", type=text)
_sofaDay:          string @embed(file="services/database/sql/058_sofascore_event_day.sql", type=text)
_sofaRequests:      string @embed(file="services/database/sql/059_sofascore_requests.sql", type=text)
_sofaLockOrder:     string @embed(file="services/database/sql/060_sofascore_lock_order.sql", type=text)
_sofaEventSchedule: string @embed(file="services/database/sql/061_sofascore_event_schedule.sql", type=text)
_sofaApplyUp: strings.Replace(strings.Replace(_sofaApply, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1)
// The SofaScore series sorts after the later entities' 20261108_<table>
// migrations it reads; the digit keeps the files' order within the date
// (055 is a file step alone, so its digit is unused).
code: state: migrations: {
	"20261109_1_sofascore_sync": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaSync, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261109_2_sofascore_apply": operations: [{sql: {up: _sofaApplyUp, onComplete: true}}]
	"20261109_3_fixture_availability": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaAvailability, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261109_4_sofascore_schedule_authority": operations: [{sql: {up: _sofaApplyUp, onComplete: true}}]
	"20261109_5_sofascore_event_scope": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaScope, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261109_6_sofascore_parse_rejection": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaParse, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261109_7_sofascore_event_day": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaDay, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261109_9_sofascore_requests": operations: [{sql: {up: strings.Replace(strings.Replace(_sofaRequests, "BEGIN;\n", "\n", -1), "COMMIT;\n", "\n", -1), onComplete: true}}]
	"20261111_sofascore_lock_order": operations: [{sql: {up: _sofaLockOrder, onComplete: true}}]
	"20261112_sofascore_event_schedule": operations: [{sql: {up: _sofaEventSchedule, onComplete: true}}]
}
code: state: entities: {
	Substitution: {
		id: "0xa4cfbc778928e2ee"
		table:      "substitution"
		durability: "server"
		access: scope: "internal"
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "game_id", type: "uuid", ref: "game"},
			{ordinal: 3, name: "player_off_id", type: "uuid", ref: "player"},
			{ordinal: 4, name: "player_on_id", type: "uuid", ref: "player"},
			{ordinal: 5, name: "side", type: "string", cel: "this in ['home', 'away']"},
			{ordinal: 6, name: "minute", type: "int32", cel: "this >= 0 && this <= 130"},
			{ordinal: 7, name: "added_time", type: "int32", required: false, cel: "this >= 0"},
			{ordinal: 8, name: "period", type: "string", required: false},
			{ordinal: 9, name: "source_order", type: "int32", required: false, cel: "this >= 0"},
		]
		invariant: cel: "this.player_off_id != this.player_on_id"
	}
	SofaTick: {
		id: "0x9ef7ca41af7de357"
		table:      "sofa_tick"
		durability: "server"
		access: scope: "internal"
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "schedule", type: "text"},
			{ordinal: 3, name: "tick_at", type: "timestamptz"},
			{ordinal: 4, name: "late", type: "bool"},
			{ordinal: 5, name: "caller", type: "text", required: false},
		]
	}
}
// Reducer wakes, fixture edits, midnight rollovers and budget-window ticks
// retire stale state, seed fixture sources and admit due resources (sofa.tick).
code: state: drains: "sofascore-admission": {
	on: ["sofa_resource_seat", "sofa_provider_seat", "game", "day_tick", "sofa_tick"]
	call: "refresh_sofascore_queue"
}
loop: surface: checks: "sofascore-normalize": {
	verb: "test"
	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/sofascore-normalize.ts"]
	note: "the database function answers what normalize.py answers, refuses what it raises on, and fits its fuel"
}
loop: surface: checks: "sofascore-reconcile": {
	verb: "test"
	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/sofascore-reconcile.ts"]
	note: "the database function answers what reconcile.py's response checks and event_patch answer, refuses what they raise on, and fits its fuel"
}
loop: surface: checks: "sofascore-adapter": {
	verb: "test"
	cmds: ["python3 -m unittest discover -s tools/sofascore -p 'test_*.py'"]
	note: "the reference implementations the database functions are held to: identity recovery, final-only normalization and completeness"
}
code: state: functions: sofascore_normalize: {
	rules: "rules/sofascore/normalize.js"
	fuel:  100000
	note:  "SofaScore round events and match details into apply_patch input; the calendar day stays SQL's"
}
code: state: functions: sofascore_reconcile: {
	rules: "rules/sofascore/reconcile.js"
	fuel:  1000000
	note:  "a round or event response's source checks and scope filter, and each event's patch against the source's bindings, stages and games"
}
code: state: entities: {
	SofaRequest: {
		id: "0x8d74c222c6bc5379"
		table:      "sofa_request"
		durability: "server"
		access: scope: "internal"
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "status", type: "string"},
			{ordinal: 3, name: "source_id", type: "uuid"},
			{ordinal: 4, name: "resource_id", type: "uuid"},
			{ordinal: 5, name: "family", type: "string"},
			{ordinal: 6, name: "resource_key", type: "string"},
			{ordinal: 7, name: "path", type: "string"},
			{ordinal: 8, name: "seq", type: "int64", cel: "this > 0"},
			{ordinal: 9, name: "failure", type: "string", required: false},
			{ordinal: 10, name: "admitted_at", type: "timestamptz", default: "clock_timestamp()"},
			{ordinal: 11, name: "stuck_at", type: "timestamptz", required: false},
		]
	}
}
code: state: steps: {
	graphile: "060"
	airlock:  "061"
	machines: "062"
	actors:   "063"
	jobKey:   "064"
	note:     "The raw steps 010 to 055 and the forward migrations 013 to 20261110 create no sofa_request row: requests exist only once sofa.admit runs, 062 is a read and 063 the actors, and both seeds (801, 900) sort above every placed step."
}
code: state: mecha: rows: SofaRequestMachine: {
	name:    "SofaRequestMachine"
	entity:  "SofaRequest"
	field:   "status"
	initial: "acquiring"
	states: {
		acquiring: invoke: {
			src: "acquire"
			onDone: {target: "applied", actions: [{hatch: {name: "sofascore-receive", call: "sofa.receive", args: [{raw: "NEW.id"}, {raw: "NEW.source_id"}, {raw: "NEW.family"}, {raw: "NEW.resource_key"}, {raw: "NEW.seq"}, {raw: "outcome"}]}}]}
			onError: {target: "failed", actions: [
				{assign: {failure: {raw: "coalesce(outcome->'data'->>'error', outcome->'data'->>'reason', outcome->>'kind')"}}},
				{hatch: {name: "sofascore-receive", call: "sofa.fail", args: [{raw: "NEW.resource_id"}, {raw: "outcome"}]}},
			]}
		}
		applied: type: "final"
		failed: type:  "final"
	}
}
// The local stack answers SofaScore from a simulated league and the
// end-to-end test's scripted cases; the docker appliance runs the transport
// itself, and Cloudflare runs it on Cloudflare Containers, owned by the
// airlock's dispatcher (pronto's container-bridges.md#Targets).
code: state: bridges: sofascore: {
	container: "sofascore"
	port:      8080
	targets: ["docker", "cloudflare"]
	appliance: {
		srcs: ["/usr/local/bin/sofascore_fetch"]
		command: ["/usr/local/bin/sofascore_fetch", "--listen", "127.0.0.1:8081"]
		port: 8081
	}
	simulator: {
		dockerfile: {
			from: name: bayt.lock.images.node
			workdir: "/simulator"
			preamble: ["COPY --from=\(bayt.lock.images.deno_bin) /deno /usr/local/bin/deno"]
			copy: [{srcs: ["simulators/sofascore/*"], dst: "/simulator/"}]
			cmd: ["deno", "run", "--allow-net=0.0.0.0:8080", "--allow-read=/simulator", "/simulator/simulator.ts", "0.0.0.0:8080"]
		}
		srcs: globs: ["simulators/sofascore/*"]
		expose: http: {port: 8080, env: "SOFASCORE_PORT"}
		"process-compose": activate: "mise x --"
		// On the host, the same simulator under golaberto's pinned Deno.
		entrypoint: {
			shell: "nu"
			do:    "let at = $\"127.0.0.1:($env.SOFASCORE_PORT? | default '8080')\"; exec deno run $\"--allow-net=($at)\" --allow-read=simulators/sofascore simulators/sofascore/simulator.ts $at"
		}
	}
}
code: state: effects: acquire: {
	input: {id: "NEW.id", path: "NEW.path"}
	sink: {bridge: "sofascore", idempotent: false}
	reentry: "repeat"
	note:    "A repeated GET is harmless: every answer is an observation keyed by its request, and only a resource's newest is applied"
}
code: capabilities: hatches: {
	sofascore: {ir: "hatch-sofascore-transport", kind: "container", note: "wreq Chrome TLS profile; follows up to five redirects within the SofaScore host allowlist and reports each request"}
	"sofascore-receive": {ir: "hatch-sofascore-receive", kind: "sql", files: ["services/database/sql/059_sofascore_requests.sql"], note: "The request machine's commit stores, parses and applies an answer, or records a failure, through SQL the machine calls"}
}
// The transport's toolchain, shared by its image and the check of its tests.
_rustImage: "rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0"
_rustDeps:  "cmake clang libclang-dev perl ca-certificates"
// The transport's own tests: the local stack runs its simulator, and no
// release lowers it yet, so nothing else builds it.
loop: surface: checks: "sofascore-fetch": {
	verb: "test"
	cmds: ["docker run --rm -v $\"($env.PWD)/tools/sofascore-fetch:/src:ro\" -v golaberto-sofascore-fetch-cargo:/usr/local/cargo/registry -v golaberto-sofascore-fetch-target:/target -e CARGO_TARGET_DIR=/target -w /src \(_rustImage) sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends \(_rustDeps) >/dev/null && cargo test --release --locked'"]
	note: "the transport's allowlist, redirects, size bounds and HTTP and JSON-lines protocols"
}
cluster: surface: targets: sofascore: {
	visibility: "public"
	activate:   ""
	cmd: "builtin": null
	srcs: globs: ["tools/sofascore-fetch/Cargo.toml", "tools/sofascore-fetch/Cargo.lock", "tools/sofascore-fetch/src/*.rs", "tools/sofascore-fetch/tests/*.rs"]
	dockerfile: {
		from: name: _rustImage
		workdir: "/app"
		copy: [
			{srcs: ["tools/sofascore-fetch/Cargo.toml", "tools/sofascore-fetch/Cargo.lock"], dst: "/app/"},
			{srcs: ["tools/sofascore-fetch/src/*.rs"], dst: "/app/src/"},
			{srcs: ["tools/sofascore-fetch/tests/*.rs"], dst: "/app/tests/"},
		]
		epilogue: [
			"RUN apt-get update && apt-get install -y --no-install-recommends \(_rustDeps) && rm -rf /var/lib/apt/lists/*",
			"RUN cargo test --release --locked --manifest-path /app/Cargo.toml && cargo build --release --locked --manifest-path /app/Cargo.toml && cp /app/target/release/sofascore_fetch /usr/local/bin/sofascore_fetch",
		]
		cmd: ["sofascore_fetch", "--listen", "0.0.0.0:8080"]
	}
	compose: restart: "unless-stopped"
}
// Every target runs the ticker over the reducers' deadlines and the
// admission drain (clock.ts on the edge, services/ticker in containers).
code: meta: clocks: ["cloudflare", "docker", "k8s", "gcp"]
