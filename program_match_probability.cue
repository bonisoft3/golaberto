@extern(embed)

package golaberto

import "strings"

_matchProbabilitySql:     string @embed(file="services/database/sql/039_match_probability.sql", type=text)
_matchProbabilityUpgrade: strings.Replace(strings.Replace(_matchProbabilitySql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)

code: state: entities: {
	MatchProbability: {
		id: "0xde64479fbf5382c5"
		table:      "match_probability"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "game"},
			{ordinal: 2, name: "game_id", type: "uuid", ref: "game"},
			{ordinal: 3, name: "home_name", type: "string"},
			{ordinal: 4, name: "away_name", type: "string"},
			{ordinal: 5, name: "rating_status", type: "string", cel: "this in ['available', 'missing-rating', 'ambiguous-rating']"},
			{ordinal: 6, name: "timeline_status", type: "string", cel: "this in ['available', 'missing-rating', 'ambiguous-rating', 'unknown-event-minute', 'event-limit']"},
			{ordinal: 7, name: "payload_json", type: "string"},
		]
	}
	MatchProbabilityScenario: {
		id: "0xb2a3e1db2f1f2c94"
		table:      "match_probability_scenario"
		durability: "tab"
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "state", type: "string", default: "'ready'", cel: "this == 'ready'"},
			{ordinal: 3, name: "minute", type: "string", default: "'0'", cel: "this == '' || this.matches('^(0|[1-9]|[1-9][0-9]|1[0-2][0-9]|130)$')"},
			{ordinal: 4, name: "added_time", type: "string", default: "'5'", cel: "this == '' || this.matches('^(0|[1-9]|[1-3][0-9]|40)$')"},
			{ordinal: 5, name: "event_sequence", type: "int32", default: "0", cel: "this >= 0"},
			{ordinal: 6, name: "next_event_id", type: "string", default: "''", cel: "this.size() <= 80"},
			{ordinal: 7, name: "event_count", type: "int32", default: "0", cel: "this >= 0 && this <= 20"},
			{ordinal: 8, name: "events_json", type: "string", default: "'[]'", cel: "this.size() <= 4000"},
			{ordinal: 9, name: "payload_json", type: "string", default: "''"},
			{ordinal: 10, name: "home_name", type: "string", default: "''"},
			{ordinal: 11, name: "away_name", type: "string", default: "''"},
		]
	}
	MatchProbabilityScenarioEvent: {
		id: "0xd263ad5b26f1db13"
		table:      "match_probability_scenario_event"
		durability: "tab"
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 80"},
			{ordinal: 2, name: "game_id", type: "uuid"},
			{ordinal: 3, name: "state", type: "string", default: "'ready'", cel: "this == 'ready'"},
			{ordinal: 4, name: "sequence", type: "int32", cel: "this >= 1"},
			{ordinal: 5, name: "kind", type: "string", cel: "this in ['goal', 'red_card']"},
			{ordinal: 6, name: "side", type: "string", default: "'home'", cel: "this in ['home', 'away']"},
			{ordinal: 7, name: "minute", type: "int32", default: "0", cel: "this >= 0 && this <= 130"},
		]
	}
}

code: surface: handlers: {
	"match-probability-event-control": {
		ir:   "handler-match-probability-event-control"
		of:   "jogo"
		src:  "shell/handlers/match-probability-event-control.js"
		note: "Bound and identify hypothetical events without a clock or random source."
	}
	"match-probability-event-edit": {
		ir:   "handler-match-probability-event-edit"
		of:   "jogo"
		src:  "shell/handlers/match-probability-event-edit.js"
		note: "Apply a valid side or minute edit to the event row whose native control fired."
	}
	"match-probability-event-fold": {
		ir:   "handler-match-probability-event-fold"
		of:   "jogo"
		src:  "shell/handlers/match-probability-event-fold.js"
		note: "Project at most twenty typed hypothetical event rows into the renderer payload."
	}
	"match-probability-seed": {
		ir:   "handler-match-probability-seed"
		of:   "jogo"
		src:  "shell/handlers/match-probability-seed.js"
		note: "Store the scenario row from its fallback, carrying the game's computed probabilities the chart renders from."
	}
}

code: state: migrations: "039_match_probability": {
	operations: [{sql: {up: _matchProbabilityUpgrade, onComplete: true}}]
}

build: checks: "match-probability": {
	priority: 1
	database: true
	srcs: ["services/database/sql/039_match_probability.sql"]
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-net --allow-read --allow-sys tests/match-probability.ts"]
	note: "strict historical-rating cutoffs, ambiguous or missing ratings, bounded event payloads and read-only access run against Postgres"
}

loop: surface: checks: "match-probability-renderer": {
	verb: "test"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock --allow-read --allow-env tests/match-probability-renderer.ts tests/match-probability-events.ts"]
	note: "Rails probability vectors, individually editable scenarios and accessible Jessie SVG output stay pure and bounded"
}

code: meta: tests: "test-match-probability": {
	of:   "jogo"
	says: "a game's chances use only ratings from before it and stay bounded under scenarios"
	given: {events: 20}
	when: "read the game page and edit hypothetical goals and red cards"
	then: "output.prior_ratings_only && output.matches_rails && output.bounded"
}
