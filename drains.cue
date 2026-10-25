@extern(embed)

package golaberto

import "strings"

// The derived tables kept by SQL functions, each called when the tables it
// reads change (plugins/pronto/docs/pipelines-and-schedules.md#drains).

code: state: drains: {
	// Rating chart windows end at the UTC day, which re-queues every team.
	"team-enrichment": {
		on: ["player_metric_dirty", "team_roster_total_dirty", "team_rating_chart_dirty", "team_odds_chart_dirty", "day_tick"]
		call: "refresh_team_enrichment"
		body: {roster_batch: 50, rating_batch: 10, odds_batch: 5}
	}
	// Championship status moves with the local day as well as with the queue.
	"team-profiles": {
		on: ["team_profile_dirty", "day_tick"]
		call: "refresh_team_profiles"
		body: batch_size: 50
	}
	"team-directory": {on: ["team", "team_rating", "geography_country"], call: "refresh_team_directory"}
	"matches-games": {on: ["game_card"], call: "refresh_matches_games"}
	// Thirty days either side of the local day.
	"recent-championships": {
		on: ["championship", "phase", "stage_group", "team_group", "team_rating", "day_tick"]
		call: "refresh_recent_championships"
	}
}

// The two midnights the drains above roll over at. Nothing answers a tick:
// the drain it wakes is idempotent, and a missed one is repaired by the next.
code: state: entities: {
	DayTick: {
		id:         "0x971fa2cdb49661fa"
		table:      "day_tick"
		durability: "server"
		access: {scope: "internal"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "schedule", type: "text"},
			{ordinal: 3, name: "tick_at", type: "timestamptz"},
			{ordinal: 4, name: "late", type: "bool"},
			{ordinal: 5, name: "caller", type: "text", required: false},
		]
	}
}
code: state: schedules: {
	"utc-day": {cron: "0 0 * * *", emits: {entity: "DayTick", values: {}}}
	"local-day": {cron: "0 0 * * *", timeZone: "America/Sao_Paulo", emits: {entity: "DayTick", values: {}}}
}

// team-enrichment and team-profiles both write team_roster and its total
// queue; they take turns rather than deadlock.
_teamProjectionTurnSql: string @embed(file="services/database/sql/046_team_projection_turn.sql", type=text)
code: state: migrations: "046_team_projection_turn": {operations: [{sql: {
	up:         strings.Replace(strings.Replace(_teamProjectionTurnSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
	onComplete: true
}}]}

_teamProjectionWritersSql: string @embed(file="services/database/sql/047_team_projection_writers.sql", type=text)
code: state: migrations: "047_team_projection_writers": {operations: [{sql: {
	up:         strings.Replace(strings.Replace(_teamProjectionWritersSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)
	onComplete: true
}}]}
