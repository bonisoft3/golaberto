@extern(embed)

package golaberto

import "strings"

_matchContextSql:     string @embed(file="services/database/sql/038_match_context.sql", type=text)
_matchContextUpgrade: strings.Replace(strings.Replace(_matchContextSql, "\nBEGIN;\n", "\n", -1), "\nCOMMIT;\n", "\n", -1)

code: state: entities: {
	MatchRecentResult: {
		id: "0xeb1383964ad67b15"
		table:      "match_recent_result"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "target_game_id", type: "uuid"},
			{ordinal: 3, name: "team_id", type: "uuid"},
			{ordinal: 4, name: "side", type: "string"},
			{ordinal: 5, name: "game_id", type: "uuid"},
			{ordinal: 6, name: "game_slug", type: "string"},
			{ordinal: 7, name: "day", type: "date"},
			{ordinal: 8, name: "day_display", type: "string"},
			{ordinal: 9, name: "kickoff", type: "timestamp", required: false},
			{ordinal: 10, name: "kickoff_local", type: "string"},
			{ordinal: 11, name: "championship_id", type: "uuid"},
			{ordinal: 12, name: "championship_name", type: "string"},
			{ordinal: 13, name: "championship_slug", type: "string"},
			{ordinal: 14, name: "show_country", type: "bool"},
			{ordinal: 15, name: "home_id", type: "uuid"},
			{ordinal: 16, name: "home_name", type: "string"},
			{ordinal: 17, name: "home_country", type: "string"},
			{ordinal: 18, name: "home_slug", type: "string"},
			{ordinal: 19, name: "away_id", type: "uuid"},
			{ordinal: 20, name: "away_name", type: "string"},
			{ordinal: 21, name: "away_country", type: "string"},
			{ordinal: 22, name: "away_slug", type: "string"},
			{ordinal: 23, name: "home_score", type: "int32"},
			{ordinal: 24, name: "away_score", type: "int32"},
			{ordinal: 25, name: "home_aet", type: "int32", required: false},
			{ordinal: 26, name: "away_aet", type: "int32", required: false},
			{ordinal: 27, name: "home_pen", type: "int32", required: false},
			{ordinal: 28, name: "away_pen", type: "int32", required: false},
			{ordinal: 29, name: "result", type: "string", cel: "this in ['w', 'd', 'l']"},
		]
	}
	MatchHeadToHead: {
		id: "0x837a27b1bc209bc3"
		table:      "match_head_to_head"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "target_game_id", type: "uuid"},
			{ordinal: 3, name: "game_id", type: "uuid"},
			{ordinal: 4, name: "game_slug", type: "string"},
			{ordinal: 5, name: "day", type: "date"},
			{ordinal: 6, name: "day_display", type: "string"},
			{ordinal: 7, name: "kickoff", type: "timestamp", required: false},
			{ordinal: 8, name: "kickoff_local", type: "string"},
			{ordinal: 9, name: "championship_id", type: "uuid"},
			{ordinal: 10, name: "championship_name", type: "string"},
			{ordinal: 11, name: "championship_slug", type: "string"},
			{ordinal: 12, name: "category_id", type: "uuid", required: false},
			{ordinal: 13, name: "show_country", type: "bool"},
			{ordinal: 14, name: "home_id", type: "uuid"},
			{ordinal: 15, name: "home_name", type: "string"},
			{ordinal: 16, name: "home_country", type: "string"},
			{ordinal: 17, name: "home_slug", type: "string"},
			{ordinal: 18, name: "away_id", type: "uuid"},
			{ordinal: 19, name: "away_name", type: "string"},
			{ordinal: 20, name: "away_country", type: "string"},
			{ordinal: 21, name: "away_slug", type: "string"},
			{ordinal: 22, name: "home_score", type: "int32"},
			{ordinal: 23, name: "away_score", type: "int32"},
			{ordinal: 24, name: "home_aet", type: "int32", required: false},
			{ordinal: 25, name: "away_aet", type: "int32", required: false},
			{ordinal: 26, name: "home_pen", type: "int32", required: false},
			{ordinal: 27, name: "away_pen", type: "int32", required: false},
			{ordinal: 28, name: "home_logo_key", type: "string", required: false},
			{ordinal: 29, name: "away_logo_key", type: "string", required: false},
		]
	}
	MatchLineup: {
		id: "0xbe3f72462ba09382"
		table:      "match_lineup"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "game_id", type: "uuid"},
			{ordinal: 3, name: "player_id", type: "uuid"},
			{ordinal: 4, name: "side", type: "string"},
			{ordinal: 5, name: "on_minute", type: "int32"},
			{ordinal: 6, name: "off_minute", type: "int32", required: false},
			{ordinal: 7, name: "yellow", type: "bool"},
			{ordinal: 8, name: "red", type: "bool"},
			{ordinal: 9, name: "bench", type: "bool"},
			{ordinal: 10, name: "player_name", type: "string"},
			{ordinal: 11, name: "position", type: "string", required: false},
			{ordinal: 12, name: "player_slug", type: "string"},
			{ordinal: 13, name: "off_rating", type: "double", required: false},
			{ordinal: 14, name: "def_rating", type: "double", required: false},
			{ordinal: 15, name: "contribution", type: "double"},
		]
	}
	MatchLocation: {
		id: "0xfc4c633a94f59b86"
		table:      "match_location"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "home_id", type: "uuid"},
			{ordinal: 3, name: "home_name", type: "string"},
			{ordinal: 4, name: "home_latitude", type: "double", required: false},
			{ordinal: 5, name: "home_longitude", type: "double", required: false},
			{ordinal: 6, name: "away_id", type: "uuid"},
			{ordinal: 7, name: "away_name", type: "string"},
			{ordinal: 8, name: "away_latitude", type: "double", required: false},
			{ordinal: 9, name: "away_longitude", type: "double", required: false},
			{ordinal: 10, name: "distance_km", type: "double", required: false},
			{ordinal: 11, name: "map_embed_url", type: "string", required: false},
		]
	}
}

code: state: migrations: "038_match_context": {
	operations: [{sql: {up: _matchContextUpgrade, onComplete: true}}]
}

build: checks: "match-context": {
	priority: 1
	database: true
	srcs: ["services/database/sql/038_match_context.sql"]
	cmds: ["deno test --config tests/deno.json --no-lock --allow-env --allow-net --allow-read --allow-sys tests/match-context.ts"]
	note: "bounded recent form, same-category head-to-head history, lineup contribution, distance and fixed-origin map URLs run against Postgres"
}

loop: surface: checks: "match-context-renderer": {
	verb: "test"
	cmds: ["mise exec -- deno test --config tests/deno.json --no-lock tests/match-context-renderer.ts"]
	note: "the pure match renderer keeps validated coordinates, distance and route links inside the prose allowlist"
}

code: meta: tests: "test-match-context": {
	of:   "jogo"
	says: "a game's context bounds form and meetings at five and never fabricates a distance"
	given: {coordinates: "partial"}
	when: "read the game page"
	then: "output.bounded && output.ordered && output.distance_explicit"
}
