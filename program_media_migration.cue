@extern(embed)

package golaberto

import (
	"strings"

	pronto "github.com/bonisoft3/pronto"
)

_nativeMediaSql: string @embed(file="services/database/sql/041_native_media.sql", type=text)
_nativeMediaUpgrade: strings.Replace(strings.Replace(_nativeMediaSql, "BEGIN;\n", "", 1), "\nCOMMIT;\n", "\n", -1)
code: state: migrations: "041_native_media": {operations: [{sql: {up: _nativeMediaUpgrade, onComplete: true}}]}

loop: surface: checks: "media-controls": {
	verb: "test"
	cmds: ["\(pronto.#Harness.rule); mise exec -- deno test \(pronto.#Harness.flags) --allow-read --allow-env tests/media-controls.ts"]
	note: "media images use only bounded object keys and the existing blob route"
}
