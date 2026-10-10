package golaberto

code: state: entities: {
	UserBiography: {
		id: "0xcabe14dab574b31c"
		table:      "user_biography"
		durability: "server"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "app_user_id", type: "uuid", ref: "app_user", unique: true, default: "auth_uid()"},
			{ordinal: 3, name: "display_name", type: "string", required: false, cel: "this.size() <= 100"},
			{ordinal: 4, name: "location", type: "string", required: false, cel: "this.size() <= 100"},
			{ordinal: 5, name: "about_me", type: "string", required: false, cel: "this.size() <= 2000"},
			{ordinal: 6, name: "updated_at", type: "timestamp", default: "now()"},
		]
	}
	UserDirectory: {
		id: "0xf8705353de87b210"
		table:      "user_directory"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true},
			{ordinal: 2, name: "handle", type: "string"},
			{ordinal: 3, name: "display_name", type: "string"},
			{ordinal: 4, name: "location", type: "string", required: false},
			{ordinal: 5, name: "about_me", type: "string", required: false},
			{ordinal: 6, name: "joined_at", type: "timestamp"},
			{ordinal: 7, name: "biography_id", type: "uuid", required: false, ref: "user_biography"},
			{ordinal: 8, name: "comment_count", type: "int64"},
			{ordinal: 9, name: "edit_count", type: "int64"},
			{ordinal: 10, name: "last_edit_at", type: "timestamp", required: false},
			{ordinal: 11, name: "search_key", type: "string"},
			{ordinal: 12, name: "joined_on", type: "string"},
			{ordinal: 13, name: "avatar_key", type: "string", required: false},
		]
	}
	GameChange: {
		id: "0x903a8709bf4643da"
		table:      "game_change"
		durability: "server"
		writers:    "pipeline"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
			{ordinal: 2, name: "game_id", type: "uuid"},
			{ordinal: 3, name: "version", type: "int32", cel: "this > 0"},
			{ordinal: 4, name: "actor_id", type: "uuid", required: false},
			{ordinal: 5, name: "actor_handle", type: "string", required: false},
			{ordinal: 6, name: "game_slug", type: "string", required: false},
			{ordinal: 7, name: "game_day", type: "date", required: false},
			{ordinal: 8, name: "home_name", type: "string"},
			{ordinal: 9, name: "away_name", type: "string"},
			{ordinal: 10, name: "championship_name", type: "string"},
			{ordinal: 11, name: "changes_json", type: "string"},
			{ordinal: 12, name: "created_at", type: "timestamp", default: "now()"},
		]
	}
}
