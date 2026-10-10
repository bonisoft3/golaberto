package golaberto

code: capabilities: {
	blobs: false
	hatches: "rclone-s3": {ir: "hatch-native-media", kind: "container", note: "Authenticated app media gateway adapts the existing /blobs upstream. Private normalized bytes live in PostgreSQL; raw rclone and imgproxy are not started."}
}

cluster: surface: targets: {
	"rclone-s3": {
		visibility: "public"
		activate: ""
		cmd: "builtin": null
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
}
