package golaberto

import pronto "github.com/bonisoft3/pronto"

loop: surface: checks: "hosted-verification-dom": {
	verb: "test"
	cmds: ["\((pronto.#Platform & {tree: "pronto"}).rule); deno test --config ($pronto | path join deno.json) --lock ($pronto | path join deno.lock) --frozen --allow-read --allow-env tests/verify-dom_test.ts"]
	note: "hosted standings proof identifies real template rows across goal changes and rejects document reloads"
}

build: checks: "statistics-live": {
	srcs: ["bayt.json"]
	priority: 1
	browser:  true
	database: true
	cmds: ["\(pronto.#Harness.check); deno test \(pronto.#Harness.flags) --allow-all --unsafely-ignore-certificate-errors=caddy --filter=live: tests/acceptance.ts"]
	note: "chances, standings and player totals change and undo on already-open documents; two readers observe the same goal"
}

_dependencyTest: "mise exec -- deno run --no-config --allow-read --allow-write --allow-run=mise tests/dependency-test.ts"

loop: surface: checks: "route-localization": {
	verb: "test"
	cmds: ["mise exec -- deno test --config tests/deno.json --lock tests/deno.lock --frozen --allow-read tests/route-localization.ts"]
	note: "every site route has all six language addresses and preserves its record parameters"
}

loop: surface: checks: "engine-carry": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(pronto.#Platforms.flags) --unstable-raw-imports --allow-read tests/engine-carry.ts"]
	note: "the actors step keeps its released bytes and the carry after it holds the engines the rules compile to"
}

loop: surface: checks: "archive-controls": {
	verb: "test"

	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/archive-controls.ts"]
	note: "calendar and round filters in the actual handler cage"
}

loop: surface: checks: "hosted-verification": {
	verb: "test"
	cmds: ["\((pronto.#Platform & {tree: "pronto"}).rule); deno test --config ($pronto | path join deno.json) --lock ($pronto | path join deno.lock) --frozen --allow-read --allow-write --allow-env tests/verify_test.ts"]
	note: "hosted statistics fixtures retract after publication failure or a lost insert response and preserve concurrent edits"
}

loop: surface: checks: "match-score": {
	verb: "test"

	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/match-score.ts"]
	note: "final scores include extra-time goals and retain separate shootout results"
}

loop: surface: checks: "player-csv": {
	verb: "test"

	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/player-csv.ts"]
	note: "bounded exports retain CSV quoting and reject spreadsheet formulas"
}

loop: surface: checks: "editing-controls": {
	verb: "test"

	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/editing-controls.ts"]
	note: "native CRUD controls preserve typed values, bounded choices, editor gating and refused edits"
}

loop: surface: checks: "player-standalone": {
	verb: "test"

	cmds: ["\(_dependencyTest) --no-config --unstable-sloppy-imports --no-lock --allow-read tests/player-standalone.ts"]
	note: "standalone migrations retain public player reads and their aggregate semantics"
}
