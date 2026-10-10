package golaberto

_dependencyTest: "mise exec -- deno run --no-config --allow-read --allow-write --allow-run=mise tests/dependency-test.ts"

loop: surface: checks: "archive-controls": {
	verb: "test"

	cmds: ["\(_dependencyTest) omnishell --config tests/deno.json --no-lock --allow-read --allow-env tests/archive-controls.ts"]
	note: "calendar and round filters in the actual handler cage"
}

loop: surface: checks: "match-score": {
	verb: "test"

	cmds: ["\(_dependencyTest) omnishell --config tests/deno.json --no-lock --allow-read --allow-env tests/match-score.ts"]
	note: "final scores include extra-time goals and retain separate shootout results"
}

loop: surface: checks: "player-csv": {
	verb: "test"

	cmds: ["\(_dependencyTest) omnishell --no-config --no-lock --allow-read --allow-env tests/player-csv.ts"]
	note: "bounded exports retain CSV quoting and reject spreadsheet formulas"
}

loop: surface: checks: "editing-controls": {
	verb: "test"

	cmds: ["\(_dependencyTest) omnishell --config tests/deno.json --no-lock --allow-read --allow-env tests/editing-controls.ts"]
	note: "native CRUD controls preserve typed values, bounded choices, editor gating and refused edits"
}

loop: surface: checks: "player-standalone": {
	verb: "test"

	cmds: ["\(_dependencyTest) mecha --no-config --unstable-sloppy-imports --no-lock --allow-read tests/player-standalone.ts"]
	note: "standalone migrations retain public player reads and their aggregate semantics"
}
