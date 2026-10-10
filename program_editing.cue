@extern(embed)

package golaberto

import "strings"

_editingParitySql:     string @embed(file="services/database/sql/036_editing_parity.sql", type=text)
_editingParityUpgrade: strings.Replace(strings.Replace(_editingParitySql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)

code: state: entities: {
	PlayerMerge: {
		id:         "0x84943c9ea2128e3f"
		table:      "player_merge"
		durability: "server"
		access: {scope: "private", owner: "app_user_id"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "app_user_id", type: "uuid", ref: "app_user", default: "auth_uid()"},
			{ordinal: 3, name: "target_player_id", type: "uuid"},
			{ordinal: 4, name: "source_player_id", type: "uuid"},
			{ordinal: 5, name: "created_at", type: "timestamp", default: "now()"},
		]
		invariant: {cel: "this.target_player_id != this.source_player_id"}
	}

}

code: state: migrations: "036_editing_parity": {operations: [{sql: {up: _editingParityUpgrade, onComplete: true}}]}

build: checks: "editing-parity": {
	priority: 1
	database: true
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-net --allow-read --allow-sys tests/editing-parity.ts"]
	note: "editor grants, immutable attribution, dependency refusal, registration cleanup and player merge run against Postgres"
}

code: meta: tests: {
	"test-everyday-editing": {
		of:   "gerenciar"
		says: "an editor maintains source records, resolves bounded references and merges a duplicate without losing history"
		given: {role: "editor"}
		when: "create, update and delete records; maintain goals, squads and registrations; merge a duplicate"
		then: "output.persisted && output.attributed && output.history_preserved"
	}
	"test-editing-grant": {
		of:   "gerenciar"
		says: "readers cannot edit and deleting a referenced source record preserves its dependents"
		given: {role: "reader", referenced: true}
		when: "open editing and submit a source mutation"
		then: "output.refused && output.dependents_preserved"
	}
}
