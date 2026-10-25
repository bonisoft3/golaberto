@extern(embed)

package golaberto

import "strings"

_teamOddsProgressSql:     string @embed(file="services/database/sql/042_team_odds_progress.sql", type=text)
_teamOddsProgressUpgrade: strings.Replace(strings.Replace(_teamOddsProgressSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
_queuedOddsRefreshSql:    string @embed(file="services/database/sql/043_queued_odds_refresh.sql", type=text)

code: state: entities: {
	TeamOddsProgressSource: {
		id: "0xe29b0989914ccf9b"
		table: "team_odds_progress_source"
		durability: "tab"
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "group_id", type: "uuid"},
			{ordinal: 3, name: "team_id", type: "uuid"},
			{ordinal: 4, name: "current_json", type: "string", default: "'{}'"},
			{ordinal: 5, name: "series_json", type: "string", default: "'{}'"},
		]
	}
	TeamOddsProgress: {
		id: "0x830e6584120a43e0"
		table:      "team_odds_progress"
		durability: "live"
		access: {scope: "public"}
		uniques: [{name: "uq_team_odds_progress_group_team", cols: ["group_id", "team_id"]}]
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "group_id", type: "uuid", ref: "stage_group"},
			{ordinal: 3, name: "team_id", type: "uuid", ref: "team"},
			{ordinal: 4, name: "series_json", type: "string"},
		]
		indexes: [{on: "group_id"}, {on: "team_id"}]
	}
	TeamOddsProgressState: {
		id: "0x99ef78c734c07674"
		table:      "team_odds_progress_state"
		durability: "tab"
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "group_id", type: "uuid"},
			{ordinal: 3, name: "team_id", type: "uuid"},
			{ordinal: 4, name: "state", type: "string", cel: "this in ['viewing']", default: "'viewing'"},
			{ordinal: 5, name: "zone_id", type: "string", default: "'*'"},
			{ordinal: 6, name: "snapshot_index", type: "int32", cel: "this >= -1 && this <= 359", default: "-1"},
			{ordinal: 7, name: "snapshot_last", type: "int32", cel: "this >= 0 && this <= 359", default: "0"},
			// Declares the pointer measurement the graphs' gestures read.
			{ordinal: 8, name: "pointer_x", type: "int32", cel: "this >= 0 && this <= 1000", default: "1000"},
			{ordinal: 9, name: "series_json", type: "string", default: "'{}'"},
			{ordinal: 10, name: "current_json", type: "string", default: "'{}'"},
			{ordinal: 11, name: "position_number", type: "int32", cel: "this >= -1 && this <= 10000", default: "-1"},
			{ordinal: 12, name: "position_last", type: "int32", cel: "this >= 0 && this <= 10000", default: "0"},
			{ordinal: 13, name: "table_mode", type: "string", cel: "this in ['current', 'history']", default: "'current'"},
			{ordinal: 14, name: "range_from", type: "string", default: "''", cel: "this.size() <= 12"},
			{ordinal: 15, name: "range_to", type: "string", default: "''", cel: "this.size() <= 12"},
		]
	}
}

code: surface: handlers: {
	"position-odds-source": {ir: "handler-position-odds-source", of: "equipe-campeonato", src: "shell/handlers/position-odds-source.js", note: "source reads update a tab snapshot independently of the reader's inspection state"}
	"odds-progress-snapshot": {ir: "handler-odds-progress-snapshot", of: "equipe-campeonato", src: "shell/handlers/odds-progress-snapshot.js", note: "only the history's own date slider selects a recorded snapshot"}
	"odds-progress-point": {ir: "handler-odds-progress-point", of: "equipe-campeonato", src: "shell/handlers/odds-progress-point.js", note: "a pointer over the history graph selects the nearest recorded snapshot"}
	"odds-progress-zone": {ir: "handler-odds-progress-zone", of: "equipe-campeonato", src: "shell/handlers/odds-progress-zone.js", note: "a zone filter accepts only a zone the history carries, or all positions"}
	"position-odds-control": {ir: "handler-position-odds-control", of: "equipe-campeonato", src: "shell/handlers/position-odds-control.js", note: "current-position inspection and exact-value mode stay separate from recorded date selection"}
	"position-odds-fold": {ir: "handler-position-odds-fold", of: "equipe-campeonato", src: "shell/handlers/position-odds-fold.js", note: "the local source snapshot updates inspection while preserving the reader's selections"}
}

code: state: migrations: "042_team_odds_progress": {operations: [{sql: {up: _teamOddsProgressUpgrade, onComplete: true}}]}
code: state: migrations: "043_queued_odds_refresh": {operations: [{sql: {up: _queuedOddsRefreshSql, onComplete: true}}]}

loop: surface: checks: "odds-progress-renderer": {
	verb: "test"
	cmds: ["mise exec -- deno test --config tests/deno.json --lock tests/deno.lock --frozen --allow-read --allow-env tests/odds-progress-renderer.ts tests/odds-progress-controls.ts tests/position-odds-renderer.ts tests/position-odds-controls.ts tests/position-odds-hover.ts"]
	note: "shared-date stacks, zone paint by role or source hex, compact locale-aware odds, range totals and isolated chart controls"
}

code: meta: tests: "test-odds-history": {
	of:    "equipe-campeonato"
	says:  "the recorded odds history keeps whole days within its retention limit"
	given: {source_count: 404, retained_limit: 360}
	when:  "read recorded odds"
	then:  "output.sourceCount == input.source_count && output.omittedCount == 4 && output.retainedCount == input.retained_limit"
}
