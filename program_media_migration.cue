@extern(embed)

package golaberto

import "strings"

_nativeMediaSql: string @embed(file="services/database/sql/041_native_media.sql", type=text)
_nativeMediaUpgrade: strings.Replace(strings.Replace(_nativeMediaSql, "BEGIN;\n", "", 1), "\nCOMMIT;\n", "\n", -1)
code: state: migrations: "041_native_media": {operations: [{sql: {up: _nativeMediaUpgrade, onComplete: true}}]}

loop: surface: checks: "media-controls": {
	verb: "test"
	cmds: ["\(_dependencyTest) omnishell --config tests/deno.json --no-lock --allow-read --allow-env tests/media-controls.ts"]
	note: "media images use only bounded object keys and the existing blob route"
}

build: checks: "native-media": {
 priority: 1
 database: true
 srcs: ["services/database/sql/041_native_media.sql", "services/media/deno.json", "services/media/deno.lock", "services/media/normalize.ts", "services/media/request.ts", "services/media/native-gateway.ts"]
 cmds: ["deno test --config services/media/deno.json --frozen --allow-read --allow-env --allow-net --allow-ffi tests/media-normalize.ts tests/native-media.ts"]
 note: "authenticated uploads bind atomically and keep pending storage private and bounded"
}
