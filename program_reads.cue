package golaberto

code: state: entities: {
	PhaseDirectory: {
		id: "0xa8ed30eedb435a14"
		table:      "phase_directory"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "name", type: "string"},
			{ordinal: 3, name: "championship_id", type: "uuid"},
			{ordinal: 4, name: "championship_name", type: "string"},
			{ordinal: 5, name: "search_key", type: "string"},
		]
	}

	PlayerDirectory: {
		id: "0xe0b08154b2af5782"
		table: "player_directory"
		durability: "server"
		writers: "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "name", type: "string", required: false},
			{ordinal: 3, name: "full_name", type: "string", required: false},
			{ordinal: 4, name: "birth", type: "date", required: false},
			{ordinal: 5, name: "country", type: "string", required: false},
			{ordinal: 6, name: "height", type: "int32", required: false},
			{ordinal: 7, name: "position", type: "string", required: false},
			{ordinal: 8, name: "slug", type: "string", required: false},
			{ordinal: 9, name: "rating", type: "double", required: false},
			{ordinal: 10, name: "off_rating", type: "double", required: false},
			{ordinal: 11, name: "def_rating", type: "double", required: false},
			{ordinal: 12, name: "position_key", type: "string", required: false},
			{ordinal: 13, name: "country_id", type: "string", required: false},
			{ordinal: 14, name: "region_id", type: "string", required: false},
			{ordinal: 15, name: "search_key", type: "string", required: false},
			{ordinal: 16, name: "country_search_key", type: "string", required: false},
			{ordinal: 17, name: "region_search_key", type: "string", required: false},
			{ordinal: 18, name: "latest_team_id", type: "uuid", required: false},
			{ordinal: 19, name: "latest_team_name", type: "string", required: false},
			{ordinal: 20, name: "latest_team_slug", type: "string", required: false},
			{ordinal: 21, name: "latest_team_logo_key", type: "string", required: false},
		]
	}
	GameArchive: {
		id: "0x853b9ec68d8b90d2"
		table: "game_archive"
		durability: "server"
		writers: "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "phase_id", type: "uuid", required: false},
			{ordinal: 3, name: "round", type: "int32", required: false},
			{ordinal: 4, name: "day", type: "date", required: false},
			{ordinal: 5, name: "kickoff", type: "timestamp", required: false},
			{ordinal: 6, name: "home_id", type: "uuid", required: false},
			{ordinal: 7, name: "away_id", type: "uuid", required: false},
			{ordinal: 8, name: "home_field", type: "string", required: false},
			{ordinal: 9, name: "played", type: "bool", required: false},
			{ordinal: 10, name: "home_score", type: "int32", required: false},
			{ordinal: 11, name: "away_score", type: "int32", required: false},
			{ordinal: 12, name: "home_aet", type: "int32", required: false},
			{ordinal: 13, name: "away_aet", type: "int32", required: false},
			{ordinal: 14, name: "home_pen", type: "int32", required: false},
			{ordinal: 15, name: "away_pen", type: "int32", required: false},
			{ordinal: 16, name: "stadium_id", type: "uuid", required: false},
			{ordinal: 17, name: "referee_id", type: "uuid", required: false},
			{ordinal: 18, name: "attendance", type: "int32", required: false},
			{ordinal: 19, name: "day_display", type: "string", required: false},
			{ordinal: 20, name: "kickoff_local", type: "string", required: false},
			{ordinal: 21, name: "slug", type: "string", required: false},
			{ordinal: 22, name: "championship_id", type: "uuid", required: false},
			{ordinal: 23, name: "championship_name", type: "string", required: false},
			{ordinal: 24, name: "championship_slug", type: "string", required: false},
			{ordinal: 25, name: "phase_name", type: "string", required: false},
			{ordinal: 26, name: "category_id", type: "uuid", required: false},
			{ordinal: 27, name: "category_key", type: "string", required: false},
			{ordinal: 28, name: "phase_key", type: "string", required: false},
			{ordinal: 29, name: "round_key", type: "string", required: false},
			{ordinal: 30, name: "week", type: "date", required: false},
			{ordinal: 31, name: "week_key", type: "string", required: false},
			{ordinal: 32, name: "show_country", type: "bool", required: false},
			{ordinal: 33, name: "home_name", type: "string", required: false},
			{ordinal: 34, name: "away_name", type: "string", required: false},
			{ordinal: 35, name: "home_country", type: "string", required: false},
			{ordinal: 36, name: "away_country", type: "string", required: false},
			{ordinal: 37, name: "home_slug", type: "string", required: false},
			{ordinal: 38, name: "away_slug", type: "string", required: false},
			{ordinal: 39, name: "stadium_name", type: "string", required: false},
			{ordinal: 40, name: "referee_name", type: "string", required: false},
			{ordinal: 41, name: "home_logo_key", type: "string", required: false},
			{ordinal: 42, name: "away_logo_key", type: "string", required: false},
		]
	}
	PlayerAppearance: {
		id: "0x8d885bdc70946da0"
		table: "player_appearance"
		durability: "server"
		writers: "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "player_id", type: "uuid", required: false},
			{ordinal: 3, name: "game_id", type: "uuid", required: false},
			{ordinal: 4, name: "side", type: "string", required: false},
			{ordinal: 5, name: "on_minute", type: "int32", required: false},
			{ordinal: 6, name: "off_minute", type: "int32", required: false},
			{ordinal: 7, name: "yellow", type: "bool", required: false},
			{ordinal: 8, name: "red", type: "bool", required: false},
			{ordinal: 9, name: "bench", type: "bool", required: false},
			{ordinal: 10, name: "day", type: "date", required: false},
			{ordinal: 11, name: "day_display", type: "string", required: false},
			{ordinal: 12, name: "kickoff", type: "timestamp", required: false},
			{ordinal: 13, name: "kickoff_local", type: "string", required: false},
			{ordinal: 14, name: "played", type: "bool", required: false},
			{ordinal: 15, name: "played_key", type: "string", required: false},
			{ordinal: 16, name: "game_slug", type: "string", required: false},
			{ordinal: 17, name: "phase_id", type: "uuid", required: false},
			{ordinal: 18, name: "phase_name", type: "string", required: false},
			{ordinal: 19, name: "championship_id", type: "uuid", required: false},
			{ordinal: 20, name: "championship_name", type: "string", required: false},
			{ordinal: 21, name: "championship_slug", type: "string", required: false},
			{ordinal: 22, name: "category_id", type: "uuid", required: false},
			{ordinal: 23, name: "category_key", type: "string", required: false},
			{ordinal: 24, name: "round", type: "int32", required: false},
			{ordinal: 25, name: "round_key", type: "string", required: false},
			{ordinal: 26, name: "week", type: "date", required: false},
			{ordinal: 27, name: "week_key", type: "string", required: false},
			{ordinal: 28, name: "team_id", type: "uuid", required: false},
			{ordinal: 29, name: "team_name", type: "string", required: false},
			{ordinal: 30, name: "team_slug", type: "string", required: false},
			{ordinal: 31, name: "home_id", type: "uuid", required: false},
			{ordinal: 32, name: "away_id", type: "uuid", required: false},
			{ordinal: 33, name: "home_name", type: "string", required: false},
			{ordinal: 34, name: "away_name", type: "string", required: false},
			{ordinal: 35, name: "home_country", type: "string", required: false},
			{ordinal: 36, name: "away_country", type: "string", required: false},
			{ordinal: 37, name: "show_country", type: "bool", required: false},
			{ordinal: 38, name: "home_score", type: "int32", required: false},
			{ordinal: 39, name: "away_score", type: "int32", required: false},
			{ordinal: 40, name: "home_aet", type: "int32", required: false},
			{ordinal: 41, name: "away_aet", type: "int32", required: false},
			{ordinal: 42, name: "home_pen", type: "int32", required: false},
			{ordinal: 43, name: "away_pen", type: "int32", required: false},
			{ordinal: 44, name: "minutes", type: "int32", required: false},
			{ordinal: 45, name: "off_rating", type: "double", required: false},
			{ordinal: 46, name: "def_rating", type: "double", required: false},
			{ordinal: 47, name: "contribution", type: "double", required: false},
			{ordinal: 48, name: "contribution_per90", type: "double", required: false},
			{ordinal: 49, name: "goals", type: "int32", required: false},
			{ordinal: 50, name: "penalties", type: "int32", required: false},
			{ordinal: 51, name: "own_goals", type: "int32", required: false},
			{ordinal: 52, name: "goals_per90", type: "double", required: false},
			{ordinal: 53, name: "home_logo_key", type: "string", required: false},
			{ordinal: 54, name: "away_logo_key", type: "string", required: false},
		]
	}
	ChampionshipAttendance: {
		id: "0xe66ae0649c6349c7"
		table: "championship_attendance"
		durability: "server"
		writers: "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true},
			{ordinal: 2, name: "championship_id", type: "uuid", required: false},
			{ordinal: 3, name: "team_id", type: "uuid", required: false},
			{ordinal: 4, name: "team_name", type: "string", required: false},
			{ordinal: 5, name: "team_slug", type: "string", required: false},
			{ordinal: 6, name: "games", type: "int32", required: false},
			{ordinal: 7, name: "attendance_count", type: "int32", required: false},
			{ordinal: 8, name: "total", type: "int64", required: false},
			{ordinal: 9, name: "average", type: "double", required: false},
			{ordinal: 10, name: "minimum", type: "int32", required: false},
			{ordinal: 11, name: "maximum", type: "int32", required: false},
			{ordinal: 12, name: "team_logo_key", type: "string", required: false},
		]
	}
}
