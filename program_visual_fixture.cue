package golaberto

build: project: targets: integrate: {
	srcs: defaultGlobs: {
		"visual-fixture-ready": glob: "tests/visual-ready.ts"
		"visual-fixture-db": glob:    "tests/db.ts"
		"visual-fixture-config": glob: "tests/deno.json"
		"visual-fixture-lock": glob: "tests/deno.lock"
	}
	dockerfile: epilogue: ["RUN deno cache --config tests/deno.json --lock tests/deno.lock --frozen tests/visual-ready.ts"]
	compose: {
		environment: DATABASE_URL: cluster.surface.databaseUrl
		entrypoint: ["sh", "-c", "deno run --config tests/deno.json --lock tests/deno.lock --frozen --cached-only --allow-env --allow-net --allow-read --allow-sys tests/visual-ready.ts && exec \"$@\"", "visual-fixture-ready"]
	}
}
