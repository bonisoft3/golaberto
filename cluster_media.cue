package golaberto

import pronto "github.com/bonisoft3/pronto"
import bayt "github.com/bonisoft3/bayt/core:bayt"

code: capabilities: {
	blobs: false
	hatches: "rclone-s3": {ir: "hatch-native-media", kind: "container", note: "Authenticated app media gateway adapts the existing /blobs upstream. Private normalized bytes live in PostgreSQL; raw rclone and imgproxy are not started."}
}

cluster: surface: targets: {
	"rclone-s3": {
		visibility: "public"
		activate: ""
		cmd: "builtin": null
		"process-compose": activate: "mise x --"
		healthcheck: bayt.healthcheck.#http & {port: 3900, path: "/health"}
		expose: http: {port: 3900, env: "PORT"}
		entrypoint: {
			shell: "nu"
			do:    "^deno run --frozen --allow-env --allow-read --allow-write --allow-ffi --allow-net --config services/media/deno.json services/media/main.ts"
			env: {
				DATABASE_URL:     ["postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@", {peer: "database", port: "pg"}, "/${POSTGRES_DB:-golaberto}"]
				PGRST_JWT_SECRET: cluster.surface.jwtSecret
			}
			after: {
				database: "healthy"
				migrate:  "completed"
			}
		}
		srcs: globs: ["services/media/*.ts", "services/media/deno.json", "services/media/deno.lock"]
		dockerfile: {
			from: name: "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
			workdir: "/app"
			copy: [{srcs: ["services/media/*.ts", "services/media/deno.json", "services/media/deno.lock"], dst: "/app/"}]
			epilogue: ["RUN deno cache --frozen main.ts"]
			cmd: ["run", "--frozen", "--cached-only", "--allow-env", "--allow-read", "--allow-ffi", "--allow-net=database:5432,0.0.0.0:3900", "main.ts"]
		}
		compose: {
			depends_on: {database: {condition: "service_healthy"}, migrate: {condition: "service_completed_successfully"}}
			environment: {DATABASE_URL: cluster.surface.databaseUrl, PGRST_JWT_SECRET: cluster.surface.jwtSecret}
			healthcheck: {test: ["CMD", "deno", "eval", "const r=await fetch('http://127.0.0.1:3900/health'); if(!r.ok) Deno.exit(1)"], interval: "5s", timeout: "3s", retries: 5}
		}
	}
	launch: compose: depends_on: "rclone-s3": {condition: "service_healthy"}
	caddy: entrypoint: env: PRONTO_UPSTREAM_RCLONE_S3: {peer: "rclone-s3", port: "http"}
}

// The door's claim on every write is the same here as on the plane it replaces;
// the gateway still authorizes and normalizes what the claim lets through.
code: state: migrations: "052_blob_claims": {operations: [{sql: {up: pronto.#blobClaimsSql, onComplete: true}}]}
